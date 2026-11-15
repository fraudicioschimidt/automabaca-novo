import { normalizeStr } from "@/src/domain/text";
import { normalizeMercadoKey } from "./catalog";
import { declaresRegulationTime } from "./classify";
import type { MercadoFinal } from "./catalog";

/**
 * Esporte normalizado usado exclusivamente pela taxonomia de mercados.
 *
 * O valor fica junto do mercado porque esta matriz responde uma pergunta de
 * produto ("este rotulo Pinnacle pertence a este esporte?"), nao a capacidade
 * de um provider especifico.
 */
export type MarketSport =
  | "soccer"
  | "basketball"
  | "tennis"
  | "esports"
  | "baseball"
  | "hockey"
  | "american_football"
  | "volleyball"
  | "handball"
  | "rugby"
  | "futsal"
  | "table_tennis"
  | "beach_volleyball"
  | "other";

export function marketSportOf(esporte?: string | null): MarketSport {
  if (!esporte) return "other";
  const value = normalizeStr(esporte).replace(/[_-]+/g, " ");
  if (/\b(?:american football|futebol americano|nfl)\b/.test(value)) {
    return "american_football";
  }
  if (/\b(?:beach volleyball|volei de praia)\b/.test(value)) {
    return "beach_volleyball";
  }
  if (/\b(?:table tennis|tenis de mesa|ping pong)\b/.test(value)) {
    return "table_tennis";
  }
  if (/\b(?:soccer|futebol|association football|futbol)\b/.test(value)) return "soccer";
  if (/\b(?:basketball|basquete|basquetebol|baloncesto)\b/.test(value)) return "basketball";
  if (/\b(?:tennis|tenis)\b/.test(value)) return "tennis";
  if (/\be ?sports?\b/.test(value)) return "esports";
  if (/\b(?:baseball|beisebol)\b/.test(value)) return "baseball";
  if (/\b(?:hockey|hoquei)\b/.test(value)) return "hockey";
  if (/\b(?:volleyball|volei|voleibol)\b/.test(value)) return "volleyball";
  if (/\b(?:handball|handebol)\b/.test(value)) return "handball";
  if (/\b(?:rugby|rugbi)\b/.test(value)) return "rugby";
  if (/\bfutsal\b/.test(value)) return "futsal";
  return "other";
}

const only = (...sports: MarketSport[]) => new Set<MarketSport>(sports);

/**
 * SSOT executavel da compatibilidade esporte x rotulo FINAL Pinnacle.
 *
 * Um rotulo ausente ou uma dupla ausente falha fechada. Formas externas e
 * intermediarias continuam podendo ser convertidas por `finalizePinnacleMarket`,
 * mas nunca ganham status de mercado oficial apenas por existirem no catalogo
 * global de outro esporte.
 */
export const FINAL_MARKET_SPORTS: Readonly<Record<MercadoFinal, ReadonlySet<MarketSport>>> = {
  "Anytime Goalscorer": only("soccer"),
  "Both Teams to Score": only("soccer"),
  "Correct Score": only("soccer"),
  "Double Chance": only("soccer"),
  "First Goalscorer": only("soccer"),
  "Handicap – 1st Half": only("soccer", "basketball"),
  "Handicap – Game": only("basketball", "baseball"),
  "Handicap – Match": only("soccer", "esports", "handball", "futsal"),
  "Handicap (Bookings) – Match": only("soccer"),
  "Handicap (Corners) – 1st Half": only("soccer"),
  "Handicap (Corners) – Match": only("soccer"),
  "Handicap (Games) – Match": only("tennis"),
  "Handicap (Sets) – Match": only("tennis", "volleyball", "table_tennis", "beach_volleyball"),
  "Last Goalscorer": only("soccer"),
  "Match Winner": only("tennis"),
  "Money Line": only("hockey", "american_football"),
  "Money Line – 1st Half": only("soccer", "basketball"),
  "Money Line – Game": only("basketball", "baseball"),
  "Money Line – Match": only("soccer", "esports", "volleyball", "handball", "futsal"),
  "Point Spread": only("american_football"),
  "Puck Line": only("hockey"),
  "Team Total – Match": only("soccer"),
  "Team Total (Games) – Match": only("tennis"),
  "Total – 1st Half": only("soccer"),
  "Total – Game": only("baseball"),
  "Total – Match": only("soccer", "hockey", "esports", "handball", "futsal"),
  "Total (Bookings) – Match": only("soccer"),
  "Total (Corners) – 1st Half": only("soccer"),
  "Total (Corners) – Match": only("soccer"),
  "Total (Games) – Match": only("tennis"),
  "Total (Sets) – Match": only("tennis", "volleyball", "table_tennis", "beach_volleyball"),
  "Total (Kills) – Map 1": only("esports"),
  "Total (Kills) – Map 2": only("esports"),
  "Total (Kills) – Map 3": only("esports"),
  "Total (Kills) – Map 4": only("esports"),
  "Total (Kills) – Map 5": only("esports"),
  "To Score 2+ Goals": only("soccer"),
  "To Score 3+ Goals": only("soccer"),
  "Total Points": only("basketball", "american_football", "rugby", "volleyball"),
  "1st Half Total Points": only("basketball"),
};

