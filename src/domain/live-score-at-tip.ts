/**
 * Nomes do provider na ordem que mantém ligados aos seus times o placar
 * imutável da entrada e a seleção que fala pela posição dos times.
 */
export function identityEventName(params: {
  providerHome: string;
  providerAway: string;
  swapped: boolean;
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
  /** A seleção depende da ordem do post (placar exato, "Time 1"). */
  selectionFollowsOrder?: boolean;
}): string {
  const preserveOrder = params.selectionFollowsOrder || params.liveScoreHome != null || params.liveScoreAway != null;
  return preserveOrder && params.swapped
    ? `${params.providerAway} vs ${params.providerHome}`
    : `${params.providerHome} vs ${params.providerAway}`;
}

/** Placar observado quando a tip ao vivo foi publicada, na ordem do evento. */
export type LiveScoreAtTip = {
  home: number;
  away: number;
};

export type LiveScoreAtTipResolution =
  | { ok: true; score: LiveScoreAtTip | null }
  | { ok: false; reason: "incomplete_live_score" | "invalid_live_score" | "conflicting_live_score" };

export const MAX_LIVE_SCORE_AT_TIP = 500;
const LIVE_SCORE_LABEL =
  /^(?:entrada|aposta|sele[cç][aã]o|bet|pick|tip)\s*[:–—-]\s*/i;
const LIVE_SCORE_PREFIX =
  /^\(\s*(\d+)\s*([-–—:x×])\s*(\d+)\s*\)/i;
// No sufixo, `x` e ambiguo: `(1x2)` e vocabulario de mercado, nao placar.
// Hifen/colon ficam aceitos somente quando existe uma linha AH numerica antes.
const LIVE_SCORE_HANDICAP_SUFFIX =
  /\(\s*(\d+)\s*([-–—:])\s*(\d+)\s*\)\s*$/i;
// Linha inteira que declara o placar da entrada: "AO VIVO 1x0", "Placar: 1-0".
// Só a linha sozinha conta; "AO VIVO 1x2" é vocabulário de mercado.
const LIVE_SCORE_STATEMENT =
  /^(?:(?:ao\s*vivo|live)\s*[:–—-]?|placar\s*[:–—-]|placar\s+(?:atual|ao\s*vivo|agora)\s*[:–—-]?)\s*(\d+)\s*([-–—:x×])\s*(\d+)\s*$/i;
const EXPLICIT_HANDICAP_LINE = /(?:^|\s)(?:[+-]\s*\d{1,3}(?:[.,]\d+)?|0(?:[.,]0+)?)(?=\s|$)/i;
const DNB_VOCABULARY = /\b(?:dnb|draw\s+no\s+bet|empate\s+(?:anula|devolve)|pick\s*.?\s*em|pk)\b/i;

function withoutLeadingDecoration(value: string): string {
  return value.replace(/^[^\p{L}\p{N}(]+/u, "").trimStart();
}

type ParsedPrefixedLine =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "score"; score: LiveScoreAtTip };

/** Placar não leva zero à esquerda: "(21:00)" e "(19-09)" são horário e data. */
function hasLeadingZero(home: string, away: string): boolean {
  return /^0\d/.test(home) || /^0\d/.test(away);
}

/**
 * Par com forma de horário ou data ("(21:00)", "(20:45)", "(19-09)"), que o
 * tipster põe antes do jogo ou depois da linha. "HH:MM" só é placar na linha
 * que o declara ("AO VIVO 21:30").
 */
function looksLikeClockOrDate(home: string, separator: string, away: string, declared = false): boolean {
  if (hasLeadingZero(home, away)) return true;
  return !declared && separator === ":" && Number(home) <= 23 && /^[0-5]\d$/.test(away);
}

// O traço depois do horário só é separador quando o que vem depois do espaço
// não é número: "(21:00) -4.5" e "(21:00) - 4.5" são o sinal da linha, e sem
// ele o handicap se inverte.
const KICKOFF_PREFIX = /^\(\s*(\d+)\s*[-–—:]\s*(\d+)\s*\)\s*(?:[-–—](?=\s+[^\s\d.,])\s*)?/;
const KICKOFF_SUFFIX = /\s*\(\s*(\d+)\s*[-–—:]\s*(\d+)\s*\)$/;

