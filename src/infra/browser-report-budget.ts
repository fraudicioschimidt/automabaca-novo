import { privacyHash } from "@/src/infra/privacy";

type Window = { startedAt: number; count: number };
type Budget = { total: Window; callers: Map<string, Window> };
const shared = globalThis as typeof globalThis & { __automabacaBrowserReportBudget?: Budget };

/** Bounded per-process protection. No IP address is retained or logged. */
export function allowBrowserReport(address: string, now = Date.now()): boolean {
  const budget = shared.__automabacaBrowserReportBudget ??= { total: { startedAt: now, count: 0 }, callers: new Map() };
  if (now - budget.total.startedAt >= 60_000) budget.total = { startedAt: now, count: 0 };
  for (const [key, window] of budget.callers) if (now - window.startedAt >= 60_000) budget.callers.delete(key);
  const key = privacyHash(address.slice(0, 200), "browser-report");
  const caller = budget.callers.get(key) ?? { startedAt: now, count: 0 };
  if (caller.count >= 20 || budget.total.count >= 200 || (!budget.callers.has(key) && budget.callers.size >= 1_000)) return false;
  caller.count += 1; budget.total.count += 1;
  budget.callers.set(key, caller);
  return true;
}
