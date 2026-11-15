import { normalizeStr, splitEventoTeams, TEAM_STOP_WORDS } from "@/src/domain/text";

const TRUSTED_HOST_SUFFIXES = [
  "atptour.com",
  "bbc.com",
  "cafonline.com",
  "cbf.com.br",
  "concacaf.com",
  "conmebol.com",
  "dotabuff.com",
  "espn.com",
  "espn.com.br",
  "fbref.com",
  "fiba.basketball",
  "fifa.com",
  "flashscore.com",
  "fotmob.com",
  "ge.globo.com",
  "globoesporte.globo.com",
  "gol.gg",
  "gosugamers.net",
  "hltv.org",
  "itftennis.com",
  "liquipedia.net",
  // Livesport, dona do FlashScore: aparece nas citações do Gemini com o mesmo placar.
  "livesport.cz",
  "livescore.com",
  "lolesports.com",
  "mlb.com",
  "nba.com",
  "nfl.com",
  "nhl.com",
  "ogol.com.br",
  "soccerway.com",
  "sofascore.com",
  "the-afc.com",
  "transfermarkt.com",
  "uefa.com",
  "vlr.gg",
  "volleyballworld.com",
  "whoscored.com",
  "wnba.com",
  "worldfootball.net",
  "wtatennis.com",
  "zerozero.pt",
] as const;

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/** Sufixo da lista que o host satisfaz; é a "fonte" para comparar citação e afirmação. */
function trustedSuffixOf(hostname: string): string | null {
  const host = normalizeHost(hostname);
  return TRUSTED_HOST_SUFFIXES.find((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ?? null;
}

function trustedHost(hostname: string): boolean {
  return trustedSuffixOf(hostname) !== null;
}

/** Link sugerido por LLM e input hostil: apenas HTTPS em fonte esportiva conhecida. */
export function sanitizeTrustedSportsSourceUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || (url.port && url.port !== "443")
      || !trustedHost(url.hostname)
    ) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export type GroundingSource = {
  url: string;
  title?: string;
};

export type VerifiedSportsGrounding = {
  /** Citações HTTPS devolvidas pelo provider, preservadas para auditoria. */
  citations: GroundingSource[];
  /** Fonte afirmada pelo modelo, já vinculada às citações; null falha fechado. */
  sourceUrl: string | null;
  /** Domínio confiável dessa citação ("sofascore.com"), para o operador ler. */
  sourceDomain: string | null;
};

/** Trecho da resposta grounded e as citações que o sustentam (`groundingSupports`). */
export type GroundingSupport = { text: string; sources: GroundingSource[] };

const MAX_GROUNDING_TITLE_LENGTH = 200;

/**
 * O Gemini não devolve a URL da página: cada citação vem como um
 * redirecionamento do Google, e o domínio real vem no `title`, que o próprio
 * Google preenche (em produção: "sofascore.com", "livesport.cz"). O `title`
 * só vale como domínio nesse formato; em qualquer outra URL ele é texto livre
 * da página.
 */
const GOOGLE_GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const GOOGLE_GROUNDING_REDIRECT_PATH = "/grounding-api-redirect/";
const BARE_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function isGoogleGroundingRedirect(url: URL): boolean {
  return normalizeHost(url.hostname) === GOOGLE_GROUNDING_REDIRECT_HOST &&
    url.pathname.startsWith(GOOGLE_GROUNDING_REDIRECT_PATH);
}

function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || (url.port && url.port !== "443")
    ) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function normalizeGroundingCitation(source: GroundingSource): GroundingSource | null {
  const url = httpsUrl(source.url);
  if (!url) return null;
  const title = source.title?.trim().slice(0, MAX_GROUNDING_TITLE_LENGTH);
  return title ? { url: url.toString(), title } : { url: url.toString() };
}

/** Domínio que a citação atesta: o host da URL direta ou, no redirecionamento do Google, o `title`. */
function citationDomain(citation: GroundingSource): string | null {
  const url = httpsUrl(citation.url);
  if (!url) return null;
  if (!isGoogleGroundingRedirect(url)) return normalizeHost(url.hostname);
  const title = citation.title?.trim().toLowerCase().replace(/^www\./, "") ?? "";
  return BARE_HOSTNAME.test(title) ? title : null;
}