/**
 * Tira da seleção o horário ou a data entre parênteses no começo ou no fim
 * ("(21:00) Lakers -4.5", "Over 2.5 (19-09)"): são do jogo, e a linha não se
 * lê com eles. Só sai a forma que placar nunca tem; "(20:45)" pode ser o placar
 * de um basquete e fica, para a captura recusar.
 */
export function stripKickoffFromSelection(selection: string): string {
  const trimmed = selection.trim();
  // A decoração só se ignora para achar o prefixo: no sufixo, o começo da
  // seleção pode ser o sinal da linha ("-4.5 (21:00)").
  const undecorated = withoutLeadingDecoration(trimmed);
  const prefix = undecorated.match(KICKOFF_PREFIX);
  if (prefix?.[1] && prefix[2] && hasLeadingZero(prefix[1], prefix[2])) {
    return undecorated.slice(prefix[0].length).trim() || selection;
  }
  const suffix = trimmed.match(KICKOFF_SUFFIX);
  if (suffix?.[1] && suffix[2] && hasLeadingZero(suffix[1], suffix[2])) {
    return trimmed.slice(0, suffix.index).trim() || selection;
  }
  return selection;
}

function parsedScore(
  [, homeText, separator, awayText]: RegExpMatchArray,
  opts: { declared?: boolean } = {},
): ParsedPrefixedLine {
  if (!homeText || !separator || !awayText) return { kind: "none" };
  if (looksLikeClockOrDate(homeText, separator, awayText, opts.declared)) return { kind: "none" };
  const home = Number(homeText);
  const away = Number(awayText);
  if (
    !Number.isInteger(home) ||
    !Number.isInteger(away) ||
    home < 0 ||
    away < 0 ||
    home > MAX_LIVE_SCORE_AT_TIP ||
    away > MAX_LIVE_SCORE_AT_TIP
  ) {
    return { kind: "invalid" };
  }
  return { kind: "score", score: { home, away } };
}

function parseLiveScoreLine(
  line: string,
  opts: { allowHandicapSuffix?: boolean } = {},
): ParsedPrefixedLine {
  let candidate = withoutLeadingDecoration(line.trim());
  candidate = candidate.replace(LIVE_SCORE_LABEL, "");
  candidate = withoutLeadingDecoration(candidate);
  const match = candidate.match(LIVE_SCORE_PREFIX);
  if (match) {
    // Se o texto extraído for uma tag literal de mercado 1x2 / 1×2 / 1_x_2, não extrair como placar ao vivo (T2-R2-BUG-03)
    if (/^\(\s*1\s*(?:[x×]|_?x_?)\s*2\s*\)$/i.test(match[0])) {
      return { kind: "none" };
    }
    // Prefixo exige uma seleção depois do placar. `(1-0)` sozinho pode ser o
    // próprio mercado de placar exato e não prova entrada ao vivo.
    if (!candidate.slice(match[0].length).trim()) return { kind: "none" };
    return parsedScore(match);
  }

  const statement = candidate.match(LIVE_SCORE_STATEMENT);
  if (statement) {
    if (/^[x×]$/i.test(statement[2] ?? "") && statement[1] === "1" && statement[3] === "2") return { kind: "none" };
    return parsedScore(statement, { declared: true });
  }

  if (!opts.allowHandicapSuffix) return { kind: "none" };
  const suffix = candidate.match(LIVE_SCORE_HANDICAP_SUFFIX);
  if (!suffix) return { kind: "none" };
  const financialSelection = candidate.slice(0, suffix.index).trim();
  // O ramo e deliberadamente estreito: `DNB (1-0)` nao prova placar live, e
  // um par solto em legenda narrativa nao pode alterar dinheiro.
  if (
    !financialSelection ||
    DNB_VOCABULARY.test(financialSelection) ||
    !EXPLICIT_HANDICAP_LINE.test(financialSelection)
  ) {
    return { kind: "none" };
  }
  return parsedScore(suffix);
}

function marketAllowsHandicapSuffix(market: string | null | undefined): boolean {
  return /\b(?:handicap|spread)\b/i.test(market ?? "");
}

