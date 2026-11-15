import { prisma } from "@/src/infra/prisma";
import type { Prisma } from "@/src/generated/prisma/client";
import { isBreakerOpen } from "@/src/infra/circuit-breaker";
import { bridgeOddsIsAuthoritative, identityProviders } from "@/src/providers/coverage";
import { pinnacle17Configured } from "@/src/providers/pinnacle17/client";
import { adaptiveBatchSize } from "@/src/services/sharp/batch-size";
import { reviveCadenciaMs } from "@/src/domain/enrich-cadence";
import { PERMANENT_NO_ODDS_REASONS } from "@/src/domain/no-odds-reason";
import { trainingReviewCooldownsActive } from "@/src/services/sharp/training-resolve";
import { classifyEnrichSkip } from "@/src/services/sharp/enrich/enrich-bet";
import { isHistoricalIdentityRecovery } from "@/src/services/sharp/enrich/historical-identity";

/**
 * Revival do enrich para o tipster que aposta antes de a Pinnacle listar a
 * linha. Revive identidade aberta (sem sharp ou PENDING) com kickoff entre
 * −30d e +72h, a casada pela Bridge que ainda espera a referência de fechamento
 * da Pinnacle17 (até o kickoff), e liquidada nos últimos 30 dias ainda sem
 * identidade (só a identidade, para o fechamento e o CLV). UNMATCHED terminal
 * e banca OFF não revivem: só gastariam cota ou sairiam na hora.
 *
 * Cadência pela proximidade do kickoff (`reviveCadenciaMs`, contada de
 * `sharp.updatedAt`). Aposta com `sharp.enrich` na fila fica de fora, para não
 * duplicar consumo de cota. Kickoff provisório acorda mesmo com o breaker da
 * Bridge aberto: FlashScore e Pinnacle17 ainda podem corrigir o horário.
 */

const IDENTITY_RECOVERY_MS = 30 * 24 * 3_600_000;
const FUTURO_MS = 72 * 3_600_000;
const PERTO_DO_KICKOFF_MS = 8 * 3_600_000;

export async function findBetsParaReviver(agora: Date): Promise<string[]> {
  const inicio = new Date(agora.getTime() - IDENTITY_RECOVERY_MS);
  const fim = new Date(agora.getTime() + FUTURO_MS);

  const where: Prisma.BetWhereInput = {
      deletedAt: null,
      sportResolutionStatus: "CONFIRMED",
      data: { gte: inicio, lte: fim },
      bankroll: { is: { sharpMode: { not: "OFF" } } },
      OR: [
        {
          AND: [
            { status: "PENDING" },
            { data: { gte: inicio } },
            {
              OR: [
                { sharp: null },
                { sharp: { is: { identityStatus: "PENDING" } } },
              ],
            },
          ],
        },
        // Casada pela Bridge e ainda sem referência de fechamento: a Pinnacle17
        // pode listar a linha até o kickoff (`retryClosingReference`).
        {
          AND: [
            { status: "PENDING" },
            { data: { gt: agora } },
            { kickoffInferido: false },
            { bankroll: { is: { sharpMode: "CLV_ONLY" } } },
            {
              sharp: { is: {
                identityStatus: { in: ["MATCHED", "MANUAL"] },
                provider: "bridgeodds",
                OR: [{ noOddsReason: null }, { noOddsReason: { notIn: [...PERMANENT_NO_ODDS_REASONS] } }],
              } },
            },
          ],
        },
        {
          AND: [
            { status: { in: ["WON", "LOST", "VOID", "HALF_WON", "HALF_LOST", "CASHOUT"] } },
            { data: { lte: agora } },
            {
              OR: [
                { sharp: null },
                { sharp: { is: { identityStatus: "PENDING" } } },
              ],
            },
          ],
        },
      ],
    };

  const take = adaptiveBatchSize(await prisma.bet.count({ where }));

  const select = {
    id: true,
    data: true,
    status: true,
    esporte: true,
    mercado: true,
    selecao: true,
    kickoffInferido: true,
    bankroll: { select: { sharpMode: true } },
    sharp: { select: { updatedAt: true, identityStatus: true } },
  } as const;
  // O limite vale depois de todas as recusas: uma página inteira pode estar
  // em cadência, na fila ou em revisão, e as próximas ainda precisam de vez.
  const emFila = await betIdsComEnrichNaFila();
  const pinnacle17On = pinnacle17Configured();
  const onlyBridge = (row: { esporte: string; mercado: string; selecao: string }) => bridgeOddsIsAuthoritative(row)
    && !(pinnacle17On && identityProviders(row).includes("pinnacle17"));
  let bridgeOpen: boolean | undefined;
  const out: string[] = [];
  // Pendentes primeiro; entre as encerradas importa o kickoff, não a ordem do enum.
  for (const pending of [true, false]) {
    let after: { data: Date; id: string } | null = null;
    while (out.length < take) {
      const rows: Array<Prisma.BetGetPayload<{ select: typeof select }>> = await prisma.bet.findMany({
        where: { AND: [
          where,
          { status: pending ? "PENDING" : { not: "PENDING" } },
          ...(after ? [{ OR: [{ data: { gt: after.data } }, { data: after.data, id: { gt: after.id } }] }] : []),
        ] },
        select,
        orderBy: [{ data: "asc" }, { id: "asc" }],
        take,
      });
      if (rows.length === 0) break;
      const last = rows.at(-1)!;
      after = { data: last.data, id: last.id };
      const candidates = rows.filter((bet) => {
        if (emFila.has(bet.id)) return false;
        if (!bet.sharp) return true;
        const nearKickoff = bet.data.getTime() - agora.getTime() <= PERTO_DO_KICKOFF_MS;
        return agora.getTime() - bet.sharp.updatedAt.getTime() >= reviveCadenciaMs(nearKickoff, !pending);
      });
      const cooldowns = await trainingReviewCooldownsActive(candidates.map((bet) => bet.id), agora);
      for (const bet of candidates) {
        if (cooldowns.has(bet.id)) continue;
        // Kickoff provisório ainda consulta os calendários fora da Bridge.
        if (!bet.kickoffInferido && onlyBridge(bet)) {
          bridgeOpen ??= await isBreakerOpen("bridgeodds");
          if (bridgeOpen) continue;
        }
        out.push(bet.id);
        if (out.length === take) break;
      }
      if (rows.length < take) break;
    }
  }
  return out;
}

