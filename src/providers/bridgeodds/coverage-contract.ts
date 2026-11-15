import { declaresRegulationTime, marketIncludesExtraTime, marketPeriodOf } from "@/src/domain/mercados/classify";

/**
 * Contrato de cobertura comprovada do BridgeOdds.
 *
 * Fontes de evidência:
 * - documentação pública `/api-docs` (opening-closing: moneyline, spread, total);
 * - fixtures reais sanitizadas em `tests/fixtures/bridgeodds/`;
 * - medição de cobertura (somente Futebol/Basquete com linhas).
 *
 * Não acrescente esporte ou marketKind porque o tradutor aceita o nome ou
 * porque a API respondeu 200 vazio. A inclusão exige payload real com linha
 * completa de opening/closing e teste do adapter.
 *
 * O Bridge dá identidade e odds de abertura/fechamento; o CLV é derivado aqui
 * das fair odds, `max_bet` não tem moeda declarada e resultado nunca vem dele.
 */

export type BridgeOddsMarketKind =
  | "moneyline"
  | "spread"
  | "total"
  | "draw_no_bet"
  | "double_chance";

export const BRIDGEODDS_COVERAGE = {
  soccer: {
    providerSport: "Futebol",
    marketKinds: [
      "moneyline",
      "spread",
      "total",
      // Equivalências Pinnacle: DNB = AH 0; dupla chance = AH ±0,5.
      "draw_no_bet",
      "double_chance",
    ],
    productMarkets: [
      "Money Line – Match",
      "Handicap – Match",
      "Total – Match",
      "Double Chance",
    ],
  },
  basketball: {
    providerSport: "Basquete",
    marketKinds: ["moneyline", "spread", "total"],
    productMarkets: [
      "Money Line – Game",
      "Handicap – Game",
      "Total Points",
    ],
  },
} as const satisfies Record<string, {
  providerSport: string;
  marketKinds: readonly BridgeOddsMarketKind[];
  productMarkets: readonly string[];
}>;

export type BridgeOddsSport = keyof typeof BRIDGEODDS_COVERAGE;

export function bridgeOddsSportContract(
  esporte: string,
): (typeof BRIDGEODDS_COVERAGE)[BridgeOddsSport] | null {
  const key = esporte.trim().toLowerCase();
  if (key === "soccer" || key === "futebol" || key === "football") {
    return BRIDGEODDS_COVERAGE.soccer;
  }
  if (key === "basketball" || key === "basquete") {
    return BRIDGEODDS_COVERAGE.basketball;
  }
  return null;
}

/** Nome da BridgeOdds para o esporte interno; null = fora do contrato (não consultar). */
export function bridgeSportFromEsporte(esporte: string): string | null {
  return bridgeOddsSportContract(esporte)?.providerSport ?? null;
}

/** Nome canônico EN persistido na Bet quando o match casa. */
export function pinnacleEsporteFromBridgeSport(bridgeSport: string): string {
  if (bridgeSport === BRIDGEODDS_COVERAGE.soccer.providerSport) return "Soccer";
  if (bridgeSport === BRIDGEODDS_COVERAGE.basketball.providerSport) return "Basketball";
  return bridgeSport;
}

/** O mesmo período e a mesma regra de prorrogação do livro medido. */
export function bridgeOddsSupportsScope(esporte: string, mercado: string, selecao = ""): boolean {
  const contract = bridgeOddsSportContract(esporte);
  if (!contract || [mercado, selecao].some(text => marketPeriodOf(text, esporte) !== "FT")) return false;
  return contract === BRIDGEODDS_COVERAGE.soccer
    ? ![mercado, selecao].some(marketIncludesExtraTime)
    : ![mercado, selecao].some(declaresRegulationTime);
}
