import { isDelegatedActor } from "@/src/domain/production-write-actors";
import { prisma } from "@/src/infra/prisma";

/**
 * Devolve a PENDING as identidades MATCHED sem fornecedor. Só o enrich crava
 * MATCHED com fornecedor e id de evento; uma identidade MATCHED sem os dois
 * não entra no revival (que reabre só PENDING) nem no fechamento (que precisa
 * do fornecedor), e a aposta fica sem CLV e sem motivo. MANUAL é decisão do
 * dono e não entra.
 *
 * Simula por padrão; `apply` grava numa transação, com auditoria pelo
 * executor, e depois reenfileira o enrich de cada aposta devolvida.
 */
export type ProviderlessIdentity = {
  betId: string;
  evento: string;
  betStatus: string;
  kickoff: string;
  closingFetchedAt: string | null;
};

export async function reopenProviderlessIdentities(params: {
  executor: string;
  apply: boolean;
  enqueueEnrich?: (betId: string) => Promise<unknown>;
}): Promise<{ identities: ProviderlessIdentity[]; applied: boolean; requeued: number }> {
  if (!isDelegatedActor(params.executor)) {
    throw new Error("executor precisa ser agent:<nome>:por:<operador>, o ator de escrita delegada.");
  }
  const where = { identityStatus: "MATCHED" as const, provider: null, bet: { deletedAt: null } };
  const rows = await prisma.betSharp.findMany({
    where,
    select: {
      betId: true,
      bet: { select: { evento: true, status: true, data: true, closing: { select: { fetchedAt: true } } } },
    },
    orderBy: { betId: "asc" },
  });
  const identities = rows.map((row) => ({
    betId: row.betId,
    evento: row.bet.evento,
    betStatus: row.bet.status,
    kickoff: row.bet.data.toISOString(),
    closingFetchedAt: row.bet.closing?.fetchedAt?.toISOString() ?? null,
  }));
  if (!params.apply || identities.length === 0) {
    return { identities, applied: params.apply, requeued: 0 };
  }

  const reopenedIds = await prisma.$transaction(async (tx) => {
    const reopened: string[] = [];
    for (const { betId } of identities) {
      // Releitura no filtro: uma identidade que o enrich cravou nesse meio
      // tempo não volta.
      const updated = await tx.betSharp.updateMany({
        where: { betId, identityStatus: "MATCHED", provider: null },
        data: { identityStatus: "PENDING", confidence: 0, identityResolvedAt: null, noOddsReason: null },
      });
      if (updated.count === 1) reopened.push(betId);
    }
    if (reopened.length > 0) {
      await tx.auditEvent.createMany({
        data: reopened.map((betId) => ({
          actor: params.executor,
          action: "bet_sharp.reopen_providerless_identity",
          resource: "bet",
          resourceId: betId,
          details: { de: "MATCHED", para: "PENDING", motivo: "identidade MATCHED sem fornecedor" },
        })),
      });
    }
    return reopened;
  }, { timeout: 60_000 });

  let requeued = 0;
  for (const betId of reopenedIds) {
    if (!params.enqueueEnrich) break;
    await params.enqueueEnrich(betId);
    requeued += 1;
  }
  return {
    identities: identities.filter((item) => reopenedIds.includes(item.betId)),
    applied: true,
    requeued,
  };
}
