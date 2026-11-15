/**
 * Estados cujo trabalho ainda não terminou. O schema possui `RUNNING` para a
 * janela entre assumir e concluir; tratá-lo como histórico produz falso verde.
 */
export const ACTIVE_OPERATIONAL_ACTION_STATUSES = [
  "OPEN",
  "ACKED",
  "RUNNING",
] as const;

export function isActiveOperationalActionStatus(status: string): boolean {
  return ACTIVE_OPERATIONAL_ACTION_STATUSES.some((active) => active === status);
}

const RISK_LABELS: Record<string, string> = { LOW: "baixo", MEDIUM: "médio", HIGH: "alto", CRITICAL: "crítico" };

/** Risco da ação operacional em português; valor desconhecido sai cru. */
export function riskLabel(risk: string): string {
  return RISK_LABELS[risk] ?? risk;
}
