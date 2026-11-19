import {
  MAX_ODDS,
  MAX_STAKE_UNIDADES,
  type ParsedBetPost,
} from "@/src/domain/bet-capture";
import { parseBrKickoffDetailed, RATING_BEFORE, spDayKey } from "@/src/domain/dates";
import { parseDecimalInput } from "@/src/domain/decimal-input";
import { resolveCaptureStake, type CaptureStakeSettings } from "./capture-stake-policy";
import { parseBetLegs } from "@/src/domain/bet-legs";
import { stripDrawNoBetFromSelection, stripDoubleChanceFromSelection } from "@/src/domain/mercados/draw-vocabulary";
import {
  isEsportsPlayerSelection,
  declaresEuropeanHandicap,
  selecaoNomeiaTimeDoTotal,
  selecaoPareceHandicap,
  stripSelectionOdds,
} from "@/src/domain/mercados/selection-shape";
import { looksLikeTotalSelection } from "@/src/domain/mercados/total-direction";
import { matchDoubleChanceSelection, matchMoneylineSelection, matchTeamSide } from "@/src/domain/settlement/sides";
import { inferPinnacleStatMarket } from "@/src/domain/mercados/stat-unit";
import { isCombinedSelection } from "@/src/domain/mercados/selecao";
import { marketPeriodOf } from "@/src/domain/mercados/classify";
import { detectSportFromText, UNKNOWN_SPORT } from "@/src/domain/sports/detect";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";

/**
 * Parser universal de posts de tipster: cobre os formatos comuns (linhas
 * rotuladas + heurísticas posicionais); o que ele não resolver cai na cascata
 * LLM genérica. Parser dedicado em código é exceção justificada por
 * evidência, não regra.
 */

type UniversalParseResult =
  | { ok: true; bet: ParsedBetPost }
  | { ok: false; missing: string[] };

const LABELS = {
  evento: /^(?:jogo|partida|evento|match|game)\s*[:\-]\s*(.+)$/i,
  competicao: /^(?:liga|campeonato|competi[cç][aã]o|league|torneio)\s*[:\-]\s*(.+)$/i,
  mercado: /^(?:mercado|market|tipo)\s*[:\-]\s*(.+)$/i,
  selecao: /^(?:entrada|aposta|sele[cç][aã]o|bet|pick|tip)\s*[:\-]\s*(.+)$/i,
  odds: /^(?:odd?s?|cota[cç][aã]o|@)\s*[:\-]?\s*(\d[\d.,]*)\s*$/i,
  // "Valor" é dinheiro do bilhete, não unidade. Percentual do tipster é
  // unidade (1% = 1u), a mesma regra que a leitura por IA segue.
  stake: /^(?:stake|unidade?s?)\s*[:\-]?\s*(\d[\d.,]*)\s*(?:u|%)?\s*$/i,
  data: /^(?:data|dia|date)\s*[:\-]\s*(.+)$/i,
  hora: /^(?:hor[aá]rio|hora|kick\s*-?\s*off)\s*[:\-]\s*(.+)$/i,
  casa: /^(?:casa|bookie|bookmaker|site)\s*[:\-]\s*(.+)$/i,
} as const;