/**
 * Lê apenas placar entre parênteses no INÍCIO de uma linha/seleção.
 * Assim datas, resultados citados no meio da legenda e números da linha AH não
 * viram placar live por aproximação. Hífens tipográficos, `:` e `x` são as
 * grafias equivalentes aceitas para o separador; horário e data entre
 * parênteses não são placar.
 */
export function extractLiveScoresAtTip(
  text: string | null | undefined,
  opts: { market?: string | null } = {},
): LiveScoreAtTip[] {
  if (!text?.trim()) return [];
  return text
    .split(/\r?\n/)
    .map((line) => parseLiveScoreLine(line, {
      allowHandicapSuffix: marketAllowsHandicapSuffix(opts.market),
    }))
    .filter((parsed): parsed is Extract<ParsedPrefixedLine, { kind: "score" }> =>
      parsed.kind === "score"
    )
    .map((parsed) => parsed.score);
}

function sameScore(a: LiveScoreAtTip, b: LiveScoreAtTip): boolean {
  return a.home === b.home && a.away === b.away;
}

/** Reconcilia campos estruturados, seleção e legenda sem escolher em conflito. */
export function resolveLiveScoreAtTip(params: {
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
  texts?: ReadonlyArray<string | null | undefined>;
  market?: string | null;
  /**
   * Liquidação (SET-002): remainder só com `liveScoreHome`/`liveScoreAway`,
   * que a captura já validou e o banco não deixa reescrever — inclusive 0-0.
   * Sem o par estruturado, um placar só no texto falha fechado — não paga o
   * restante nem o jogo inteiro.
   */
  requireStructured?: boolean;
}): LiveScoreAtTipResolution {
  const structuredHome = params.liveScoreHome;
  const structuredAway = params.liveScoreAway;
  const hasHome = structuredHome !== null && structuredHome !== undefined;
  const hasAway = structuredAway !== null && structuredAway !== undefined;
  if (hasHome !== hasAway) return { ok: false, reason: "incomplete_live_score" };

  const parsedTexts = (params.texts ?? [])
    .filter((text): text is string => Boolean(text?.trim()))
    .flatMap((text) => text.split(/\r?\n/).map((line) => parseLiveScoreLine(line, {
      allowHandicapSuffix: marketAllowsHandicapSuffix(params.market),
    })));
  if (parsedTexts.some((parsed) => parsed.kind === "invalid")) {
    return { ok: false, reason: "invalid_live_score" };
  }
  const candidates = parsedTexts
    .filter((parsed): parsed is Extract<ParsedPrefixedLine, { kind: "score" }> =>
      parsed.kind === "score"
    )
    .map((parsed) => parsed.score);

  let structuredScore: LiveScoreAtTip | null = null;
  if (
    structuredHome !== null &&
    structuredHome !== undefined &&
    structuredAway !== null &&
    structuredAway !== undefined
  ) {
    const home = structuredHome;
    const away = structuredAway;
    if (
      !Number.isInteger(home) ||
      !Number.isInteger(away) ||
      home < 0 ||
      away < 0 ||
      home > MAX_LIVE_SCORE_AT_TIP ||
      away > MAX_LIVE_SCORE_AT_TIP
    ) {
      return { ok: false, reason: "invalid_live_score" };
    }

    // Na captura, 0-0 sem evidência textual explícita é ruído de parser pré-jogo.
    // O par gravado já passou por este filtro; a legenda que o confirmou expira.
    const hasExplicitTextScore = parsedTexts.some((p) => p.kind === "score" && p.score.home === 0 && p.score.away === 0);
    const hasLiveIndicator = (params.texts ?? []).some((t) => /\b(ao\s*vivo|live|in-play)\b/i.test(t ?? ""));
    const isBogusZeroZero = !params.requireStructured
      && home === 0 && away === 0 && !hasExplicitTextScore && !hasLiveIndicator;

    if (!isBogusZeroZero) {
      structuredScore = { home, away };
      candidates.unshift(structuredScore);
    }
  }

  if (params.requireStructured) {
    if (!structuredScore) {
      const firstCandidate = candidates[0];
      if (!firstCandidate) return { ok: true, score: null };
      if (candidates.some((candidate) => !sameScore(candidate, firstCandidate))) {
        return { ok: false, reason: "conflicting_live_score" };
      }
      return { ok: false, reason: "incomplete_live_score" };
    }
  }

  const score = candidates[0] ?? null;
  if (score && candidates.some((candidate) => !sameScore(candidate, score))) {
    return { ok: false, reason: "conflicting_live_score" };
  }
  return { ok: true, score };
}

