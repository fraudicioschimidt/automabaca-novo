/** Mantém cada Server Action bem abaixo do timeout do proxy, mesmo com ledger serializável. */
export const SETTLEMENT_MANUAL_BATCH_MAX = 50;

/**
 * O lote alcança esta aposta? O liquidador automático pode ter resolvido a
 * aposta depois do clique; sem esta conferência no servidor, o lote
 * sobrescreveria um resultado correto com `manual:<quem>`.
 *
 *  - **Para frente** (won/lost/void/…): só alcança quem ainda está PENDENTE.
 *    Trocar resultado já liquidado é a re-liquidação, superfície própria com
 *    rastro (`tests/liquidacao/reliquidacao.db.test.ts`).
 *  - **Para trás** (`PENDING`, o desfazer do toast): alcança justamente a
 *    aposta que ACABOU de virar terminal. Recusar aqui mataria o undo.
 *
 * Puro, sem I/O: o mesmo predicado serve a borda e o teste.
 */
export function loteAlcancaAposta(statusAtual: string, destino: string): boolean {
  if (destino === "PENDING") return true;
  return statusAtual === "PENDING";
}

/**
 * Desfazer do lote de Operações: só a aposta que ESTE operador acabou de
 * liquidar por `manual:<ator>`. O predicado acima permite PENDING em qualquer
 * terminal (o toast precisa); a borda aperta para não reabrir placar automático.
 */
export function lotePodeDesfazer(
  statusAtual: string,
  lastSettlementSource: string | null,
  actor: string,
): boolean {
  if (statusAtual === "PENDING" || !actor) return false;
  return lastSettlementSource === `manual:${actor}`;
}

export function fonteDoPayloadDeSettlement(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = (payload as { source?: unknown }).source;
  return typeof source === "string" && source.length > 0 ? source : null;
}
