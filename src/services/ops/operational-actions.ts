import { createHash } from "node:crypto";
import {
  OperationalActionStatus,
  OperationalRisk,
  type OperationalAction,
  type Prisma,
} from "@/src/generated/prisma/client";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES } from "@/src/domain/operational-action-status";
import { prisma } from "@/src/infra/prisma";
import { redactSensitiveValue } from "@/src/infra/redaction";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

type JsonObject = Record<string, Prisma.InputJsonValue | null>;

/** Contexto persistido junto da ação — o que o operador precisa ver para decidir. */
export type OperationalActionEvidence = JsonObject;

export type ReportOperationalActionInput = {
  source: string;
  key: string;
  area: string;
  actionType: string;
  title: string;
  description: string;
  priority?: number;
  risk?: OperationalRisk;
  resource?: string | null;
  resourceId?: string | null;
  correlationId?: string | null;
  evidence?: JsonObject;
  command?: JsonObject | null;
  occurrenceCount?: number;
  incrementOccurrence?: boolean;
  /** false = a reconciliação automática não fecha; exige decisão humana. */
  autoResolve?: boolean;
};

/** Prioridade padrão por gravidade — quem chama pode sobrescrever. */
export function priorityForRisk(risk: OperationalRisk): number {
  if (risk === OperationalRisk.CRITICAL) return 95;
  if (risk === OperationalRisk.HIGH) return 80;
  if (risk === OperationalRisk.MEDIUM) return 70;
  return 35;
}

export function operationalActionFingerprint(source: string, key: string): string {
  const normalizedSource = source.trim();
  const digest = createHash("sha256")
    .update(`${normalizedSource}\0${key}`)
    .digest("hex")
    .slice(0, 32);
  return `${normalizedSource.slice(0, 80)}:${digest}`;
}

export async function reportOperationalAction(
  input: ReportOperationalActionInput,
  now = new Date(),
): Promise<OperationalAction> {
  const safeInput = redactSensitiveValue(input, { preserveNewlines: true }) as ReportOperationalActionInput;
  return reportOperationalActionWithExisting(prisma, safeInput, now, undefined);
}

/**
 * Variante transacional: persiste a ação junto do efeito de negócio, sem I/O
 * externo. O advisory lock serializa a mesma fingerprint dentro do Postgres e
 * evita a janela find/create entre transações concorrentes.
 */
