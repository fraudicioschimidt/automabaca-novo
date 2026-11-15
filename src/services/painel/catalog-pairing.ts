import { spStartOfTodayUtc } from "@/src/domain/dates";
import { getSharedBoss } from "@/src/infra/boss";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { QUEUES } from "@/src/infra/queue-contract";
import { CATALOG_PAIRING_METRIC } from "@/src/services/teams/catalog-pairing";
import type { CatalogPairingRound } from "@/src/services/teams/catalog-pairing-round";

/**
 * O pareamento dos catálogos (Pinnacle17 × FlashScore) visto do painel: o
 * pedido de uma rodada fora dos horários fixos e a situação das rodadas. As
 * chaves dos fornecedores ficam só no worker, então o painel só enfileira.
 */

const log = createLogger("painel-catalog-pairing");
const DAY_MS = 86_400_000;

const CATALOG_PAIRING_REQUEST_ACTION = "teams.catalog_pairing.request";

/**
 * Enfileira uma rodada. A fila é `exclusive`: com um job criado, em retry ou
 * rodando, o pg-boss não cria outro (`send` devolve null), o que segura o
 * duplo clique e o clique durante a rodada do cron sem corrida.
 */
export async function requestCatalogPairingRound(actor: string): Promise<"enfileirado" | "ja_na_fila"> {
  const boss = await getSharedBoss();
  const jobId = await boss.send(QUEUES.teamsCatalogPairing, null);
  await prisma.auditEvent.create({
    data: {
      actor,
      action: CATALOG_PAIRING_REQUEST_ACTION,
      resource: "queue",
      resourceId: QUEUES.teamsCatalogPairing,
      details: { enfileirado: Boolean(jobId), ...(jobId ? { jobId } : {}) },
    },
  });
  return jobId ? "enfileirado" : "ja_na_fila";
}

/**
 * Por que a rodada registrada parou. A rodada com os fornecedores desligados
 * volta antes de gravar a métrica, então nunca aparece aqui.
 */
export type RecordedStop = Exclude<CatalogPairingRound["stoppedBy"], "disabled" | null>;

export type CatalogPairingStatus = {
  /** A rodada mais recente que o worker registrou (a métrica dela). */
  lastRound: { at: Date; stoppedBy: RecordedStop | null } | null;
  /** Jogos do dia de São Paulo (início pela Pinnacle) ligados ao do FlashScore. */
  linkedToday: number;
  /** Fichas de time: cada uma é um id do FlashScore. */
  teamCards: number;
  /** Há rodada na fila ou rodando; null quando a fila não pôde ser lida. */
  inProgress: boolean | null;
};

export async function getCatalogPairingStatus(now: Date = new Date()): Promise<CatalogPairingStatus> {
  const dayStart = spStartOfTodayUtc(now);
  const [metric, linkedToday, teamCards, inProgress] = await Promise.all([
    prisma.operationalMetric.findFirst({
      where: { kind: "action", name: CATALOG_PAIRING_METRIC },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true, labels: true },
    }),
    prisma.catalogGameLink.count({
      where: { status: "ok", kickoffPinnacle: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY_MS) } },
    }),
    prisma.teamCard.count(),
    readInProgress(),
  ]);
  return {
    lastRound: metric ? { at: metric.occurredAt, stoppedBy: stoppedByOf(metric.labels) } : null,
    linkedToday,
    teamCards,
    inProgress,
  };
}

const STOP_REASONS = new Set<string>(["breaker", "budget", "failure", "locked"] satisfies RecordedStop[]);

function stoppedByOf(labels: unknown): RecordedStop | null {
  const value = labels && typeof labels === "object" ? (labels as { stoppedBy?: unknown }).stoppedBy : null;
  return typeof value === "string" && STOP_REASONS.has(value) ? value as RecordedStop : null;
}

/** Mesmos estados que a policy `exclusive` segura: o que impede outro pedido. */
async function readInProgress(): Promise<boolean | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ queued: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pgboss.job
        WHERE name = ${QUEUES.teamsCatalogPairing} AND state IN ('created', 'retry', 'active')
      ) AS queued
    `;
    return rows[0]?.queued ?? false;
  } catch (err) {
    log.error({ err }, "falha ao ler a fila do pareamento dos catálogos (pgboss)");
    return null;
  }
}
