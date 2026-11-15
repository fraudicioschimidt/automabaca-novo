import { getSharedBoss } from "@/src/infra/boss";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { enqueueAfterCapture } from "@/src/services/scheduling/enqueue-after-capture";
import { channelIdFromSource, telegramChannelSource } from "@/src/domain/telegram-source";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { betIdsComEnrichNaFila, reopenUnmatchedIdentity } from "@/src/services/sharp/revive";
import { Prisma } from "@/src/generated/prisma/client";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

const log = createLogger("reprocess");
const CHANNEL_IDENTITY_RECOVERY_MS = 30 * 24 * 3_600_000;
export const TRANSIENT_CHANNEL_REPROCESS_LIMIT = 100;

/**
 * Reprocesso parcial não é sucesso: o botão devolve `enfileiradas` e o operador
 * lê como "feito", então as apostas que não entraram na fila viram alerta.
 */
async function alertarFalhasDeReprocesso(
  falhas: string[],
  total: number,
  escopo: string,
): Promise<void> {
  if (falhas.length === 0) return;
  await sendOperationalAlert(
    `⚠️ Reprocessamento incompleto (${escopo})\n` +
      `${falhas.length} de ${total} apostas não entraram na fila: ${falhas.slice(0, 5).join(", ")}` +
      (falhas.length > 5 ? "…" : "") + "\n👉 Tente reprocessar de novo.",
    {
      source: "ops.reprocess-enqueue",
      key: `reprocess-batch-failure:${escopo}`,
      title: "Reprocesso deixou apostas sem enfileirar",
      resource: "bet_sharp",
      evidence: { escopo, falhas: falhas.length, total, amostra: falhas.slice(0, 5) },
      autoResolve: false,
    },
  );
}

export function transientChannelWhere(
  channelId: string,
  now = new Date(),
  until = new Date(now.getTime() + 72 * 3_600_000),
  includePastIdentity = true,
): Prisma.BetWhereInput {
  const identitySince = new Date(now.getTime() - CHANNEL_IDENTITY_RECOVERY_MS);
  return {
    source: telegramChannelSource(channelId),
    deletedAt: null,
    sportResolutionStatus: "CONFIRMED",
    status: "PENDING",
    data: includePastIdentity ? { gte: identitySince, lte: until } : { gt: now, lte: until },
    bankroll: { is: { sharpMode: { not: "OFF" } } },
    OR: [
      { sharp: null },
      { sharp: { is: { identityStatus: "PENDING" } } },
    ],
  };
}

export type TransientChannelCount = {
  resource: string;
  transientFailures: number;
  preKickoffFailures: number;
};

type TransientChannelCountRow = {
  source: string;
  transientFailures: number;
  preKickoffFailures: number;
};

function transientEligibilitySql(): Prisma.Sql {
  return Prisma.sql`
    (
      s."betId" IS NULL
      OR s."identityStatus" = 'PENDING'
    )
  `;
}

/**
 * Mesma elegibilidade de `transientChannelWhere`, agregada para todos os canais
 * numa consulta só, em vez de dois `count` por canal: as duas janelas saem da
 * mesma fotografia do banco.
 */