/** Citações HTTPS, normalizadas e sem repetição, na ordem em que vieram. */
export function normalizeGroundingCitations(sources: readonly GroundingSource[]): GroundingSource[] {
  const citations: GroundingSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const citation = normalizeGroundingCitation(source);
    if (!citation || seen.has(citation.url)) continue;
    seen.add(citation.url);
    citations.push(citation);
  }
  return citations;
}

function sameSite(a: string, b: string): boolean {
  const x = a.replace(/^www\./, "");
  const y = b.replace(/^www\./, "");
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

export type CitationMatch = {
  /** A URL que fica como fonte: a citação afirmada, ou a página afirmada do domínio citado. */
  url: string;
  /** Domínio atestado pela citação ("sofascore.com"). */
  domain: string;
};

/**
 * Vincula a fonte AFIRMADA pelo modelo a uma citação real da busca grounded.
 *
 * A afirmação é input hostil e vale nos dois formatos que o modelo recebe: a
 * própria URL citada (inclusive o redirecionamento do Google), ou a URL de uma
 * página cujo domínio aparece entre as citações. Com `trustedOnly`, só vale
 * domínio da lista de fontes esportivas confiáveis.
 */
export function matchClaimToCitation(
  claimedSourceUrl: unknown,
  citations: readonly GroundingSource[],
  options: { trustedOnly: boolean },
): CitationMatch | null {
  const candidates = citations.flatMap((citation) => {
    const domain = citationDomain(citation);
    if (!domain || (options.trustedOnly && !trustedHost(domain))) return [];
    return [{ citation, domain }];
  });
  const claimedUrl = typeof claimedSourceUrl === "string" ? httpsUrl(claimedSourceUrl) : null;
  if (!claimedUrl) return null;
  const claimed = claimedUrl.toString();

  const cited = candidates.find((item) => item.citation.url === claimed);
  if (cited) return { url: cited.citation.url, domain: cited.domain };

  if (isGoogleGroundingRedirect(claimedUrl)) return null;
  const claimedHost = normalizeHost(claimedUrl.hostname);
  if (options.trustedOnly) {
    const claimedSuffix = trustedSuffixOf(claimedHost);
    const sameSource = claimedSuffix
      ? candidates.find((item) => trustedSuffixOf(item.domain) === claimedSuffix)
      : undefined;
    // A página afirmada é a que o operador consegue abrir; o domínio dela está
    // entre as citações, e é isso que a torna verificada.
    const page = sameSource ? sanitizeTrustedSportsSourceUrl(claimed) : "";
    return sameSource && page ? { url: page, domain: sameSource.domain } : null;
  }
  const sameSource = candidates.find((item) => sameSite(claimedHost, item.domain));
  return sameSource ? { url: claimed, domain: sameSource.domain } : null;
}

/**
 * Fonte que autoriza o IA-Judge a liquidar: a afirmada, entre as citações, em
 * domínio confiável. Afirmação fora das citações não é substituída por outra
 * citação: "fonte citada" é a fonte em que o modelo diz ter se baseado.
 */
export function verifySportsGrounding(
  claimedSourceUrl: unknown,
  sources: readonly GroundingSource[],
): VerifiedSportsGrounding {
  const citations = normalizeGroundingCitations(sources);
  const match = matchClaimToCitation(claimedSourceUrl, citations, { trustedOnly: true });
  return { citations, sourceUrl: match?.url ?? null, sourceDomain: match?.domain ?? null };
}

/** Link e domínio para a conferência no painel, usando as citações quando gravadas. */
export function sportsSourceForDisplay(claimedSourceUrl: unknown, sources: unknown): CitationMatch | null {
  if (sources != null) {
    if (!Array.isArray(sources)) return null;
    const citations: GroundingSource[] = sources.flatMap((source: unknown) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return [];
      const item = source as Record<string, unknown>;
      if (typeof item.url !== "string" || (item.title != null && typeof item.title !== "string")) return [];
      return [{ url: item.url, ...(typeof item.title === "string" ? { title: item.title } : {}) }];
    });
    const verified = verifySportsGrounding(claimedSourceUrl, citations);
    return verified.sourceUrl && verified.sourceDomain
      ? { url: verified.sourceUrl, domain: verified.sourceDomain.replace(/^www\./, "") }
      : null;
  }
  // Sem citações, só a URL direta de um domínio permitido pode ser exibida.
  const url = sanitizeTrustedSportsSourceUrl(claimedSourceUrl);
  return url ? { url, domain: new URL(url).hostname.replace(/^www\./, "") } : null;
}

