import { AsyncLocalStorage } from "node:async_hooks";

const budgets = new AsyncLocalStorage<{ provider: string; deadlineMs: number }>();

/** Limita espera por capacidade apenas no trabalho que optou por continuar na fila. */
export function withProviderWorkBudget<T>(provider: string, durationMs: number, run: () => Promise<T>): Promise<T> {
  return budgets.run({ provider, deadlineMs: Date.now() + durationMs }, run);
}

export function providerWorkDeadline(provider: string, explicit?: number): number | undefined {
  const current = budgets.getStore();
  if (current?.provider !== provider) return explicit;
  return Math.min(explicit ?? Infinity, current.deadlineMs);
}
