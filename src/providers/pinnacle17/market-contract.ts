import { supportsSharpEquivalence } from "@/src/domain/mercados/sharp-equivalent";
import { hasNonScoreStatQualifier } from "@/src/domain/mercados/stat-qualifier";
import { statisticFamilyOf } from "@/src/domain/settlement/statistics";
import { declaresRegulationTime, EXTRA_TIME_PATTERN, marketKindOf, marketPeriodOf, REGULATION_TIME_PATTERN } from "@/src/domain/mercados/classify";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import { stripTeamNames } from "@/src/domain/settlement/sides";
import { normalizeStr } from "@/src/domain/text";
import { pinnacle17SportId, type Pinnacle17Market } from "./types";

type Scope = { key: string; text: string; explicit: boolean };
export type Pinnacle17MarketContract = { scope: string; unit: string; selection: string };
const SET_SPORTS = new Set([1, 5, 32, 33, 34]);
const HALF_SPORTS = new Set([4, 15, 16, 18, 26, 27, 29, 36, 39]);
const QUARTER_SPORTS = new Set([4, 15, 36, 39]);
const ORDINALS = ["", "1(?:st|o|a)?|first|primeir[oa]", "2(?:nd|o|a)?|second|segund[oa]", "3(?:rd|o|a)?|third|terceir[oa]", "4(?:th|o|a)?|fourth|quart[oa]", "5(?:th|o|a)?|fifth|quint[oa]"];

/** Period IDs belong to the feed, not to an ordinal (NFL Q1 is period 3).
 * Match by the named scope and persist the actual ID returned by the book. */
function scopeOf(raw: string, sportId: number): Scope | null {
  let text = normalizeStr(raw).replace(/[ºª°]/g, "");
  const found = new Set<string>();
  const take = (pattern: RegExp, key: string) => {
    text = text.replace(pattern, () => { found.add(key); return " "; });
  };
  if ([4, 15].includes(sportId) && declaresRegulationTime(raw)) return null;
  if ([4, 15, 19].includes(sportId)) take(new RegExp(EXTRA_TIME_PATTERN.source, "g"), "match");
  if (sportId === 19) take(new RegExp(REGULATION_TIME_PATTERN.source, "g"), "regulation");
  if (sportId === 3) take(/\b(?:first\s+5\s+innings?|1st\s+5\s+innings?|primeiras?\s+5\s+entradas?|f\s*5|h\s*5)\b/g, "innings:5");
  for (let n = 1; n <= 5; n++) {
    const ordinal = `(?:${ORDINALS[n]})`;
    if (SET_SPORTS.has(sportId)) take(new RegExp(`\\b(?:${ordinal}\\s+set|set\\s*${n}|s\\s*${n}|${n}\\s*s)\\b`, "g"), `set:${n}`);
    if (sportId === 12) take(new RegExp(`\\b(?:(?:mapa?|game|jogo)\\s*${n}|${ordinal}\\s+(?:mapa?|game|jogo))\\b`, "g"), `map:${n}`);
    if (n <= 4 && QUARTER_SPORTS.has(sportId)) take(new RegExp(`\\b(?:${ordinal}\\s+(?:quarter|quarto)|(?:quarter|quarto)\\s*${n}|q\\s*${n}|${n}\\s*q)\\b`, "g"), `quarter:${n}`);
    if (n <= 3 && sportId === 19) take(new RegExp(`\\b(?:${ordinal}\\s+(?:period|periodo)|(?:period|periodo)\\s*${n}|p\\s*${n}|${n}\\s*p)\\b`, "g"), `period:${n}`);
    if (n <= 2 && HALF_SPORTS.has(sportId)) {
      take(new RegExp(`\\b(?:${ordinal}\\s+(?:half|tempo|parte|etapa)|h\\s*${n}|${n}\\s*[ht])\\b`, "g"), `half:${n}`);
    }
  }
  if (HALF_SPORTS.has(sportId)) take(/\b(?:ht|fh|half\s*time|halftime|intervalo|meio tempo)\b/g, "half:1");
  if (HALF_SPORTS.has(sportId)) take(/\bsh\b/g, "half:2");
  take(/\b(?:full\s*time|ft|match|partida|jogo completo|game)\b/g, "match");
  if (found.size > 1) return null;
  // Unknown partials and extra-time rules must never fall back to the match.
  if (marketPeriodOf(text) !== "FT" || /\b(?:set|mapa?|quarter|quarto|periodo?|inning|round|frame|leg|regulation|overtime|ot|shootout|prorrogacao)\s*(?:winner|\d)|\b(?:including|incluindo|incl\.?|regulation|overtime|shootout|prorrogacao)\b/.test(text)) return null;
  return { key: [...found][0] ?? "match", text: text.trim(), explicit: found.size > 0 };
}

const UNITS: ReadonlyArray<readonly [string, RegExp]> = [
  ["corners", /\b(?:corners?|escanteios?|cantos?)\b/],
  ["bookings", /\b(?:bookings?|cards?|cartoes|cartao|carteos)\b/],
  ["sets", /\bsets?\b/], ["games", /\bgames\b/],
  ["points", /\b(?:points?|pontos?|pts)\b/], ["kills", /\b(?:kills?|abates?)\b/],
  ["maps", /\b(?:maps|mapas)\b/], ["rounds", /\b(?:rounds|assaltos)\b/],
  ["frames", /\bframes\b/], ["legs", /\blegs\b/],
  ["runs", /\b(?:runs|corridas)\b/], ["goals", /\b(?:goals?|gols?)\b/],
];
function explicitUnits(text: string): string[] {
  return UNITS.filter(([, pattern]) => pattern.test(normalizeStr(text))).map(([unit]) => unit);
}