/** A URL é o redirecionamento de grounding do Google (o único que merece um HEAD). */
export function isGoogleGroundingRedirectUrl(value: string): boolean {
  const url = httpsUrl(value);
  return url !== null && isGoogleGroundingRedirect(url);
}

/** Os dois hosts caem no mesmo domínio da lista confiável. */
export function sameTrustedSource(host: string, domain: string): boolean {
  const suffix = trustedSuffixOf(domain);
  return suffix !== null && trustedSuffixOf(host) === suffix;
}


/** Ordinais ("1º quarto", "2nd half") não são resultado. */
function withoutOrdinals(text: string): string {
  return text.replace(/\b\d+\s*(?:[ºª°]|(?:st|nd|rd|th)\b)/gi, " ");
}

/**
 * Placar escrito no texto: "2-1", "2 x 1", "2:1", "2 a 1", "2 to 1". Data e
 * hora com o mesmo separador ficam de fora pelo número vizinho ("12-10-2026").
 */
const SCORE_PAIR = /(?<!\d|\d[.,:/-])(\d{1,3})(?:\s*[-–—x×:]\s*|\s+(?:a|to)\s+)(\d{1,3})(?!\d|[.,:/-]\d)/gi;

/** Placares do texto, na ordem em que aparecem. */
function scorePairs(text: string): string[] {
  return [...withoutOrdinals(text).matchAll(SCORE_PAIR)].map((match) => `${Number(match[1])}-${Number(match[2])}`);
}

const PERIOD_WORD = "tempo|half|parte|etapa|metade|quarto|quarter|periodo|period|set|mapa|map|inning|entrada";
const ORDINAL_WORD =
  "primeiro|primeira|first|segundo|segunda|second|terceiro|terceira|third|quarto|quarta|fourth|quinto|quinta|fifth";
/**
 * Uma parte do jogo com o número dela ("1º tempo", "third quarter", "mapa 2").
 * O número é o que separa o período da unidade do placar: "2 sets a 0" não é
 * o 2º set.
 */
const NUMBERED_PERIOD = new RegExp(
  String.raw`\b(?:[1-9](?:\s?[ºª°]|o|a|st|nd|rd|th)\s*(?:${PERIOD_WORD})|(?:${ORDINAL_WORD})\s+(?:${PERIOD_WORD})|(?:${PERIOD_WORD})\s+[1-9])s?\b`,
);
/** A parte do jogo sem número: as siglas, o intervalo e o vestiário, a etapa inicial e a complementar, os três quartos. */
const UNNUMBERED_PART = new RegExp(
  String.raw`\b(?:[12][ºª°]?t|q[1-4]|h[12]|ht|intervalo|half\s?time|meio tempo|interval|break|at (?:the )?half|vestiario|(?:dressing|locker) rooms?|etapa (?:inicial|complementar|final)|(?:two|three|dois|tres|[23]) (?:quarters|quartos|periods|periodos)|(?:opening|closing|final|last|deciding) (?:half|quarter|period|set|frame|inning)|(?:first|primeiros) 45|in the (?:first|second|third|fourth)\b(?! (?:round|leg|game|match|place|meeting|minutes?|semi|semifinal|ever|division|week|edition|qualifying|clash|time)))\b`,
);

