import { isDelegatedActor } from "@/src/domain/production-write-actors";
import { prisma } from "@/src/infra/prisma";

/**
 * Fecha circuitos de LLM que ficaram `OPEN` no banco depois de o cooldown
 * vencer — as "lápides" de modelo retirado do catálogo.
 *
 * Não bloqueiam nada (`isBreakerOpen` compara `openedAt` com o cooldown), mas o
 * banco mente sobre o estado: modelo fora da lista não é mais consultado, e nem
 * o `claimGate` nem a `closeExpiredBreaker` o alcançam. Fecha em vez de apagar
 * (preserva `updatedAt` como trilha) e só toca o que `closeExpiredBreaker`
 * também fecharia: cooldown vencido, trip fresco intocado.
 */
export type CircuitoFechado = {
  provider: string;
  de: string;
  failures: number;
  openedAt: string | null;
  para: "CLOSED";
};

/** Mesmo cooldown estrutural do breaker (`src/infra/circuit-breaker.ts`). */
const COOLDOWN_MS = 15 * 60_000;

export async function limparCircuitosLlm(params: {
  executor: string;
  aplicar: boolean;
}): Promise<{ linhas: CircuitoFechado[]; aplicado: boolean }> {
  if (!isDelegatedActor(params.executor)) throw new Error("executor precisa ser agent:<nome>:por:<dono>");
  const corte = new Date(Date.now() - COOLDOWN_MS);
  return prisma.$transaction(async (tx) => {
    const presos = await tx.providerCircuit.findMany({
      where: {
        provider: { startsWith: "llm:" },
        state: { not: "CLOSED" },
        OR: [{ openedAt: null }, { openedAt: { lte: corte } }],
      },
      select: { provider: true, state: true, failures: true, openedAt: true },
      orderBy: { provider: "asc" },
    });
    const linhas: CircuitoFechado[] = presos.map((row) => ({
      provider: row.provider,
      de: row.state,
      failures: row.failures,
      openedAt: row.openedAt?.toISOString() ?? null,
      para: "CLOSED",
    }));
    if (!params.aplicar || linhas.length === 0) return { linhas, aplicado: false };

    await tx.providerCircuit.updateMany({
      where: { provider: { in: linhas.map((linha) => linha.provider) } },
      data: { state: "CLOSED", failures: 0, openedAt: null },
    });
    await tx.auditEvent.createMany({
      data: linhas.map((linha) => ({
        actor: params.executor,
        action: "provider_circuit.close_expired",
        resource: "provider_circuit",
        resourceId: linha.provider,
        details: {
          de: linha.de,
          para: linha.para,
          failures: linha.failures,
          openedAt: linha.openedAt,
        },
      })),
    });
    return { linhas, aplicado: true };
  }, { timeout: 60_000 });
}
