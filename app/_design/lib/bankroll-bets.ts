/** Mantém apostas otimistas apenas até a versão autoritativa chegar do servidor. */
export function mergeUniqueBets<T extends { id: unknown }>(
  optimistic: readonly (T | null | undefined)[] = [],
  server: readonly T[] = [],
): T[] {
  const serverIds = new Set(server.map((bet) => bet.id));
  const seen = new Set<unknown>();
  const optimisticOnly = optimistic.filter((bet): bet is T => {
    if (!bet || serverIds.has(bet.id) || seen.has(bet.id)) return false;
    seen.add(bet.id);
    return true;
  });
  return [...optimisticOnly, ...server];
}
