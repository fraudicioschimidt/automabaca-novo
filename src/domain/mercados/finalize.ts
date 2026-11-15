import { matchMoneylineSelection } from "@/src/domain/settlement/sides";
import { resolveMercadoStatic } from "./catalog";
import { marketKindOf, marketPeriodOf } from "./classify";
import {
  isMercadoFinalForSport,
  marketSportOf,
  REGULATION_TIME_MARKETS,
  REGULATION_TIME_SPORTS,
  regulationTimeBaseOf,
  type MarketSport,
} from "./compatibility";

const FINAL_BY_SPORT: Record<string, Partial<Record<MarketSport, string>>> = {
  Moneyline: {
    soccer: "Money Line – Match",
    esports: "Money Line – Match",
    basketball: "Money Line – Game",
    baseball: "Money Line – Game",
    tennis: "Match Winner",
    hockey: "Money Line",
    american_football: "Money Line",
  },
  "Money Line": {
    soccer: "Money Line – Match",
    esports: "Money Line – Match",
    basketball: "Money Line – Game",
    baseball: "Money Line – Game",
    tennis: "Match Winner",
    hockey: "Money Line",
    american_football: "Money Line",
  },
  "Asian Handicap": {
    soccer: "Handicap – Match",
    basketball: "Handicap – Game",
    tennis: "Handicap (Games) – Match",
    esports: "Handicap – Match",
    baseball: "Handicap – Game",
    hockey: "Puck Line",
    american_football: "Point Spread",
    volleyball: "Handicap (Sets) – Match",
    table_tennis: "Handicap (Sets) – Match",
    beach_volleyball: "Handicap (Sets) – Match",
    handball: "Handicap – Match",
    futsal: "Handicap – Match",
  },
  "Point Spread": { basketball: "Handicap – Game" },
  Total: {
    soccer: "Total – Match",
    basketball: "Total Points",
    baseball: "Total – Game",
    tennis: "Total (Games) – Match",
    esports: "Total – Match",
    handball: "Total – Match",
    futsal: "Total – Match",
    hockey: "Total – Match",
    volleyball: "Total (Sets) – Match",
    table_tennis: "Total (Sets) – Match",
    beach_volleyball: "Total (Sets) – Match",
  },
  "1st Half Total": {
    basketball: "1st Half Total Points",
    soccer: "Total – 1st Half",
  },
  "1st Half Moneyline": {
    soccer: "Money Line – 1st Half",
    basketball: "Money Line – 1st Half",
  },
  "1st Half Handicap": {
    soccer: "Handicap – 1st Half",
    basketball: "Handicap – 1st Half",
  },
  "Team Total": {
    soccer: "Team Total – Match",
    tennis: "Team Total (Games) – Match",
    other: "Team Total – Match",
  },
};

/** Corners/cards: o label final independe do esporte (só existem no futebol). */
const FINAL_FIXED: Record<string, string> = {
  "Asian Total Corners": "Total (Corners) – Match",
  "Corners O/U": "Total (Corners) – Match",
  Corners: "Total (Corners) – Match",
  "Asian Handicap Corners": "Handicap (Corners) – Match",
  "1st Half Asian Corners": "Handicap (Corners) – 1st Half",
  "Total Cards": "Total (Bookings) – Match",
  "Asian Total Cards": "Total (Bookings) – Match",
  "Cards O/U": "Total (Bookings) – Match",
  Cards: "Total (Bookings) – Match",
  "Asian Handicap Cards": "Handicap (Bookings) – Match",
  "Double Chance – Match": "Double Chance",
  "Double Chance - Match": "Double Chance",
  "Run Line": "Handicap – Game",
};

/** Label FINAL Pinnacle a partir do canônico de entrada + esporte. */
export function finalizePinnacleMarket(mercado: string, esporte?: string): string {
  if (
    mercado === "Player Props" ||
    mercado === "Player Points/Rebounds/Assists" ||
    mercado === "Player Points" ||
    mercado === "Player Rebounds" ||
    mercado === "Player Assists" ||
    mercado === "Shots" ||
    mercado === "Shots On Target" ||
    mercado === "To Score 2+ Goals" ||
    mercado === "To Score 3+ Goals"
  ) {
    return mercado;
  }
  const slug = marketSportOf(esporte);
  // Fora dos esportes com prorrogação, o tempo regulamentar É o mercado do
  // jogo (o 1X2 do futebol é o Money Line – Match).
  const regulationBase = regulationTimeBaseOf(mercado);
  if (regulationBase && !REGULATION_TIME_SPORTS.has(slug) && slug !== "other") {
    return finalizePinnacleMarket(regulationBase, esporte);
  }
  if (mercado === "Match Winner" && slug !== "tennis") {
    return finalizePinnacleMarket("Moneyline", esporte);
  }
  if (mercado === "Money Line – Match" && !["soccer", "esports", "other"].includes(slug)) {
    return finalizePinnacleMarket("Moneyline", esporte);
  }
  if (mercado === "Money Line – Game" && slug !== "basketball" && slug !== "baseball") {
    return finalizePinnacleMarket("Moneyline", esporte);
  }
  if (mercado === "Moneyline" || mercado === "Money Line") {
    // Sem rótulo observado para o esporte, preserva a forma externa como
    // conceito intermediário. Ela continua roteável por semântica, mas não
    // contamina o catálogo final como se fosse um nome oficial da Pinnacle.
    return FINAL_BY_SPORT.Moneyline?.[slug] ?? mercado;
  }
  if (mercado === "Handicap – Match" && !["soccer", "esports", "other"].includes(slug)) {
    return finalizePinnacleMarket("Asian Handicap", esporte);
  }
  if (mercado === "Handicap – Game" && slug !== "basketball" && slug !== "baseball") {
    return finalizePinnacleMarket("Asian Handicap", esporte);
  }
  if (mercado === "Total – Match" && ["basketball", "baseball", "tennis"].includes(slug)) {
    return finalizePinnacleMarket("Total", esporte);
  }
  if (mercado === "Total – Game" && slug !== "baseball") {
    return finalizePinnacleMarket("Total", esporte);
  }
  if (mercado === "Team Total – Match" && slug === "tennis") {
    return finalizePinnacleMarket("Team Total", esporte);
  }
  const fixed = FINAL_FIXED[mercado];
  if (fixed) {
    return isMercadoFinalForSport(fixed, esporte) ? fixed : mercado;
  }
  const bySport = FINAL_BY_SPORT[mercado];
  if (!bySport) return mercado;
  const candidate = bySport[slug] ?? mercado;
  return isMercadoFinalForSport(candidate, esporte) ? candidate : mercado;
}