export async function countTransientBetsByChannel(
  channelIds: string[],
  now = new Date(),
): Promise<TransientChannelCount[]> {
  if (channelIds.length === 0) return [];
  const sources = channelIds.map((channelId) => telegramChannelSource(channelId));
  const identitySince = new Date(now.getTime() - CHANNEL_IDENTITY_RECOVERY_MS);
  const recoveryUntil = new Date(now.getTime() + 72 * 3_600_000);
  const preKickoffUntil = new Date(now.getTime() + 24 * 3_600_000);
  const eligibility = transientEligibilitySql();
  const rows = await prisma.$queryRaw<TransientChannelCountRow[]>(Prisma.sql`
    SELECT b.source,
      count(*) FILTER (
        WHERE b.data >= ${identitySince} AND ${eligibility}
      )::int AS "transientFailures",
      count(*) FILTER (
        WHERE b.data > ${now} AND b.data <= ${preKickoffUntil} AND ${eligibility}
      )::int AS "preKickoffFailures"
    FROM bets b
    JOIN bankrolls bk ON bk.id = b."bankrollId"
    LEFT JOIN bet_sharp s ON s."betId" = b.id
    WHERE b.source IN (${Prisma.join(sources)})
      AND b."deletedAt" IS NULL
      AND b."sportResolutionStatus" = 'CONFIRMED'
      AND b.status = 'PENDING'
      AND b.data <= ${recoveryUntil}
      AND bk."sharpMode" <> 'OFF'
    GROUP BY b.source
  `);
  return rows.map((row) => ({
    resource: channelIdFromSource(row.source) ?? row.source,
    transientFailures: row.transientFailures,
    preKickoffFailures: row.preKickoffFailures,
  }));
}

/**
 * Re-enfileira o enrich sharp de uma aposta (botão Reprocessar em /operacoes),
 * reabrindo a identidade "sem par" para o enrich voltar a buscar.
 */
export async function reprocessarBetSharp(betId: string, actor: string): Promise<void> {
  const bet = await prisma.bet.findFirst({
    where: { id: betId, deletedAt: null },
    select: { id: true, sportResolutionStatus: true },
  });
  if (!bet) throw new RecusaDeNegocioError(`Aposta ${betId} não existe ou foi removida.`);
  await prisma.$transaction((tx) => reopenUnmatchedIdentity(betId, actor, "ops-reprocess", tx));
  await enqueueAfterCapture(await getSharedBoss(), [{ betId, sportResolutionStatus: bet.sportResolutionStatus }], "ops-reprocess");
  await prisma.auditEvent.create({
    data: {
      actor,
      action: "sharp.reprocess",
      resource: "bet",
      resourceId: betId,
    },
  });
}

/** Reprocessa somente falhas transitórias de um canal, nunca terminais/permanentes. */
export async function reprocessarTransitoriosDoCanal(
  channelId: string,
  actor: string,
  now = new Date(),
): Promise<{ totalElegiveis: number; elegiveis: number; enfileiradas: number; puladas: number }> {
  if (!/^-?\d{1,20}$/.test(channelId)) throw new Error("channelId inválido.");
  const where = transientChannelWhere(channelId, now);
  const [totalElegiveis, rows] = await Promise.all([
    prisma.bet.count({ where }),
    prisma.bet.findMany({
      where,
      orderBy: { data: "asc" },
      take: TRANSIENT_CHANNEL_REPROCESS_LIMIT,
      select: { id: true },
    }),
  ]);
  const emFila = await betIdsComEnrichNaFila();
  const ids = rows.map((row) => row.id).filter((id) => !emFila.has(id));
  const boss = await getSharedBoss();
  let enfileiradas = 0;
  const falhas: string[] = [];
  for (const betId of ids) {
    try {
      await enqueueSharpEnrich(boss, betId);
      enfileiradas += 1;
    } catch (err) {
      falhas.push(betId);
      log.error({ err, betId, channelId }, "reprocesso transitório de canal falhou em item");
    }
  }
  await alertarFalhasDeReprocesso(falhas, ids.length, `canal ${channelId}`);
  await prisma.auditEvent.create({
    data: {
      actor,
      action: "channel.reprocess_transient",
      resource: "telegram-channel",
      resourceId: channelId,
      details: {
        totalElegiveis, elegiveis: rows.length,
        limite: TRANSIENT_CHANNEL_REPROCESS_LIMIT,
        enfileiradas, puladas: rows.length - ids.length,
      },
    },
  });
  return {
    totalElegiveis, elegiveis: rows.length, enfileiradas,
    puladas: rows.length - ids.length,
  };
}