/**
 * Reprocesso pedido por alguém (Reprocessar em Operações, replay da
 * dead-letter): devolve a identidade UNMATCHED a PENDING, sem o motivo
 * terminal, para o enrich reenviado consultar os fornecedores. Só reabre o que
 * o enrich ainda busca, senão a identidade ficaria PENDING para sempre. A
 * dead-letter sozinha não reabre: o revival reenviaria o código quebrado a cada
 * cadência.
 */
export async function reopenUnmatchedIdentity(
  betId: string,
  actor: string,
  origem: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const bet = await tx.bet.findUnique({
    where: { id: betId },
    select: {
      id: true, deletedAt: true, status: true, kickoffInferido: true, data: true, registradoEm: true,
      sourcePostedAt: true, bankroll: { select: { sharpMode: true } }, sharp: { select: { identityStatus: true } },
    },
  });
  if (bet?.sharp?.identityStatus !== "UNMATCHED") return;
  const reopened = { identityStatus: "PENDING", noOddsReason: null };
  const skip = classifyEnrichSkip({
    ...bet,
    sharp: reopened,
    allowSettledIdentityRecovery: isHistoricalIdentityRecovery({ ...bet, sharp: reopened }, new Date()),
  });
  if (skip) return;
  const updated = await tx.betSharp.updateMany({
    where: { betId, identityStatus: "UNMATCHED" },
    data: { identityStatus: "PENDING", confidence: 0, identityResolvedAt: null, noOddsReason: null },
  });
  if (updated.count === 0) return;
  await tx.auditEvent.create({
    data: {
      actor,
      action: "bet_sharp.reopen_unmatched",
      resource: "bet",
      resourceId: betId,
      details: { de: "UNMATCHED", para: "PENDING", origem },
    },
  });
}

/** betIds com sharp.enrich ainda na fila — schema pgboss pode não existir em testes isolados. */
export function queuedEnrichBetId(row: { singletonKey: string | null; data: unknown }): string | null {
  const betId = row.data && typeof row.data === "object" && "betId" in row.data
    ? (row.data as { betId?: unknown }).betId
    : null;
  // O payload é a unidade de trabalho autoritativa. A chave é redundância
  // operacional e só serve de compatibilidade quando o payload legado falta.
  if (typeof betId === "string" && betId.length > 0) return betId;
  return row.singletonKey?.startsWith("bet:") ? row.singletonKey.slice(4) : null;
}

export async function betIdsComEnrichNaFila(): Promise<Set<string>> {
  try {
    const queue = await prisma.$queryRaw<Array<{ policy: string }>>`
      SELECT policy::text FROM pgboss.queue WHERE name = 'sharp.enrich' LIMIT 1
    `;
    const rows = queue[0]?.policy === "exclusive"
      ? await prisma.$queryRaw<Array<{ singletonKey: string | null; data: unknown }>>`
          SELECT singleton_key AS "singletonKey", data FROM pgboss.job
          WHERE name = 'sharp.enrich'
            AND policy = 'exclusive'
            AND state IN ('created', 'retry', 'active')
        `
      : await prisma.$queryRaw<Array<{ singletonKey: string | null; data: unknown }>>`
          SELECT singleton_key AS "singletonKey", data FROM pgboss.job
          WHERE name = 'sharp.enrich'
            AND state IN ('created', 'retry', 'active')
        `;
    return new Set(rows.map(queuedEnrichBetId).filter((id): id is string => id !== null));
  } catch (error) {
    if (process.env.NODE_ENV === "test") {
      // Bancos efêmeros dos testes de domínio não inicializam o pg-boss.
      return new Set();
    }
    throw new Error("Falha ao consultar jobs sharp.enrich no pg-boss.", { cause: error });
  }
}
