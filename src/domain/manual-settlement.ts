/** Dados que acompanham a decisão exibida ao operador; sem timestamps de manutenção. */
export type ManualSettlementView = {
  version: number; event: string; sport: string; competition: string; country: string;
  market: string; selection: string; date: string; bookmaker: string;
  odds: number; stake: number; unitValue: number; status: string; profit: number;
  kickoffInferred: boolean; settledAt: string | null; sportState: string;
  liveScoreHome: number | null; liveScoreAway: number | null;
};
export type ManualSettlementConfirmation = { expectedVersion: number; requestId: string };
export type ManualSettlementResult =
  | { kind: "saved"; lucro: number; current: ManualSettlementView; duplicate: boolean }
  | { kind: "conflict"; current: ManualSettlementView }
  | { kind: "unavailable"; message: string };

export function manualSettlementView(row: {
  manualSettlementVersion: number; evento: string; esporte: string; competicao: string;
  pais: string; mercado: string; selecao: string; data: Date; casaDeAposta: string;
  odds: unknown; stake: unknown; valorUnidade: unknown; status: string; lucro: unknown;
  kickoffInferido?: boolean; settledAt?: Date | null; sportResolutionStatus?: string;
  liveScoreHome?: number | null; liveScoreAway?: number | null;
}): ManualSettlementView {
  return {
    version: row.manualSettlementVersion, event: row.evento, sport: row.esporte,
    competition: row.competicao, country: row.pais, market: row.mercado, selection: row.selecao,
    date: row.data.toISOString(), bookmaker: row.casaDeAposta, odds: Number(row.odds),
    stake: Number(row.stake), unitValue: Number(row.valorUnidade), status: row.status, profit: Number(row.lucro),
    kickoffInferred: row.kickoffInferido ?? false, settledAt: row.settledAt?.toISOString() ?? null,
    sportState: row.sportResolutionStatus ?? "CONFIRMED",
    liveScoreHome: row.liveScoreHome ?? null, liveScoreAway: row.liveScoreAway ?? null,
  };
}
