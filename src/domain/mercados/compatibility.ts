/**
 * Compatibilidade esporte × rótulo FINAL da Pinnacle. A matriz responde uma
 * pergunta de produto ("este rótulo pertence a este esporte?"), não a
 * capacidade de um provider; rótulo ou dupla ausente falha fechado. A regra
 * mora em Rust (`rust/crates/dominio/src/mercados/compatibility.rs`).
 */
import dominio from "@automabaca/dominio";

/** Esporte normalizado usado exclusivamente pela taxonomia de mercados. */
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

const [finalMarketSports, , regulationTimeSports] = dominio.compatibilityData();

export function marketSportOf(esporte?: string | null): MarketSport {
  return dominio.marketSportOf(esporte) as MarketSport;
}

/** A matriz esporte × rótulo FINAL, como dado (o teste da taxonomia a confere). */
export const FINAL_MARKET_SPORTS: Readonly<Record<string, ReadonlySet<MarketSport>>> = Object.fromEntries(
  finalMarketSports.map(([market, sports]) => [market, new Set(sports as MarketSport[])]),
);

/** Esportes cujo mercado padrão inclui a prorrogação. */
export const REGULATION_TIME_SPORTS: ReadonlySet<MarketSport> = new Set(regulationTimeSports as MarketSport[]);

/**
 * O texto pede o tempo regulamentar como regra à parte: só onde o mercado
 * padrão inclui a prorrogação, ou com o esporte ainda desconhecido.
 */
export function restrictsToRegulationTime(text: string, esporte?: string | null): boolean {
  return dominio.restrictsToRegulationTime(text, esporte);
}

/** Intermediário de jogo inteiro de um mercado do tempo regulamentar; null para os demais. */
export function regulationTimeBaseOf(mercado: string): string | null {
  return dominio.regulationTimeBaseOf(mercado);
}

export function isRegulationTimeMarket(mercado: string): boolean {
  return dominio.isRegulationTimeMarket(mercado);
}

export function isMercadoFinalForSport(
  mercado: string,
  esporte?: string | null,
): boolean {
  return dominio.isMercadoFinalForSport(mercado, esporte);
}