/** O par gravado na aposta, como a liquidação o usa. */
export function persistedLiveScoreAtTipText(bet: {
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
}): string | null {
  return bet.liveScoreHome != null && bet.liveScoreAway != null
    ? `${bet.liveScoreHome}-${bet.liveScoreAway}`
    : null;
}

const LIVE_ENTRY_TEXT = /\b(?:live|ao\s+vivo|in[ -]play|restante|remaining)\b/i;

/** Texto que declara entrada com a bola rolando, mesmo sem trazer o placar. */
export function mentionsLiveEntry(text: string | null | undefined): boolean {
  return LIVE_ENTRY_TEXT.test(text ?? "");
}

/** Linha de divulgação ("Acompanhe nossa live", link do canal): não descreve a entrada. */
const PROMO_LINE = /(?:acompanh|assist[ae]|siga|inscrev|canal|youtube|twitch|instagram|grupo|https?:\/\/|t\.me)/i;
const ENTRY_LABEL = /^\W*(?:entrada|aposta|sele[cç][aã]o|bet|pick|tip)\s*[:–—-]/i;
const BET_NUMBERS = /@\s*\d|\bodds?\b|\d\s*(?:u|un|unidades?)\b/i;

/**
 * A legenda declara entrada ao vivo PERTO da aposta: na seleção, ou nas linhas
 * até a da entrada (e a seguinte, se for a da odd ou stake). Rodapé de divulgação
 * ("📺 Acompanhe nossa live") vem depois e não torna a tip pré-jogo ao vivo.
 * Sem linha de entrada reconhecível, vale até a primeira linha com odd ou stake.
 */
export function mentionsLiveEntryNearBet(caption: string | null | undefined, selecao: string | null | undefined): boolean {
  if (mentionsLiveEntry(selecao)) return true;
  const lines = (caption ?? "").split(/\r?\n/);
  const selection = (selecao ?? "").trim().toLowerCase();
  let anchor = -1;
  lines.forEach((line, index) => {
    if (ENTRY_LABEL.test(line) || (selection.length >= 3 && line.toLowerCase().includes(selection))) anchor = index;
  });
  if (anchor < 0) anchor = lines.findIndex((line) => BET_NUMBERS.test(line));
  // A linha seguinte só conta quando é a da odd ou da stake da mesma entrada.
  const last = anchor < 0 ? lines.length - 1 : anchor + (BET_NUMBERS.test(lines[anchor + 1] ?? "") ? 1 : 0);
  return lines.slice(0, last + 1).some((line) => !PROMO_LINE.test(line) && mentionsLiveEntry(line));
}

/** Remove somente o prefixo reconhecido; o fato fica nos campos estruturados. */
export function stripLiveScoreAtTipPrefix(selection: string): string {
  let candidate = withoutLeadingDecoration(selection.trim());
  const parsed = parseLiveScoreLine(candidate);
  if (parsed.kind !== "score") return selection;
  const match = candidate.match(LIVE_SCORE_PREFIX);
  if (!match) return selection;
  candidate = candidate.slice(match[0].length).trim();
  return candidate || selection;
}

/** Remove prefixo ou sufixo AH que ja foi promovido aos campos estruturados. */
export function stripLiveScoreAtTip(selection: string, market?: string | null): string {
  const withoutPrefix = stripLiveScoreAtTipPrefix(selection);
  if (withoutPrefix !== selection) return withoutPrefix;
  if (!marketAllowsHandicapSuffix(market)) return selection;
  const parsed = parseLiveScoreLine(selection, { allowHandicapSuffix: true });
  if (parsed.kind !== "score") return selection;
  const suffix = selection.match(LIVE_SCORE_HANDICAP_SUFFIX);
  if (!suffix) return selection;
  const financialSelection = selection.slice(0, suffix.index).trim();
  return financialSelection || selection;
}