/**
 * Troca o mercado de jogo inteiro pelo do tempo regulamentar quando a aposta o
 * declara (`declared`, lido do texto cru) num esporte com prorrogação. Aposta
 * no empate nesses esportes só existe no tempo normal e também troca. Com o
 * esporte ainda desconhecido, a declaração explícita já grava o mercado do
 * tempo regulamentar, e a confirmação do esporte o devolve ao do jogo se o
 * esporte não tiver prorrogação.
 */
export function regulationTimeMarket(params: {
  mercado: string;
  selecao: string;
  evento: string;
  esporte?: string;
  declared: boolean;
}): string {
  const slug = marketSportOf(params.esporte);
  const overtimeSport = REGULATION_TIME_SPORTS.has(slug);
  if (!overtimeSport && slug !== "other") return params.mercado;
  if (marketPeriodOf(params.mercado, params.esporte) !== "FT") return params.mercado;
  const kind = marketKindOf(params.mercado, params.selecao, params.evento);
  if (kind !== "moneyline" && kind !== "spread" && kind !== "total") return params.mercado;
  const drawBet = overtimeSport && kind === "moneyline" &&
    matchMoneylineSelection(params.selecao, params.evento) === "draw";
  return params.declared || drawBet ? REGULATION_TIME_MARKETS[kind] : params.mercado;
}

/** Mercado em estilo Pinnacle: tradução estática + finalização por esporte. */
export function pinnacleizeMercado(mercado: string, esporte?: string): string {
  const trimmed = (mercado ?? "").trim();
  if (!trimmed) return trimmed;
  const canonical = resolveMercadoStatic(trimmed) ?? trimmed;
  return finalizePinnacleMarket(canonical, esporte);
}

/** O mesmo mercado no 1º tempo, para a coerção não trocar o período declarado. */
const FIRST_HALF_VARIANT: Readonly<Record<string, string>> = {
  "Total": "1st Half Total",
  "Total – Match": "1st Half Total",
  "Total – Game": "1st Half Total",
  "Total Points": "1st Half Total",
  "Moneyline": "1st Half Moneyline",
  "Money Line": "1st Half Moneyline",
  "Money Line – Match": "1st Half Moneyline",
  "Money Line – Game": "1st Half Moneyline",
  "Asian Handicap": "1st Half Handicap",
  "Handicap – Match": "1st Half Handicap",
  "Handicap – Game": "1st Half Handicap",
  "Corners O/U": "Total (Corners) – 1st Half",
  "Asian Total Corners": "Total (Corners) – 1st Half",
  "Total (Corners) – Match": "Total (Corners) – 1st Half",
  "Asian Handicap Corners": "1st Half Asian Corners",
  "Handicap (Corners) – Match": "1st Half Asian Corners",
};

/**
 * Troca de mercado pela seleção (coerção, estatística da legenda) preserva o
 * período que o rótulo declara: "Gols - 1º tempo" + "Over 0.5" é Total –
 * 1st Half, não o jogo inteiro. Sem a variante do período, fica o rótulo
 * recebido, que a liquidação lê pelo período certo ou recusa.
 *
 * O 1º tempo dito só na seleção ("Total de Gols" + "Over 0.5 HT") também vai
 * para o mercado: o rótulo sem período vira "– Match", e o contrato de preço
 * recusaria o jogo inteiro no mercado contra o 1º tempo na seleção. Sem a
 * variante, o período fica só na seleção, que a liquidação lê.
 */
export function keepDeclaredPeriod(original: string, coerced: string, esporte?: string, selecao = ""): string {
  const labelPeriod = marketPeriodOf(original, esporte);
  const fromSelection = labelPeriod === "FT" && marketPeriodOf(selecao, esporte) === "HT";
  const period = fromSelection ? "HT" : labelPeriod;
  if (period === "FT" || marketPeriodOf(coerced, esporte) === period) return coerced;
  const variant = period === "HT" ? FIRST_HALF_VARIANT[coerced] : undefined;
  const finalized = variant ? finalizePinnacleMarket(variant, esporte) : undefined;
  if (finalized && marketPeriodOf(finalized, esporte) === period) return finalized;
  return fromSelection ? coerced : original;
}