function cleanLine(line: string): string {
  // Remove emojis/ornamentos das bordas mantendo o conteúdo.
  return line
    .replace(/^[^\p{L}\p{N}@+(]+/u, "")
    .replace(/[^\p{L}\p{N})%.,u]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Linha "Time A vs Time B" em qualquer posição do post. */
function findEventoLine(lines: string[]): string | null {
  // Explicit confrontation separators outrank punctuation in group/league
  // headings across the entire post, not just within a single line.
  const eligible = lines.filter((line) => !/https?:\/\//i.test(line));
  const strong = (line: string) => /\s+(?:vs\.?|versus|x|v\.?)\s+/i.test(line);
  const ordered = [...eligible.filter(strong), ...eligible.filter((line) => !strong(line))];
  for (const line of ordered) {
    const cleaned = cleanLine(line);
    // Evita confundir placar/handicap com confronto ("2 x 1").
    if (/^\d+\s*x\s*\d+$/i.test(cleaned)) continue;
    const teams = splitEventoTeams(cleaned);
    if (teams && /\p{L}/u.test(teams.home) && /\p{L}/u.test(teams.away)) {
      return `${teams.home} vs ${teams.away}`;
    }
  }
  return null;
}

/**
 * Texto logo antes de um número que faz dele um limite do tipster ("Min
 * @1.70", "máx 3u", "até 2u"): o piso ou teto aceito, não a odd ou a stake.
 */
export const LIMIT_BEFORE = /(?:\bmin(?:imum|ima|imo)?|\bm[ií]n(?:ima|imo)?|\bm[aá]x(?:ima|imo|imum)?|\bat[eé])\s*[.\s:\-–—=]*$/i;

/** Odd inline: "@2.10", "odd 2.10", "💰 2.10". Plausível: (1, MAX_ODDS] (sanity.ts). */
function findInlineOdds(text: string): number | null {
  const at = [...text.matchAll(/@\s*(\d[\d.,]*)(?![a-z0-9_]|[.,]\d)/gi)]
    .find((match) => !LIMIT_BEFORE.test(text.slice(0, match.index ?? 0)));
  if (at?.[1]) {
    const v = parseDecimalInput(at[1]);
    if (v !== null && v > 1 && v <= MAX_ODDS) return v;
  }
  const labeled = text.match(/\bodd?s?\s*[:\-]?\s*(\d[\d.,]*)/i);
  if (labeled?.[1]) {
    const v = parseDecimalInput(labeled[1]);
    if (v !== null && v > 1 && v <= MAX_ODDS) return v;
  }
  return null;
}

/**
 * Unidades que vêm DEPOIS de meta, lucro, ontem ou "nunca passe de" ("Meta da
 * semana: 15u", "Stake: 1u → Lucro: 0.85u") ou ANTES de "de lucro" ("23.5u de
 * lucro") falam da banca ou do resultado, não da stake desta aposta. "Gestão"
 * e "banca" soltos ficam de fora: "Gestão: 1u" é a stake. Depois do número só
 * conta com "de": em "Stake 1u retorno 1.90u" e "Pedro 1u green" o 1u é a stake.
 */
const STAKE_CONTEXT_BEFORE =
  /\b(?:metas?|lucro|lucramos|ontem|nunca\s+passe\s+de|n[aã]o\s+passe\s+de)\b/i;
/**
 * Retorno, ganho e "banca de" só contam como rótulo logo antes do número
 * ("Retorno: 1.90u", "Possível ganho 0.9u", "Ganho potencial de 0.9u", "banca
 * de 100u"). Soltos no trecho, falam de outra coisa, e a stake é a escrita:
 * "Se possível pegar acima de 1.85 - 2u", "Potencial de green alto, 2u".
 */
const RESULT_LABEL_BEFORE =
  /(?<!\p{L})(?:(?:retornos?|ganhos?)(?:\s+(?:poss[ií]vel|potencial|esperad[oa]|previst[oa]|estimad[oa]|total|l[ií]quido|bruto))?(?:\s+de)?|banca\s+de)[\s:=\-–—(~]*$/iu;
const STAKE_CONTEXT_AFTER = /^\s*(?:de\s+(?:lucro|retorno|ganhos?|b[oô]nus|cashback)|(?:em|de)\s+(?:free\s*bets?|apostas?\s+gr[aá]tis))\b/i;
/** Crédito/oferta anunciado em unidades não é a stake apostada. */
const PROMOTION_LABEL_BEFORE = /\b(?:b[oô]nus(?:\s+de\s+cadastro)?|cashback|free\s*bets?)(?:\s+de)?[\s:=\-–—]*$/i;
const CASHOUT_LABEL_BEFORE = /\bcash[ -]*out(?:\s+(?:dispon[ií]vel|oferecido|total|parcial|lucro|retorno|de))*[\s:=\-–—]*$/i;
const LINE_SEGMENT_SEPARATOR = /[|;•]|\s\/\s/g;

/** O sufixo de unidades depois do número: "1u", "2 un", "1 unid.", "2 units", "0,5 unidade". */
export const UNIT_SUFFIX = String.raw`(?:u|un|unid|units?|unidades?)\b`;
export const STAKE_UNITS_PATTERN = new RegExp(String.raw`(^|[^\d.,])([+-]?)(\d[\d.,]*)\s*${UNIT_SUFFIX}`, "gi");

const VULGAR_FRACTIONS: Readonly<Record<string, string>> = { "½": ".5", "¼": ".25", "¾": ".75" };

/** "½u" e "1½u" viram "0.5u" e "1.5u" antes de a stake ser lida. */
export function expandVulgarFractions(text: string): string {
  return text.replace(/(?:(\d+) ?)?([½¼¾])/g, (_, whole: string | undefined, fraction: string) => `${whole ?? "0"}${VULGAR_FRACTIONS[fraction]}`);
}

/** A maior parte em que uma unidade é dividida ("1/8u"); "3/10u" é escala, não fração. */
const MAX_STAKE_FRACTION_PARTS = 8;
const FRACTION_BEFORE_UNITS = /(?<![\d.,/])([+-]?)(\d)\s*\/\s*$/;
/** Intervalo colado ("1-2u") ou por extenso ("1 a 2u", "1 ou 2u"); a odd antes do hífen ("@1.90-1u") não é o começo dele. */
const RANGE_BEFORE_UNITS = new RegExp(String.raw`(?<![@\d.,])(\d+(?:[.,]\d+)?)\s*(?:${UNIT_SUFFIX})?(?:[-–]|\s+(?:a|ou|at[eé])\s+)$`, "i");

/** O contexto de "1/2u" começa antes do numerador, não entre o / e o 2. */
export function stakeUnitsTokenStart(line: string, numberStart: number): number {
  return line.slice(0, numberStart).match(FRACTION_BEFORE_UNITS)?.index ?? numberStart;
}

/**
 * As unidades de "<before><units>u", lendo o que vem colado antes do número.
 * Fração ("1/2u", "3/4u") vale a fração. Intervalo crescente ("1-2u", "1 a
 * 2u") não diz a stake: NaN, a stake escrita e inválida, para o dono informar.
 */
export function unitsWithFractionOrRange(before: string, units: number): number {
  const fraction = before.match(FRACTION_BEFORE_UNITS);
  if (fraction?.[1]) return Number.NaN;
  const numerator = fraction?.[2];
  if (numerator !== undefined) {
    return Number.isInteger(units) && Number(numerator) < units && units <= MAX_STAKE_FRACTION_PARTS ? Number(numerator) / units : Number.NaN;
  }
  const rangeStart = parseDecimalInput(before.match(RANGE_BEFORE_UNITS)?.[1] ?? "");
  return rangeStart !== null && rangeStart < units ? Number.NaN : units;
}

/**
 * O texto da linha que dá contexto às unidades que começam em `start`. Ele só
 * para num separador (`|`, `;`, `•`, ` / `) que vem depois de outras unidades:
 * em "Retorno 1.9u | Stake 1u" o retorno é do 1.9u, e em "Meta da semana •
 * 15u" o separador está entre a meta e o próprio número dela.
 */
function unitsContextBefore(line: string, start: number): string {
  const before = line.slice(0, start);
  const previousUnits = [...before.matchAll(STAKE_UNITS_PATTERN)].at(-1);
  if (!previousUnits) return before;
  const afterPrevious = before.slice((previousUnits.index ?? 0) + previousUnits[0].length);
  const separator = [...afterPrevious.matchAll(LINE_SEGMENT_SEPARATOR)].at(-1);
  return separator ? afterPrevious.slice((separator.index ?? 0) + separator[0].length) : before;
}

/** As unidades em `line[start, end)` falam da banca ou do resultado, não da stake. */
export function isBankrollOrResultUnits(line: string, start: number, end: number): boolean {
  const before = unitsContextBefore(line, start);
  return STAKE_CONTEXT_BEFORE.test(before) || RESULT_LABEL_BEFORE.test(before) || PROMOTION_LABEL_BEFORE.test(before) || CASHOUT_LABEL_BEFORE.test(before) || STAKE_CONTEXT_AFTER.test(line.slice(end));
}

/** A maior stake sem rótulo que o número solto depois da odd pode ser. */
const MAX_BARE_STAKE_UNITS = 10;
const SIGNED_UNITS_LINE = new RegExp(String.raw`^\W*[+-]\s*\d[\d.,]*\s*${UNIT_SUFFIX}\W*$`, "i");
/** Marca de resultado: com ela, a linha só com o número é o placar do tipster, não uma stake. */
const RESULT_MARK = /[✅❌✔🟢🔴]/u;
const isLoneSignedStake = (line: string): boolean => SIGNED_UNITS_LINE.test(line) && !RESULT_MARK.test(line);

const STAKE_LABEL_BEFORE = /\b(?:stake|entrada|unidades?|gest[aã]o)\s*[:=]?\s*$/i;

/**
 * Número com sinal numa frase ("Semana: +8,5u", "Saldo do dia -2u") é
 * resultado ou saldo, não a stake. Só é stake escrita, e inválida, sozinho na
 * linha, logo depois do rótulo de stake ou antes de "cada".
 */
export function signedUnitsAreResult(line: string, signStart: number, end: number): boolean {
  return !isLoneSignedStake(line) && !STAKE_LABEL_BEFORE.test(line.slice(0, signStart))
    && !/^\s*cada\b/i.test(line.slice(end));
}

/** Stake inline: "1u", "0,5 unidade", "2 units". Teto = MAX_STAKE_UNIDADES (sanity.ts). */
function findInlineStake(lines: string[]): number | null {
  for (const raw of lines) {
    const line = expandVulgarFractions(raw);
    if (/^\W*meia\s+(?:unidade|u)\b/i.test(line)) return 0.5;
    // Número com sinal numa frase ("Ontem +12u") é resultado, não a stake
    // apostada. Sozinho na linha ("-2u") é stake escrita inválida.
    const units = [...line.matchAll(STAKE_UNITS_PATTERN)];
    const numberStart = (match: RegExpMatchArray) => (match.index ?? 0) + (match[1]?.length ?? 0);
    const unit = units.find((match) => {
      const start = stakeUnitsTokenStart(line, numberStart(match));
      return !match[2] && !isBankrollOrResultUnits(line, start, (match.index ?? 0) + match[0].length)
        && !LIMIT_BEFORE.test(line.slice(0, start));
    });
    if (unit?.[3]) {
      const v = parseDecimalInput(unit[3]);
      return v === null ? Number.NaN : unitsWithFractionOrRange(line.slice(0, numberStart(unit)), v);
    }
    if (units.length > 0 && isLoneSignedStake(line)) return Number.NaN;
  }

  // Alguns canais publicam a stake como uma linha numérica imediatamente após
  // a odd, sem rótulo nem sufixo: `@1.90\n1.5`. A posição imediata e a linha
  // estritamente numérica evitam capturar placar, data ou handicap dispersos.
  const bareStake = lineAfterOdds(lines)?.trim();
  if (bareStake && /^[+-]?\d+(?:[.,]\d+)?$/.test(bareStake) && mayBeBareStake(bareStake)) {
    return parseDecimalInput(bareStake) ?? Number.NaN;
  }
  return null;
}

/**
 * Número sem rótulo nem sufixo que pode ser a stake. `19.30`/`08:15` é muito
 * mais provavelmente horário, e "90" (ou "🔥 85%") minuto, dinheiro ou
 * confiança do que unidades. Mantém `1.5`, formato real já coberto pelos canais.
 */
function mayBeBareStake(value: string): boolean {
  if (/^(?:[01]?\d|2[0-3])[.:][0-5]\d$/.test(value)) return false;
  const v = parseDecimalInput(value);
  return v === null || v <= MAX_BARE_STAKE_UNITS;
}

function lineAfterOdds(lines: readonly string[]): string | undefined {
  const oddsLineIndex = lines.findIndex((line) => findInlineOdds(line) !== null);
  return oddsLineIndex >= 0 ? lines[oddsLineIndex + 1] : undefined;
}

/** Rótulo de stake com algo escrito depois ("Stake 3/10", "Stake: 2 de 5", "Stake alta"); "Stake:" e "Stake: u" são rótulo vazio. */
const WRITTEN_STAKE_LABEL = /^(?:stake|unidade?s?)\b(?!\s*[:\-]?\s*u?\s*$)/i;

function isWrittenStakeLabel(line: string): boolean {
  return WRITTEN_STAKE_LABEL.test(cleanLine(line));
}

/** Percentual sozinho na linha, como stake: "2%", "💰 2% da banca". */
const BANKROLL_PERCENT_LINE = /^(\d[\d.,]*)\s*%(?:\s+(?:d[ao]\s+)?(?:banca|bankroll))?$/i;

/**
 * O post escreveu a stake, mesmo num formato que a regra não lê: rótulo com
 * valor ("Stake 3/10", "💰 Stake: 2 de 5"), percentual sozinho na linha ("2%",
 * "2% da banca") ou número com ornamento logo depois da odd ("💰 1.5"). A
 * leitura a marca inválida, para a banca não aplicar a stake padrão, e o
 * porteiro de rascunho manda o post para a IA em vez de esperar uma edição.
 * Número solto que a leitura recusa como stake (horário, "90", "🔥 85%") e a
 * nota do tipster ("⭐ 3") não contam.
 */
export function writesStake(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const bareNumber = (line: string | undefined, shape: RegExp) => {
    if (line === undefined || RATING_BEFORE.test(line.slice(0, line.search(/\d/)))) return false;
    const value = cleanLine(line).match(shape)?.[1];
    return value !== undefined && mayBeBareStake(value);
  };
  return lines.some((line) => isWrittenStakeLabel(line) || bareNumber(line, BANKROLL_PERCENT_LINE))
    || bareNumber(lineAfterOdds(lines), /^(\d+(?:[.,]\d+)?)$/);
}

/**
 * Kickoff do post. "Data:" e "Horário:" podem vir em linhas separadas, em
 * qualquer ordem, ou só a hora rotulada com a data solta ("📅 27/09" +
 * "Horário: 16:00"). Rótulo que não dá data não apaga a data escrita em outra
 * linha. A linha da stake fica de fora: "Stake 3/10" não é 3 de outubro.
 */
function parseKickoff(fields: Partial<Record<keyof typeof LABELS, string>>, lines: readonly string[], now?: Date) {
  const labeled = [fields.data, fields.hora].filter((value) => value !== undefined).join(" ");
  const kickoff = (labeled ? parseBrKickoffDetailed(labeled, now) : null)
    ?? parseBrKickoffDetailed(lines.filter((line) => !isWrittenStakeLabel(line)).join("\n"), now);
  if (!kickoff?.dateOnly || fields.hora === undefined) return kickoff;
  return parseBrKickoffDetailed(`${spDayKey(kickoff.date)} ${fields.hora}`, now) ?? kickoff;
}

export function parseUniversalBetPost(
  text: string,
  options?: {
    now?: Date; stakeSettings?: CaptureStakeSettings;
    /** A odd ou a stake que o post não escreve entra como 0: o guard a recusa, e o dono a informa. */
    missingNumbersAsZero?: boolean;
  },
): UniversalParseResult {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const fields: Partial<Record<keyof typeof LABELS, string>> = {};
  const labelCount = new Map<keyof typeof LABELS, number>();
  for (const line of lines) {
    const cleaned = cleanLine(line);
    for (const [key, re] of Object.entries(LABELS) as Array<
      [keyof typeof LABELS, RegExp]
    >) {
      const match = (key === "stake" ? expandVulgarFractions(cleaned) : cleaned).match(re);
      if (!match?.[1]) continue;
      labelCount.set(key, (labelCount.get(key) ?? 0) + 1);
      if (fields[key] === undefined) fields[key] = match[1].trim();
    }
  }
  // Dupla, tripla ou "Criar Aposta" lida como simples grava a primeira perna
  // com a odd do bilhete inteiro. A regra não separa pernas: a leitura por IA
  // lê o bilhete.
  if (looksLikeMultipleBet(text, labelCount)) return { ok: false, missing: ["multipla"] };

  const evento =
    (fields.evento && findEventoLine([fields.evento])) ?? findEventoLine(lines);
  const unwritten = options?.missingNumbersAsZero ? 0 : null;
  const odds =
    (fields.odds !== undefined ? parseDecimalInput(fields.odds) : findInlineOdds(text)) ?? unwritten;
  const originalStake = fields.stake !== undefined ? parseDecimalInput(fields.stake) ?? Number.NaN : findInlineStake(lines);
  const resolvedStake = resolveCaptureStake(originalStake === null && writesStake(text) ? Number.NaN : originalStake, options?.stakeSettings);
  const stake = resolvedStake.stake ?? unwritten;

  const missing: string[] = [];
  if (!evento) missing.push("evento");
  if (odds === null || (odds !== unwritten && (odds <= 1 || odds > MAX_ODDS))) missing.push("odds");
  if (stake === null || (stake !== unwritten && (!Number.isFinite(stake) || stake <= 0 || stake > MAX_STAKE_UNIDADES))) missing.push("stake");
  // O guard abaixo repete a nulidade só para o TS estreitar os tipos (sem `!`).
  if (missing.length > 0 || evento === null || odds === null || stake === null) {
    return { ok: false, missing };
  }

  const selecao = fields.selecao ?? findUnlabeledSelection(lines, evento) ?? "";
  const legs = parseBetLegs(fields.evento ?? evento, selecao, fields.mercado ?? "");
  // Duas condições ligadas por "e" que não viraram pernas ("Sim e Over 2.5"):
  // a regra gravaria o mercado de uma só. A leitura por IA separa as pernas.
  if (!legs && isCombinedSelection(selecao, evento)) return { ok: false, missing: ["multipla"] };
  // Nas pernas, cada uma já tem o mercado inferido; a seleção inteira não é de um mercado só.
  const mercado = fields.mercado ?? legs?.legs[0]?.mercado ?? inferMercadoFromSelecao(selecao, evento);
  if (!selecao) {
    return { ok: false, missing: ["selecao"] };
  }
  if (!mercado) {
    return { ok: false, missing: ["mercado"] };
  }

  const parsedKickoff = parseKickoff(fields, lines, options?.now);
  const sportResolution = detectSportFromText(text);

  return {
    ok: true,
    bet: {
      ...(resolvedStake.snapshot ? { stakePolicySnapshot: resolvedStake.snapshot } : {}),
      evento: legs
        ? [...new Set(legs.legs.map((leg) => leg.evento))].join(" | ")
        : evento,
      esporte: sportResolution.sport ?? UNKNOWN_SPORT,
      competicao: fields.competicao ?? "",
      pais: "",
      mercado: legs?.legs[0]?.mercado ?? mercado,
      selecao,
      odds,
      stake,
      data: parsedKickoff?.date ?? null,
      kickoffDateOnly: parsedKickoff?.dateOnly,
      casaDeAposta: fields.casa ?? "",
      sportResolution,
      ...(legs ? { legs } : {}),
    },
  };
}

/** Odd e stake escritas na linha da seleção ("Over 2.5 @1.90 1u"). */
const INLINE_PRICE_AND_STAKE = new RegExp(String.raw`@\s*\d[\d.,]*|\bodd?s?\s*[:\-]?\s*\d[\d.,]*|[+-]?\d[\d.,]*\s*${UNIT_SUFFIX}`, "gi");

/** Número precedido de limite ("min 1,75", "máx 2u"): piso ou teto, não aposta. */
function mentionsLimit(line: string): boolean {
  return [...line.matchAll(/\d/g)].some((match) => LIMIT_BEFORE.test(line.slice(0, match.index)));
}

/** Conjunção, parêntese, período curto ("1º T") ou "HE" na linha solta: combinação ou qualificador. */
const UNLABELED_QUALIFIER = /[&()]|\+(?!\s*\d)|\b\d\s*[ºo°]?\s*t\b|\b(?:he|eh|ht|ft)\b/i;
/** O que pode vir depois da linha numa seleção solta: a unidade do total. */
const UNLABELED_LINE_UNIT = /^(?:gols?|goals?|pontos?|points?|games?|escanteios?|cantos?|corners?)?$/;

/**
 * Forma que a linha sem rótulo precisa ter para a regra lê-la: sem
 * qualificador, nada além da unidade depois da linha, e a linha começa por
 * Over/Under ou tem como sujeito um time do confronto. "Pedro over 0.5 gols"
 * e "min 1,75" não têm.
 */
function unlabeledShapeIsReadable(selecao: string, evento: string): boolean {
  if (UNLABELED_QUALIFIER.test(selecao)) return false;
  const n = normalizeStr(selecao);
  const numbers = [...n.matchAll(/[+-]?\d+(?:[.,]\d+)?/g)];
  const [first] = numbers;
  const last = numbers.at(-1);
  if (!first || !last) return true; // Vencedor pelo nome: a inferência já é estrita.
  if (!UNLABELED_LINE_UNIT.test(n.slice((last.index ?? 0) + last[0].length).trim())) return false;
  if (/^(?:over|under|o|u)\b/.test(n)) return true;
  const subject = n.slice(0, first.index).replace(/\b(?:over|under|mais de|menos de)\b.*$/, "").trim();
  return subject !== "" && matchTeamSide(subject, evento) !== null;
}

/**
 * Seleção sem o rótulo "Entrada:": só quando sobra UMA linha que não é
 * rótulo, confronto, data, link, limite nem só odd e stake, que tem a forma
 * de `unlabeledShapeIsReadable` e que o leitor sabe classificar sozinha
 * (total, handicap, vencedor pelo nome do time). Duas linhas candidatas
 * (cabeçalho, competição, comentário) ou uma que ele não entende ficam para
 * a IA.
 */
function findUnlabeledSelection(lines: string[], evento: string): string | null {
  const candidates = lines.flatMap((line) => {
    const cleaned = cleanLine(line);
    if (!cleaned || /https?:\/\//i.test(line) || mentionsLimit(line)) return [];
    if (Object.values(LABELS).some((re) => re.test(cleaned))) return [];
    if (findEventoLine([line]) !== null || parseBrKickoffDetailed(cleaned) !== null) return [];
    const rest = cleanLine(cleaned.replace(INLINE_PRICE_AND_STAKE, " "));
    return /\p{L}/u.test(rest) ? [rest] : [];
  });
  const [only] = candidates;
  if (candidates.length !== 1 || !only) return null;
  // Período escrito na linha solta ("Over 0.5 1º tempo") fica para a IA: sem
  // o rótulo, nada separa o período do mercado da seleção.
  if (marketPeriodOf(only) !== "FT" || !unlabeledShapeIsReadable(only, evento)) return null;
  return inferMercadoFromSelecao(only, evento) ? only : null;
}

/** Palavras de bilhete combinado; "dupla chance" é mercado, não dupla. */
const MULTIPLE_BET_VOCABULARY =
  /\b(?:dupla(?!\s*chance)|tripla|qu[aá]drupla|m[uú]ltipla|acumulada|combinada|criar\s+aposta|bet\s*builder|sgp)\b|\bvence\s+e\b/i;

function looksLikeMultipleBet(text: string, labelCount: ReadonlyMap<string, number>): boolean {
  if (MULTIPLE_BET_VOCABULARY.test(text)) return true;
  return (["evento", "selecao"] as const).some((key) => (labelCount.get(key) ?? 0) > 1);
}

/**
 * Seleção de vencedor que a moneyline sabe ler: o nome do time (ou Casa/Fora/
 * Empate) e palavras de "vence"; também DNB e Dupla Chance, que a
 * canonicalização da captura converte. Texto a mais fica para a IA.
 */
const STRICT = { strict: true } as const;

function isReadableWinnerSelection(rawSelecao: string, evento: string): boolean {
  const selecao = stripSelectionOdds(rawSelecao);
  if (matchMoneylineSelection(selecao, evento, STRICT)) return true;
  const dnb = stripDrawNoBetFromSelection(selecao);
  if (dnb.isDnb && dnb.cleanTeam && matchMoneylineSelection(dnb.cleanTeam, evento, STRICT)) return true;
  if (matchDoubleChanceSelection(selecao, evento)) return true;
  const dc = stripDoubleChanceFromSelection(selecao);
  return dc.isDc && Boolean(dc.cleanTeam) && matchMoneylineSelection(dc.cleanTeam, evento, STRICT) !== null;
}

/** Sem linha "Mercado:": infere o suficiente para a normalização agir. */
function inferMercadoFromSelecao(selecao: string, evento: string): string | null {
  // Uma linha nua como `+22.5` não prova handicap: também pode ser total de
  // games/pontos. Sem substantivo ou time, o parser deve pedir o mercado em
  // vez de inventar uma semântica liquidável.
  if (/^[+-]\s*\d+(?:[.,]\d+)?$/.test(selecao.trim())) return null;

  const n = normalizeStr(selecao);
  if (isEsportsPlayerSelection(selecao, evento)) {
    // A seleção conserva atleta, estatística, mapa e período. Um O/U
    // individual não pode cair na regra de total de gols de futebol.
    return "Player Props";
  }

  // Player props & artilheiro inferidos da seleção (ex: "Agustin Campana Anytime", "Djeidi Gassama ASS")
  if (/\b(?:anytime|marcar a qualquer momento|para marcar)\b/i.test(n)) {
    return "Anytime Goalscorer";
  }
  if (/\b(?:primeiro\s*gol|1[º°o]?\s*gol|first\s*goal|1st\s*goalscorer|first\s*goalscorer)\b/i.test(n)) {
    return "First Goalscorer";
  }
  if (/\b(?:3\+\s*gols?|3\s*ou\s*mais\s*gols?|to\s*score\s*3\+\s*goals?|hat\s*-?\s*trick)\b/i.test(n)) {
    return "To Score 3+ Goals";
  }
  if (/\b(?:2\+\s*gols?|2\s*ou\s*mais\s*gols?|to\s*score\s*2\+\s*goals?)\b/i.test(n)) {
    return "To Score 2+ Goals";
  }
  if (/\b(?:ass|assist|assists|assistencia|assistencias|assistências)\b/i.test(n)) {
    return "Player Assists";
  }
  if (/\b(?:chutes?\s+ao?\s+gol|chutes?\s+no\s+gol|shots?\s+on\s+target|finaliza[cç][oõ]es?\s+no\s+alvo)\b/i.test(n)) {
    return "Shots On Target";
  }
  if (/\b(?:chutes?|shots?|finaliza[cç][oõ]es?)\b/i.test(n)) {
    return "Shots";
  }

  // Fonte única da detecção de O/U (inclui abreviações "U 4.5"/"O 2.25").
  if (looksLikeTotalSelection(selecao)) {
    const market = inferPinnacleStatMarket("Total", selecao);
    // "Flamengo over 1.5 gols" é total DO TIME: como total do jogo, um 1x1
    // pagaria a aposta.
    return market === "Total" && selecaoNomeiaTimeDoTotal(selecao, evento) ? "Team Total" : market;
  }
  // Europeu (3 vias) não tem push: a cobertura exata perde. Não vira asiático.
  if (declaresEuropeanHandicap(selecao)) return "European Handicap";
  // "Negativos 2.5"/"Positivos 2.5" é total escrito em gíria (menos/mais), não
  // linha de time: a regra não sabe a direção com segurança.
  if (/\b(?:negativos?|positivos?)\b/.test(n)) return null;
  if (/[+-]\d+(?:[.,]\d+)?/.test(n) || selecaoPareceHandicap(selecao)) {
    return inferPinnacleStatMarket("Asian Handicap", selecao);
  }
  return isReadableWinnerSelection(selecao, evento) ? "Moneyline" : null;
}
