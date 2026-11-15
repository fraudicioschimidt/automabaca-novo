import { isRaceToMarket, type MarketPeriod } from "@/src/domain/mercados/classify";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import { normalizeStr } from "@/src/domain/text";
import {
  statisticFamilyOf,
  type MatchStatisticKey,
} from "@/src/domain/settlement/statistics";
import type { FlashscoreStatsResponse } from "./types";

/**
 * Rótulo → família, com os rótulos EXATOS observados no feed real de
 * `matches/match/stats` (blocos `match`, `1st-half`, `2nd-half`). Nada aqui é
 * suposto: rótulo não observado não entra, porque liquidar por linha errada é
 * dinheiro invertido. Só entra rótulo visto com valor INTEIRO PURO: percentual
 * (`Ball possession` = "43%"), razão (`Break Points Converted` = "1/12") e
 * híbrido (`Crosses` = "12% (2/17)") são recusados por `integerValue`, e
 * mapeá-los criaria mercado que parece coberto e nunca liquida.
 *
 * Rótulos de esportes diferentes convivem no mesmo array porque cada resposta
 * traz só os do seu esporte: `Fouls` é futebol, `Personal fouls` é basquete, e
 * nenhuma partida tem os dois.
 */
const LABELS = {
  corners: ["Corner kicks", "Corners"],
  yellowCards: ["Yellow cards", "Yellow card"],
  redCards: ["Red cards"],
  shotsTotal: ["Total shots"],
  shotsOnTarget: ["Shots on target"],
  fouls: ["Fouls", "Personal fouls"],
  offsides: ["Offsides"],
  saves: ["Goalkeeper saves"],
  interceptions: ["Interceptions"],
  clearances: ["Clearances"],
  assists: ["Assists"],
  blocks: ["Blocks"],
  steals: ["Steals"],
  turnovers: ["Turnovers"],
  rebounds: ["Total rebounds"],
  aces: ["Aces"],
  doubleFaults: ["Double Faults", "Double faults"],
  threePointers: ["3-point field goals made"],
  // `Record<MatchStatisticKey, …>` é TOTAL: chave a mais ou a menos não
  // compila. Assim esta lista e `MATCH_STATISTIC_KEYS`, no domínio, não
  // divergem: a divergência faria o IA-Judge omitir a linha do prompt em silêncio.
} as const satisfies Record<MatchStatisticKey, readonly string[]>;

export type FlashscoreNormalizedStats = {
  -readonly [K in keyof typeof LABELS]: { home: number; away: number } | null;
};

function integerValue(value: string | number | null): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

function pairFor(
  response: FlashscoreStatsResponse,
  names: readonly string[],
  period: Extract<MarketPeriod, "FT" | "HT" | "SECOND_HALF">,
): { home: number; away: number } | null {
  const accepted = new Set(names.map(normalizeStr));
  const rows =
    period === "HT"
      ? response["1st-half"] ?? []
      : period === "SECOND_HALF"
        ? response["2nd-half"] ?? []
        : response.match;
  const row = rows.find((candidate) => accepted.has(normalizeStr(candidate.name)));
  if (!row) return null;
  const home = integerValue(row.home_team);
  const away = integerValue(row.away_team);
  return home === null || away === null ? null : { home, away };
}

export function normalizeFlashscoreStats(
  response: FlashscoreStatsResponse,
  period: Extract<MarketPeriod, "FT" | "HT" | "SECOND_HALF"> = "FT",
): FlashscoreNormalizedStats {
  const saida = {} as FlashscoreNormalizedStats;
  for (const [chave, rotulos] of Object.entries(LABELS) as Array<
    [keyof typeof LABELS, readonly string[]]
  >) {
    saida[chave] = pairFor(response, rotulos, period);
  }
  return saida;
}

/**
 * Termos que roteiam para estatística mesmo SEM família resolvível.
 *
 * O roteamento é DELIBERADAMENTE mais largo que o resolvedor: "chutes" solto
 * (sem dizer se é total ou no gol) vira `unsupported_market` e vai para o
 * operador, em vez de cair no caminho de GOLS e liquidar errado. Só isso mora
 * aqui — o que o resolvedor reconhece vem dele, não de uma cópia.
 */
const ROTEIA_SEM_RESOLVER =
  /\b(chute|chutes|shot|shots|finalizacao|finalizacoes|canto|cantos)\b/;

export function marketNeedsFlashscoreStats(
  market: string,
  selection: string,
  evento?: string,
  esporte?: string,
): boolean {
  // DERIVADO de `statisticFamilyOf`: com vocabulário próprio, o portão não
  // saberia das famílias novas do resolvedor e o endpoint de estatística nunca
  // seria chamado para elas.
  if (classificarPropDeJogador({ mercado: market, selecao: selection, evento, esporte })) {
    return false;
  }
  // "Race to 3 Cantos" casaria o ROTEIA e compraria /stats para uma pergunta
  // que o agregado não responde. A família já recusa; o portão também.
  if (isRaceToMarket(market, selection)) return false;
  if (statisticFamilyOf(market, selection, evento, esporte) !== null) return true;
  return ROTEIA_SEM_RESOLVER.test(normalizeStr(`${market} ${selection}`));
}