/** O texto fala de uma parte do jogo; "first-half" e "half-time" valem como "first half" e "half time". */
function mentionsGamePart(text: string): boolean {
  const key = normalizeStr(text).replace(SCORE_PAIR, " ").replace(/(?<=[a-z])-(?=[a-z])/g, " ");
  return NUMBERED_PERIOD.test(key) || UNNUMBERED_PART.test(key);
}

/**
 * Marca do jogo inteiro. "Final" sozinho é também a fase da competição
 * ("quartas de final", "final da Copa"), então só vale na frase feita; e o
 * final de uma parte ("placar final do 1º tempo", "final score of the first
 * half") não conta.
 */
const FULL_GAME_WORDS = new RegExp(
  String.raw`\b(?:(?:(?:placar|resultado|apito) final|final (?:score|result|whistle))(?!(?:\s+[a-z]+){0,2}\s+(?:d[oa]s?|of)\s+(?:the\s+)?${NUMBERED_PERIOD.source})|(?:fim|final) d[eoa] (?:jogo|partida)|end of the (?:game|match)|full[\s-]?time|ft|tempo regulamentar|tempo normal|regulation|jogo inteiro|partida inteira)\b`,
);

function coversFullGame(text: string): boolean {
  return FULL_GAME_WORDS.test(normalizeStr(text));
}

/** A frase fala de uma parte sem placar próprio nem o jogo inteiro: a seguinte pode ser o placar dessa parte. */
function framesPartScore(sentence: string): boolean {
  return mentionsGamePart(sentence) && !coversFullGame(sentence) && scorePairs(sentence).length === 0;
}

/**
 * O trecho prova o placar final quando traz um placar só e nenhuma parte do
 * jogo. Dois placares ("FT 2-1 (HT 1-0)", "2:1 (1:0)", o de outro jogo da
 * rodada) não dizem qual é o desta aposta; o trecho que cita uma parte ("At
 * the break, 1-0", "placar final do 1T: 1-0") pode trazer o placar dela. A
 * frase anterior sem placar que fala de uma parte ("foram para o intervalo
 * depois de um primeiro tempo movimentado." e "Terminou 1-0.") também faz do
 * placar o dessa parte, a menos que o trecho diga que é o do jogo inteiro.
 */
function provesFinalScore(text: string, previous: string): boolean {
  if (new Set(scorePairs(text)).size !== 1 || mentionsGamePart(text)) return false;
  return coversFullGame(text) || !framesPartScore(previous);
}

function significantWords(name: string): string[] {
  const words = normalizeStr(name).split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !/^\d+$/.test(word));
  const distinctive = words.filter((word) => word.length > 2 && !TEAM_STOP_WORDS.has(word));
  return distinctive.length > 0 ? distinctive : words;
}

/**
 * Os dois lados do confronto, cada um por pelo menos uma palavra. É
 * conferência de palavras, sem alias: nome traduzido ou abreviado fica para o
 * dono.
 */
function eventSides(evento: string): string[][] | null {
  const teams = splitEventoTeams(evento);
  return teams ? [significantWords(teams.home), significantWords(teams.away)] : null;
}

/** O Gemini divide o resumo por frase ("X recebeu Y." e "Terminou 2-2."): vale também a anterior. */
function namesSides(sides: readonly string[][] | null, text: string, previous: string): boolean {
  if (sides === null) return false;
  const words = new Set(normalizeStr(`${previous} ${text}`).split(/[^a-z0-9]+/));
  return sides.every((group) => group.some((word) => words.has(word)));
}

/**
 * De quem é o primeiro número do placar no trecho, quando ele está na forma de
 * placar ("Flamengo 2-1 Palmeiras"): a palavra colada antes é de um lado e a
 * colada depois é do outro. Frase corrida ("perdeu por 2-1 para o Palmeiras")
 * não diz a ordem, e fica `null`.
 */