function defaultUnit(sportId: number, scope: string, kind: string): string {
  if (sportId === 33) return kind === "moneyline" ? "sets" : "games";
  if (SET_SPORTS.has(sportId)) return scope.startsWith("set:") ? "points" : "sets";
  if ([4, 15, 26, 27, 39].includes(sportId)) return "points";
  if ([16, 18, 19, 29, 36].includes(sportId)) return "goals";
  if ([3, 8].includes(sportId)) return "runs";
  if ([6, 22].includes(sportId)) return "rounds";
  if (sportId === 12) return "maps";
  if (sportId === 28) return "frames";
  if (sportId === 10) return "legs";
  return "regular";
}

function allowedUnit(unit: string, sportId: number, scope: string, kind: string): boolean {
  if (unit === defaultUnit(sportId, scope, kind)) return true;
  if (unit === "corners" || unit === "bookings") return sportId === 29;
  if (unit === "kills") return sportId === 12 && scope.startsWith("map:");
  if (sportId === 33) return ["games", "sets"].includes(unit) && scope === "match";
  if (SET_SPORTS.has(sportId)) return ["sets", "points"].includes(unit) && scope === "match";
  return false;
}

/** Shared by routing and the actual resolver. Availability still requires an
 * open, complete book; capability is never evidence that a price exists. */
export function pinnacle17MarketContract(params: { esporte: string; mercado: string; selecao?: string; evento?: string }): Pinnacle17MarketContract | null {
  const sportId = pinnacle17SportId(params.esporte);
  if (sportId === null) return null;
  const marketLabel = normalizeStr(params.mercado);
  if ((/\bpuck line\b/.test(marketLabel) && sportId !== 19) ||
    (/\brun line\b/.test(marketLabel) && sportId !== 3) ||
    (/\bpoint spread\b/.test(marketLabel) && sportId !== 15)) return null;
  const selection = params.selecao ?? "";
  const kind = marketKindOf(params.mercado, selection, params.evento);
  if (!["moneyline", "spread", "total", "team_total", "double_chance", "draw_no_bet"].includes(kind)) return null;
  if (["double_chance", "draw_no_bet"].includes(kind) && !supportsSharpEquivalence(params.esporte)) return null;
  // These catalogs expose head-to-head winners. Generic totals/spreads do
  // not establish which racing/golf statistic a "Regular" book counts.
  if ([17, 44, 45].includes(sportId) && kind !== "moneyline") return null;
  if (classificarPropDeJogador({ ...params, selecao: selection })) return null;
  const market = scopeOf(params.mercado, sportId);
  const pick = scopeOf(params.evento ? stripTeamNames(selection, params.evento) : selection, sportId);
  if (!market || !pick || (market.explicit && pick.explicit && market.key !== pick.key)) return null;
  const scope = pick.explicit ? pick.key : market.key;
  const units = [...new Set([...explicitUnits(market.text), ...explicitUnits(pick.text)])];
  if (units.length > 1) return null;
  const unit = units[0] ?? defaultUnit(sportId, scope, kind);
  if (!allowedUnit(unit, sportId, scope, kind)) return null;
  // A unidade do livro precisa representar a estatística pedida também na
  // seleção: Bookings não mede só amarelos/vermelhos, e gols não medem chutes.
  if (hasNonScoreStatQualifier(market.text, pick.text) && !["corners", "bookings", "kills"].includes(unit)) return null;
  if ((unit === "corners" || unit === "bookings") &&
    statisticFamilyOf(market.text, pick.text, params.evento, params.esporte) !==
      (unit === "corners" ? "corners" : "booking_points")) return null;
  // Qualifiers outside the measured units describe a prop, not a game line.
  if (/\b(?:shots?|chutes?|rebounds?|rebotes?|assists?|assistencias?|aces?|double faults?|duplas faltas?|offsides?|impedimentos?|penalties|penaltis|corners? race|race to|hits?|steals?|blocks?|tackles?|saves?|dragons?|barons?|inhibitors?|amarelos|vermelhos)\b/.test(market.text)) return null;
  if (["double_chance", "draw_no_bet"].includes(kind) && (scope !== "match" || ["corners", "bookings", "kills"].includes(unit))) return null;
  const cleanedSelection = scopeOf(selection, sportId)?.text;
  return cleanedSelection === undefined ? null : { scope, unit, selection: cleanedSelection };
}

export function pinnacle17MarketMatchesContract(market: Pinnacle17Market, contract: Pinnacle17MarketContract, esporte: string): boolean {
  const sportId = pinnacle17SportId(esporte);
  if (sportId === null) return false;
  const scope = scopeOf(market.periodName, sportId);
  if (!scope?.explicit || scope.key !== contract.scope || (market.period === 0) !== (scope.key === "match")) return false;
  const namedScope = scopeOf(market.name, sportId);
  if (!namedScope || (namedScope.explicit && namedScope.key !== scope.key)) return false;
  const unitText = normalizeStr(market.units);
  const typed = unitText === "regular" ? defaultUnit(sportId, scope.key, market.type) : explicitUnits(unitText)[0];
  if (!typed || typed !== contract.unit) return false;
  const namedUnits = explicitUnits(namedScope.text);
  // No measured Regular-to-Sets contract for these modalities: require the
  // unit in the actual book instead of copying volleyball's default.
  if (unitText === "regular" && [1, 5, 32].includes(sportId) && market.type !== "moneyline" && namedUnits.length === 0) return false;
  return namedUnits.length === 0 || (namedUnits.length === 1 && namedUnits[0] === typed);
}
