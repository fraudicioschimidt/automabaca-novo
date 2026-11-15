import type { SharpPersistenceClient } from "./upsert-sharp";
import type { Prisma } from "@/src/generated/prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";

type Terms = { evento: string; esporte: string; mercado: string; selecao: string; odds: unknown; data: Date;
  pais?: string; competicao?: string; bankroll?: { sharpMode: string } };
const scope = new AsyncLocalStorage<{ expected?: Terms; sharpMode?: string }>();
export function withEnrichWriteScope<T>(run: () => Promise<T>): Promise<T> { return scope.run({}, run); }
export function expectEnrichTerms(bet: Terms): void {
  const state = scope.getStore();
  if (state) {
    state.expected = { evento: bet.evento, esporte: bet.esporte, mercado: bet.mercado,
      selecao: bet.selecao, odds: String(bet.odds), data: new Date(bet.data), pais: bet.pais, competicao: bet.competicao };
    if (bet.bankroll) state.sharpMode = bet.bankroll.sharpMode;
  }
}
export function advanceEnrichTerms(update: Partial<Terms>): void {
  const expected = scope.getStore()?.expected;
  if (expected) expectEnrichTerms({ ...expected, ...update });
}

export class EnrichObsoleteError extends Error {
  constructor() { super("Aposta removida ou alterada durante o enriquecimento."); this.name = "EnrichObsoleteError"; }
}

/** Lock curto, só no commit. Nenhuma chamada externa acontece dentro dele. */
export async function lockActiveEnrichBet(tx: Prisma.TransactionClient, betId: string) {
  await tx.$queryRaw`SELECT id FROM bets WHERE id = ${betId} FOR UPDATE`;
  const bet = await tx.bet.findUnique({
    where: { id: betId }, select: { evento: true, esporte: true, mercado: true, selecao: true, odds: true, data: true, kickoffInferido: true,
      pais: true, competicao: true, deletedAt: true, liveScoreHome: true, liveScoreAway: true, bankroll: { select: { sharpMode: true } } },
  });
  if (!bet || bet.deletedAt) throw new EnrichObsoleteError();
  const expected = scope.getStore()?.expected;
  if (expected && (bet.evento !== expected.evento || bet.esporte !== expected.esporte ||
    bet.mercado !== expected.mercado || bet.selecao !== expected.selecao ||
    String(bet.odds) !== String(expected.odds) || bet.data.getTime() !== expected.data.getTime() ||
    (expected.pais != null && bet.pais !== expected.pais) || (expected.competicao != null && bet.competicao !== expected.competicao))) throw new EnrichObsoleteError();
  const mode = scope.getStore()?.sharpMode;
  if (mode && mode !== bet.bankroll.sharpMode) throw new EnrichObsoleteError();
  return bet;
}

export class SharpAlreadyExistsError extends Error {}

export async function createSharpWithoutAbortingTransaction(
  db: SharpPersistenceClient,
  args: { data: Prisma.BetSharpCreateManyInput },
): Promise<void> {
  // INSERT ON CONFLICT DO NOTHING mantém a transação utilizável. Capturar um
  // P2002 real dentro dela não desfaz o estado PostgreSQL "transaction aborted".
  const inserted = await db.betSharp.createMany({ ...args, skipDuplicates: true });
  if (!inserted.count) throw new SharpAlreadyExistsError();
}
