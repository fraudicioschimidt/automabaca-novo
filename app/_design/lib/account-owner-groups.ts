import { sumMoneyBy } from "@/src/domain/money";

export type OwnerAccount = {
  id: string;
  titular?: string | null;
  balance: number;
  deposited: number;
  withdrawn: number;
  profit: number;
  betProfit?: number;
};

export type OwnerAccountGroup<T extends OwnerAccount> = {
  owner: string;
  accounts: T[];
  balance: number;
  deposited: number;
  withdrawn: number;
  profit: number;
  betProfit: number;
};

/** Agrupamento de apresentação; totais saem do helper canônico, não de `+=` IEEE. */
export function groupAccountsByOwner<T extends OwnerAccount>(
  accounts: readonly T[],
  fallbackOwner = "Sem titular",
): OwnerAccountGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const account of accounts) {
    const owner = account.titular?.trim() || fallbackOwner;
    const rows = groups.get(owner) ?? [];
    rows.push(account);
    groups.set(owner, rows);
  }
  return [...groups.entries()]
    .map(([owner, rows]) => ({
      owner,
      accounts: rows,
      balance: sumMoneyBy(rows, (row) => row.balance, 2),
      deposited: sumMoneyBy(rows, (row) => row.deposited, 2),
      withdrawn: sumMoneyBy(rows, (row) => row.withdrawn, 2),
      profit: sumMoneyBy(rows, (row) => row.profit, 2),
      betProfit: sumMoneyBy(rows, (row) => row.betProfit ?? 0, 2),
    }))
    .sort((a, b) => a.owner.localeCompare(b.owner, "pt-BR"));
}
