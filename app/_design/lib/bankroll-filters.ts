import { STATUS_DE_TELA_FINANCEIROS_SET } from "@/src/domain/status-de-aposta";

const FINANCIAL_STATUSES: ReadonlySet<string> = STATUS_DE_TELA_FINANCEIROS_SET;

export type BankrollFilters = {
  sport: string;
  region: string;
  line: string;
  odds: string;
  movement: string;
};

export const DEFAULT_BANKROLL_FILTERS: Readonly<BankrollFilters> = {
  sport: "todos", region: "todas", line: "todas", odds: "todas", movement: "todas",
};

const ODDS_RANGES = new Set(["todas", "<1.90", "1.90–1.95", "1.95–2.00", "2.00+"]);
const MOVEMENTS = new Set(["todas", "steam", "drift", "estavel"]);

/** Preferências antigas ou corrompidas não podem inutilizar a lista de apostas. */
export function normalizeBankrollFilters(value: unknown): BankrollFilters {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (key: string, fallback: string) => typeof source[key] === "string" && source[key] ? source[key] : fallback;
  const odds = text("odds", "todas");
  const movement = text("movement", "todas");
  return {
    sport: text("sport", "todos"), region: text("region", "todas"), line: text("line", "todas"),
    odds: ODDS_RANGES.has(odds) ? odds : "todas",
    movement: MOVEMENTS.has(movement) ? movement : "todas",
  };
}

type HistoryBet = {
  status: string;
  profit: number | null;
  odds: number;
  esporte?: string | null;
  home?: string | null;
  away?: string | null;
  league?: string | null;
  region: string;
  line: string;
  market?: string | null;
  d?: { moveType?: string | null; casa?: string | null } | null;
};

function statusTab(bet: HistoryBet): "pendentes" | "ganhas" | "perdidas" | null {
  if (bet.status === "pending") return "pendentes";
  // Estas abas descrevem dinheiro; cash-out não prova acerto esportivo,
  // mas seu lucro pertence ao recorte positivo ou negativo.
  if (!FINANCIAL_STATUSES.has(bet.status) || bet.profit == null || !Number.isFinite(bet.profit)) return null;
  return bet.profit > 0 ? "ganhas" : bet.profit < 0 ? "perdidas" : null;
}

function matchesOdds(odds: number, range: string): boolean {
  switch (range) {
    case "<1.90": return odds < 1.90;
    case "1.90–1.95": return odds >= 1.90 && odds < 1.95;
    case "1.95–2.00": return odds >= 1.95 && odds < 2;
    case "2.00+": return odds >= 2;
    default: return true;
  }
}

/** Contagem das abas e seleção compartilham a mesma classificação de resultado. */
export function selectBankrollHistory<T extends HistoryBet>(
  bets: readonly T[],
  { tab, query, filters }: { tab: string; query: string; filters: BankrollFilters },
): { filtered: T[]; counts: Record<"todas" | "pendentes" | "ganhas" | "perdidas", number>; activeFilterCount: number } {
  const counts = { todas: bets.length, pendentes: 0, ganhas: 0, perdidas: 0 };
  const filtered: T[] = [];
  const search = query.trim().toLowerCase();
  const selectedTab = ["pendentes", "ganhas", "perdidas"].includes(tab) ? tab : null;
  for (const bet of bets) {
    const group = statusTab(bet);
    if (group) counts[group]++;
    if (selectedTab && selectedTab !== group) continue;
    if (search && ![bet.home, bet.away, bet.league, bet.region, bet.line, bet.market, bet.d?.casa].join(" ").toLowerCase().includes(search)) continue;
    if (filters.sport !== "todos" && bet.esporte !== filters.sport) continue;
    if (filters.region !== "todas" && bet.region !== filters.region) continue;
    if (filters.line !== "todas" && bet.line !== filters.line) continue;
    if (!matchesOdds(bet.odds, filters.odds)) continue;
    if (filters.movement !== "todas" && bet.d?.moveType !== filters.movement) continue;
    filtered.push(bet);
  }
  const activeFilterCount = [
    filters.sport !== "todos", filters.region !== "todas", filters.line !== "todas",
    filters.odds !== "todas", filters.movement !== "todas",
  ].filter(Boolean).length;
  return { filtered, counts, activeFilterCount };
}