/**
 * Mercados do TEMPO REGULAMENTAR nos esportes cujo mercado padrão inclui a
 * prorrogação. "1X2", "Tempo Regular" e "(TR)" apostam no placar sem a
 * prorrogação; gravados como Money Line, Handicap ou Total do jogo, liquidariam
 * pelo placar com prorrogação e teriam o CLV comparado com outro mercado. Ficam
 * fora do catálogo da Config (a Pinnacle só lista o tempo regulamentar no
 * hóquei), como a estatística de jogador que a captura preserva.
 */
export const REGULATION_TIME_MARKETS = {
  moneyline: "Money Line – Regulation Time",
  spread: "Handicap – Regulation Time",
  total: "Total – Regulation Time",
} as const;

export const REGULATION_TIME_SPORTS: ReadonlySet<MarketSport> = only("basketball", "hockey");

/**
 * O texto pede o tempo regulamentar como regra à parte: só onde o mercado
 * padrão inclui a prorrogação, ou com o esporte ainda desconhecido. Nos demais
 * esportes o regulamentar já é o mercado do jogo.
 */
export function restrictsToRegulationTime(text: string, esporte?: string | null): boolean {
  const sport = marketSportOf(esporte);
  return (sport === "other" || REGULATION_TIME_SPORTS.has(sport)) && declaresRegulationTime(text);
}

/** O intermediário do mesmo mercado no jogo inteiro: a base para renormalizar. */
const REGULATION_TIME_BASE: Readonly<Record<string, string>> = {
  [normalizeMercadoKey(REGULATION_TIME_MARKETS.moneyline)]: "Moneyline",
  [normalizeMercadoKey(REGULATION_TIME_MARKETS.spread)]: "Asian Handicap",
  [normalizeMercadoKey(REGULATION_TIME_MARKETS.total)]: "Total",
};

/** Intermediário de jogo inteiro de um mercado do tempo regulamentar; null para os demais. */
export function regulationTimeBaseOf(mercado: string): string | null {
  return REGULATION_TIME_BASE[normalizeMercadoKey(mercado)] ?? null;
}

export function isRegulationTimeMarket(mercado: string): boolean {
  return regulationTimeBaseOf(mercado) !== null;
}

const COMPATIBILITY_BY_KEY = new Map<string, ReadonlySet<MarketSport>>([
  ...Object.entries(FINAL_MARKET_SPORTS).map(([market, sports]) => [
    normalizeMercadoKey(market),
    sports,
  ] as const),
  ...Object.values(REGULATION_TIME_MARKETS).map((market) => [
    normalizeMercadoKey(market),
    REGULATION_TIME_SPORTS,
  ] as const),
]);

export function isMercadoFinalForSport(
  mercado: string,
  esporte?: string | null,
): boolean {
  const allowed = COMPATIBILITY_BY_KEY.get(normalizeMercadoKey(mercado));
  return allowed?.has(marketSportOf(esporte)) ?? false;
}