function firstScoredSide(text: string, score: string, evento: string): "home" | "away" | null {
  const teams = splitEventoTeams(evento);
  if (!teams) return null;
  const words = (value: string) => normalizeStr(value).split(/[^a-z0-9]+/).filter(Boolean);
  const [home, away] = [new Set(words(teams.home)), new Set(words(teams.away))];
  const only = (word: string | undefined, side: Set<string>, other: Set<string>) =>
    word !== undefined && side.has(word) && !other.has(word);
  const source = withoutOrdinals(text);
  const orders = new Set<"home" | "away" | null>();
  for (const match of source.matchAll(SCORE_PAIR)) {
    if (`${Number(match[1])}-${Number(match[2])}` !== score) continue;
    const before = words(source.slice(0, match.index)).at(-1);
    const after = words(source.slice(match.index + match[0].length))[0];
    orders.add(only(before, home, away) && only(after, away, home) ? "home"
      : only(before, away, home) && only(after, home, away) ? "away"
        : null);
  }
  const [order, ...others] = orders;
  return order !== undefined && others.length === 0 ? order : null;
}

function trustedCitation(support: GroundingSupport, domain: string): GroundingSource | null {
  for (const source of support.sources) {
    const citation = normalizeGroundingCitation(source);
    const citedDomain = citation ? citationDomain(citation) : null;
    if (citation && citedDomain !== null && sameTrustedSource(citedDomain, domain)) return citation;
  }
  return null;
}

/** Na ordem das conferências: a recusa relatada é a do trecho que foi mais longe. */
const SUPPORT_REFUSALS = ["result_not_supported", "period_not_supported", "event_not_supported"] as const;
export type SupportRefusal = (typeof SUPPORT_REFUSALS)[number];

/**
 * A citação que sustenta o placar final do jogo inteiro, o único resultado que
 * o IA-Judge liquida sozinho. O MESMO trecho do `groundingSupports`, amarrado a
 * uma citação do domínio confiável, traz:
 * - o placar do resultado NA ORDEM ("venceu por 2 a 1" não prova "1-2"), e
 *   nenhum outro placar;
 * - nenhuma parte do jogo, nem na frase anterior sem placar (`provesFinalScore`);
 * - os dois lados do confronto, no trecho ou no anterior, este só com citação
 *   do mesmo domínio.
 * O anterior é o item de antes no `groundingSupports`, que só traz frases com
 * citação: uma frase sem citação no meio fica de fora. Faltando qualquer um,
 * não há prova: fica sugestão. Não pega o mesmo confronto em outra data, nem o
 * placar de outro jogo num trecho cuja frase anterior nomeia a partida.
 *
 * Devolve também o placar provado, na ordem do trecho, e de que lado do evento
 * é o primeiro número (`firstSide`), quando o trecho o diz.
 */
export function citationSupportingResult(params: {
  valueFound: string;
  supports: readonly GroundingSupport[];
  domain: string;
  evento: string;
}): { citation: GroundingSource; score: { first: number; second: number }; firstSide: "home" | "away" | null }
  | { refusal: SupportRefusal } {
  const [score, ...otherScores] = new Set(scorePairs(params.valueFound));
  if (score === undefined || otherScores.length > 0) return { refusal: "result_not_supported" };
  const sides = eventSides(params.evento);
  let refusal: SupportRefusal = "result_not_supported";
  for (const [index, support] of params.supports.entries()) {
    const citation = scorePairs(support.text).includes(score) ? trustedCitation(support, params.domain) : null;
    if (!citation) continue;
    const before = params.supports[index - 1];
    // Para recusar a parte do jogo vale a frase de qualquer fonte: ela muda a
    // leitura do trecho. Para nomear a partida, só a do mesmo domínio prova.
    const previous = before?.text ?? "";
    const provenPrevious = before && trustedCitation(before, params.domain) ? before.text : "";
    const failed: SupportRefusal | null = !provesFinalScore(support.text, previous) ? "period_not_supported"
      : !namesSides(sides, support.text, provenPrevious) ? "event_not_supported"
        : null;
    if (failed === null) {
      const [first, second] = score.split("-").map(Number);
      return {
        citation,
        score: { first: first!, second: second! },
        firstSide: firstScoredSide(support.text, score, params.evento),
      };
    }
    if (SUPPORT_REFUSALS.indexOf(failed) > SUPPORT_REFUSALS.indexOf(refusal)) refusal = failed;
  }
  return { refusal };
}
