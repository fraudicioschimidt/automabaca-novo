/**
 * Concorrência limitada sem dependência extra — revival/closing usam I/O
 * externo (BridgeOdds); paralelizar demais estoura budget/rate-limit.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await fn(item, i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