export async function reportOperationalActionTx(
  tx: Prisma.TransactionClient,
  input: ReportOperationalActionInput,
  now = new Date(),
): Promise<OperationalAction> {
  const safeInput = redactSensitiveValue(input, { preserveNewlines: true }) as ReportOperationalActionInput;
  const fingerprint = operationalActionFingerprint(safeInput.source, safeInput.key);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`operational-action:${fingerprint}`}, 0))`;
  return reportOperationalActionWithExisting(tx, safeInput, now, undefined);
}

type ActionAuditClient = Pick<Prisma.TransactionClient, "auditEvent">;

/** O rastro da caixa de ações: quem mudou o estado de cada ação, quando e por quê. */
export async function recordActionAuditTx(
  client: ActionAuditClient,
  rows: Array<{ id: string; fingerprint: string; status: string }>,
  action: "acknowledged" | "resolved" | "dismissed" | "auto_resolved" | "reopened",
  actor: string,
  note?: string | null,
  extra?: JsonObject,
): Promise<void> {
  if (rows.length === 0) return;
  await client.auditEvent.createMany({
    data: rows.map((row) => ({
      actor,
      action: `operational_action.${action}`,
      resource: "operational_action",
      resourceId: row.id,
      details: { fingerprint: row.fingerprint, status: row.status, note: note ?? null, ...extra },
    })),
  });
}

/** `auditEvent` entra porque a REABERTURA também é uma transição a registrar. */
type OperationalActionClient = Pick<Prisma.TransactionClient, "operationalAction" | "auditEvent">;

async function reportOperationalActionWithExisting(
  client: OperationalActionClient,
  input: ReportOperationalActionInput,
  now: Date,
  knownExisting: OperationalAction | null | undefined,
): Promise<OperationalAction> {
  const fingerprint = operationalActionFingerprint(input.source, input.key);
  const existing = knownExisting === undefined
    ? await client.operationalAction.findUnique({ where: { fingerprint } })
    : knownExisting;
  const common = {
    area: input.area.trim().slice(0, 80),
    actionType: input.actionType.trim().slice(0, 120),
    title: input.title.trim().slice(0, 180),
    description: input.description.trim().slice(0, 2_000),
    priority: Math.max(0, Math.min(100, input.priority ?? 50)),
    risk: input.risk ?? OperationalRisk.LOW,
    resource: input.resource?.slice(0, 120) ?? null,
    resourceId: input.resourceId?.slice(0, 240) ?? null,
    correlationId: input.correlationId?.slice(0, 160) ?? null,
    // `autoResolve` viaja na evidência: é decisão de quem reporta, lida só pela
    // reconciliação, e não merece uma coluna própria na tabela.
    evidence: input.autoResolve === false
      ? { ...(input.evidence ?? {}), autoResolve: false }
      : input.evidence ?? undefined,
    command: input.command ?? undefined,
    lastSeenAt: now,
  };

  if (!existing) {
    try {
      return await client.operationalAction.create({
        data: {
          fingerprint,
          ...common,
          openedAt: now,
          occurrenceCount: Math.max(1, input.occurrenceCount ?? 1),
        },
      });
    } catch (error) {
      // Corrida: outro processo criou a MESMA fingerprint entre o `findUnique`
      // e este `create`. Relê e cai no caminho de update uma única vez; P2002
      // de outra constraint relança em vez de virar laço.
      if ((error as { code?: string }).code !== "P2002") throw error;
      const criadaPorOutro = await client.operationalAction.findUnique({
        where: { fingerprint },
      });
      if (!criadaPorOutro) throw error;
      return reportOperationalActionWithExisting(client, input, now, criadaPorOutro);
    }
  }

  const wasClosed = existing.status === OperationalActionStatus.RESOLVED
    || existing.status === OperationalActionStatus.DISMISSED
    || existing.status === OperationalActionStatus.EXPIRED;
  const reaberta = await client.operationalAction.update({
    where: { id: existing.id },
    data: {
      ...common,
      occurrenceCount: input.occurrenceCount != null
        ? Math.max(1, input.occurrenceCount)
        : input.incrementOccurrence === false
          ? existing.occurrenceCount
          : { increment: 1 },
      // Os campos do CICLO só se escrevem quando há ciclo novo. Regravar o
      // valor lido antes do update transformaria `reopenCount` num contador
      // que a concorrência zera: `{ increment: 1 }` é seguro, `existing.n` não.
      // `openedAt` não aparece aqui de propósito — é a PRIMEIRA vez e não se
      // reescreve: reescrevê-lo apaga a idade da ação, e o cartão diria "desde
      // há 17 h" para um problema de semanas.
      ...(wasClosed
        ? {
          status: OperationalActionStatus.OPEN,
          reopenedAt: now,
          reopenCount: { increment: 1 },
          acknowledgedAt: null,
          resolvedAt: null,
          resolutionNote: null,
        }
        : {}),
    },
  });

  // A reabertura também é transição registrada, como as outras. A nota de
  // resolução que o update acima descarta viaja para cá, onde mora o resto da
  // história.
  if (wasClosed) {
    await recordActionAuditTx(client, [reaberta], "reopened", "system", existing.resolutionNote, {
      resolucaoAnterior: existing.resolutionNote,
      resolvidaEm: existing.resolvedAt?.toISOString() ?? null,
      statusAnterior: existing.status,
      vezesQueVoltou: reaberta.reopenCount,
      abertaDesde: reaberta.openedAt.toISOString(),
    });
  }
  return reaberta;
}

/** Reconciliação em lote: uma leitura para todas as fingerprints, não uma por item. */
export async function reportOperationalActions(
  inputs: ReportOperationalActionInput[],
  now = new Date(),
): Promise<OperationalAction[]> {
  if (inputs.length === 0) return [];
  const safeInputs = inputs.map((input) =>
    redactSensitiveValue(input, { preserveNewlines: true }) as ReportOperationalActionInput
  );
  const fingerprints = safeInputs.map((input) => operationalActionFingerprint(input.source, input.key));
  const existing = await prisma.operationalAction.findMany({
    where: { fingerprint: { in: fingerprints } },
  });
  const byFingerprint = new Map(existing.map((row) => [row.fingerprint, row]));
  const result: OperationalAction[] = [];
  const batchSize = 20;
  for (let offset = 0; offset < safeInputs.length; offset += batchSize) {
    const batch = safeInputs.slice(offset, offset + batchSize);
    result.push(...await Promise.all(batch.map((input) =>
      reportOperationalActionWithExisting(
        prisma,
        input,
        now,
        byFingerprint.get(operationalActionFingerprint(input.source, input.key)) ?? null,
      )
    )));
  }
  return result;
}

export async function acknowledgeOperationalAction(
  id: string,
  owner: string,
  now = new Date(),
): Promise<OperationalAction> {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.operationalAction.updateMany({
      where: { id, status: OperationalActionStatus.OPEN },
      data: {
        status: OperationalActionStatus.ACKED,
        owner: owner.slice(0, 120),
        acknowledgedAt: now,
      },
    });
    if (changed.count !== 1) throw new RecusaDeNegocioError("Ação operacional não está aberta ou não existe.");
    const acao = await tx.operationalAction.findUniqueOrThrow({ where: { id } });
    await recordActionAuditTx(tx, [acao], "acknowledged", owner);
    return acao;
  });
}

/**
 * Fecha a ação desta fingerprint mesmo com `autoResolve: false`.
 * Reconciliação periódica não usa este caminho — só uma prova explícita
 * (por exemplo, uma prova explícita de reconciliação feita pelo operador).
 */
export async function resolveOperationalActionBySourceKeyTx(
  tx: Prisma.TransactionClient,
  source: string,
  key: string,
  note: string,
  now = new Date(),
): Promise<boolean> {
  const fingerprint = operationalActionFingerprint(source, key);
  const existing = await tx.operationalAction.findFirst({
    where: { fingerprint, status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] } },
    select: { id: true },
  });
  if (!existing) return false;
  const changed = await tx.operationalAction.updateMany({
    where: { id: existing.id, status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] } },
    data: { status: OperationalActionStatus.RESOLVED, owner: "system", resolvedAt: now, resolutionNote: note.slice(0, 500) },
  });
  if (changed.count !== 1) return false;
  const acao = await tx.operationalAction.findUniqueOrThrow({ where: { id: existing.id } });
  await recordActionAuditTx(tx, [acao], "resolved", "system", note);
  return true;
}

export async function resolveOperationalActionBySourceKey(
  source: string,
  key: string,
  note: string,
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction((tx) =>
    resolveOperationalActionBySourceKeyTx(tx, source, key, note, now)
  );
}

export async function closeOperationalAction(
  id: string,
  actor: string,
  status: "RESOLVED" | "DISMISSED" = "RESOLVED",
  note = "Condição encerrada pelo operador.",
  now = new Date(),
): Promise<OperationalAction> {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.operationalAction.updateMany({
      where: { id, status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] } },
      data: { status, owner: actor.slice(0, 120), resolvedAt: now, resolutionNote: note.slice(0, 500) },
    });
    if (changed.count !== 1) throw new RecusaDeNegocioError("Ação operacional já foi encerrada ou não existe.");
    const acao = await tx.operationalAction.findUniqueOrThrow({ where: { id } });
    await recordActionAuditTx(tx, [acao], status === "DISMISSED" ? "dismissed" : "resolved", actor, note);
    return acao;
  });
}

/**
 * Fecha as ações abertas de uma fonte que não reporta mais a condição.
 * `retired`: a fonte deixou de existir no código; aí fecha também as que
 * pediam decisão humana, porque ninguém mais vai reconciliá-las.
 */
export async function reconcileOperationalActionSource(
  source: string,
  activeKeys: string[],
  now = new Date(),
  options: { retired?: boolean } = {},
): Promise<number> {
  const normalizedSource = source.trim();
  const fingerprintSourcePrefix = normalizedSource.slice(0, 80);
  const active = activeKeys.map((key) => operationalActionFingerprint(normalizedSource, key));
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`operational-action-reconcile:${normalizedSource}`}, 0))`;
    const candidatas = await tx.operationalAction.findMany({
      where: {
        fingerprint: {
          startsWith: `${fingerprintSourcePrefix}:`,
          ...(active.length ? { notIn: active } : {}),
        },
        status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
      },
      select: { id: true, fingerprint: true, evidence: true },
    });
    // Quem pediu decisão humana não some porque a condição parou de aparecer.
    const rows = options.retired ? candidatas : candidatas.filter(
      (row) => (row.evidence as { autoResolve?: unknown } | null)?.autoResolve !== false,
    );
    if (rows.length === 0) return 0;
    const resolutionNote = options.retired
      ? "A origem desta ação deixou de existir; encerrada na reconciliação automática."
      : "Condição normalizada na reconciliação automática.";
    const updatedRows = await tx.operationalAction.updateManyAndReturn({
      where: {
        id: { in: rows.map((row) => row.id) },
        status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
      },
      data: {
        status: OperationalActionStatus.RESOLVED,
        resolvedAt: now,
        resolutionNote,
      },
    });
    if (updatedRows.length === 0) return 0;
    await recordActionAuditTx(
      tx,
      updatedRows,
      "auto_resolved",
      "system",
      resolutionNote,
    );
    return updatedRows.length;
  });
}

/**
 * Ações que esperam o dono: o mesmo "acionáveis" da caixa em `/monitoramento`
 * (abertas, assumidas e em execução). Os resumos contam por aqui para dizer o
 * mesmo número que a tela.
 */
export async function countActionableOperationalActions(
  where: Prisma.OperationalActionWhereInput = {},
): Promise<number> {
  return prisma.operationalAction.count({
    where: { AND: [where, { status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] } }] },
  });
}

/**
 * Recorte "captura" da caixa, o que o resumo de saúde da captura cobra:
 * pendências da captura, identidade a resolver (a aposta capturada e MEDIDA),
 * avisos do Telegram e a dead-letter das filas do Telegram. SLO, liquidação e
 * as filas agendadas têm os próprios avisos.
 */
export const CAPTURE_ACTIONS_WHERE: Prisma.OperationalActionWhereInput = {
  OR: [
    { area: { in: ["captura", "matching"] } },
    { fingerprint: { startsWith: "telegram." } },
    { actionType: "dlq.replay", evidence: { path: ["fila"], string_starts_with: "telegram." } },
  ],
};
