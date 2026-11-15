import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { getSharedBoss } from "@/src/infra/boss";
import { deadLetterOf, QUEUES } from "@/src/infra/queue-contract";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { getPgBossQueueNames } from "@/src/services/ops/dlq/pgboss-queues";
import { deleteRetiredQueues } from "@/src/services/ops/retired-queues";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Fila que saiu do código continua no pg-boss com os jobs e a dead-letter; o
 * painel a lista e as ações sobre as falhas dela ficam abertas. O script
 * versionado a apaga só quando ninguém mais manda trabalho para ela.
 */

const EXECUTOR = "agent:teste:por:fabricio";
const MOTIVO = "edição de post já capturado; hoje seria ignorada";
/** As fixtures nascem agora; o "agora" do script fica dois dias à frente. */
const LATER = () => new Date(Date.now() + 2 * 24 * 60 * 60_000);

let db: TestDb;
let boss: PgBoss;

beforeAll(async () => {
  db = createTestDb();
  boss = await getSharedBoss();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

/** Fila com a topologia de produção: origem exclusive ligada à dead-letter. */
async function retiredQueue(): Promise<string> {
  const name = `test.aposentada_${randomUUID().slice(0, 8)}`;
  await ensureQueueWithDeadLetter(boss, name, { policy: "exclusive" });
  return name;
}

async function jobIn(queue: string, state: "created" | "completed" | "failed", data: object = {}): Promise<string> {
  const id = await boss.send(queue, data, { startAfter: 3_600 });
  if (!id) throw new Error("fixture sem id");
  if (state !== "created") {
    await db.prisma.$executeRawUnsafe(
      `UPDATE pgboss.job SET state = $2::pgboss.job_state, completed_on = now(),
         output = '{"message":"A aposta possui kickoff provisório."}'::jsonb
       WHERE id = $1::uuid`,
      id, state,
    );
  }
  return id;
}

async function openAction(jobId: string): Promise<string> {
  const action = await db.prisma.operationalAction.create({
    data: {
      fingerprint: `dlq:${jobId}`, area: "filas", actionType: "dlq.replay",
      title: "Post não processado · mensagem 619", description: "recusa de negócio",
      resource: "pgboss-job", resourceId: jobId,
    },
  });
  return action.id;
}

async function queueExists(name: string): Promise<boolean> {
  return (await boss.getQueue(name)) !== null;
}

async function jobsOf(names: string[]): Promise<number> {
  const rows = await db.prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pgboss.job WHERE name = ANY(${names}::text[])`;
  return rows[0]?.n ?? 0;
}

describe("apagar fila que saiu do código", () => {
  it("simula sem mudar nada; aplicada, apaga filas e jobs, fecha as ações e audita; de novo, nada a fazer", async () => {
    const fila = await retiredQueue();
    const dlq = deadLetterOf(fila);
    await jobIn(fila, "completed");
    const failedSource = await jobIn(fila, "failed", { kind: "edited_channel_post" });
    const failedDlq = await jobIn(dlq, "failed", { kind: "edited_channel_post" });
    const action = await openAction(failedDlq);
    // Ação de outra fila não é tocada.
    const other = await retiredQueue();
    const otherJob = await jobIn(deadLetterOf(other), "failed");
    const otherAction = await openAction(otherJob);

    const plano = await deleteRetiredQueues({ filas: [fila], motivo: MOTIVO, executor: EXECUTOR, aplicar: false, now: LATER() });
    expect(plano.aplicado).toBe(false);
    expect(plano.filas).toEqual([expect.objectContaining({
      fila, estado: "apagar", deadLetter: dlq, falhasTotal: 2,
      jobs: { [fila]: { completed: 1, failed: 1 }, [dlq]: { failed: 1 } },
      acoesAbertas: [{ id: action, titulo: "Post não processado · mensagem 619" }],
    })]);
    expect(plano.filas[0]?.falhas.map((falha) => falha.id).sort()).toEqual([failedSource, failedDlq].sort());
    expect(plano.filas[0]?.falhas[0]?.erro).toBe("A aposta possui kickoff provisório.");
    expect(await queueExists(fila)).toBe(true);
    expect(await jobsOf([fila, dlq])).toBe(3);

    const aplicado = await deleteRetiredQueues({ filas: [fila], motivo: MOTIVO, executor: EXECUTOR, aplicar: true, now: LATER() });
    expect(aplicado.aplicado).toBe(true);
    expect(await queueExists(fila)).toBe(false);
    expect(await queueExists(dlq)).toBe(false);
    expect(await jobsOf([fila, dlq])).toBe(0);
    // O painel lê as dead-letters de `pgboss.queue`: a fila apagada some de lá.
    expect((await getPgBossQueueNames()).deadLetters).not.toContain(dlq);

    const fechada = await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: action } });
    expect(fechada.status).toBe("RESOLVED");
    expect(fechada.resolutionNote).toContain(MOTIVO);
    expect((await db.prisma.operationalAction.findUniqueOrThrow({ where: { id: otherAction } })).status).toBe("OPEN");
    expect(await queueExists(other)).toBe(true);

    const auditoria = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "pgboss_queue.delete", resourceId: fila } });
    expect(auditoria.actor).toBe(EXECUTOR);
    expect(auditoria.details).toMatchObject({ deadLetter: dlq, falhasDescartadas: 2, acoesFechadas: [action], motivo: MOTIVO });
    expect(await db.prisma.auditEvent.count({
      where: { actor: EXECUTOR, action: "operational_action.auto_resolved", resourceId: action },
    })).toBe(1);

    const segunda = await deleteRetiredQueues({ filas: [fila], motivo: MOTIVO, executor: EXECUTOR, aplicar: true, now: LATER() });
    expect(segunda).toEqual({ aplicado: false, filas: [expect.objectContaining({ fila, estado: "ausente" })] });
  });

  it("fila com job por rodar é recusada, e nenhuma das pedidas é apagada", async () => {
    const pendente = await retiredQueue();
    await jobIn(pendente, "created");
    const limpa = await retiredQueue();
    await jobIn(limpa, "completed");

    const resultado = await deleteRetiredQueues({
      filas: [pendente, limpa], motivo: MOTIVO, executor: EXECUTOR, aplicar: true, now: LATER(),
    });
    expect(resultado.aplicado).toBe(false);
    expect(resultado.filas.map((fila) => [fila.fila, fila.estado])).toEqual([[pendente, "recusada"], [limpa, "apagar"]]);
    expect(resultado.filas[0]?.recusa).toMatch(/ainda por rodar/);
    expect(await queueExists(pendente)).toBe(true);
    expect(await queueExists(limpa)).toBe(true);
    expect(await db.prisma.auditEvent.count({ where: { action: "pgboss_queue.delete" } })).toBe(0);
  });

  it("fila que recebeu job nas últimas 24 h é recusada: alguém ainda manda trabalho para ela", async () => {
    const fila = await retiredQueue();
    await jobIn(fila, "completed");

    const resultado = await deleteRetiredQueues({ filas: [fila], motivo: MOTIVO, executor: EXECUTOR, aplicar: true });
    expect(resultado.aplicado).toBe(false);
    expect(resultado.filas[0]).toMatchObject({ estado: "recusada", recusa: expect.stringMatching(/menos de 24 h/) });
    expect(await queueExists(fila)).toBe(true);
  });

  it("não aceita fila do contrato, dead-letter no lugar da origem nem motivo vazio", async () => {
    const base = { motivo: MOTIVO, executor: EXECUTOR, aplicar: false };
    await expect(deleteRetiredQueues({ ...base, filas: [QUEUES.telegramUpdates] })).rejects.toThrow(/contrato/);
    await expect(deleteRetiredQueues({ ...base, filas: ["test.qualquer.dlq"] })).rejects.toThrow(/dead-letter/);
    await expect(deleteRetiredQueues({ ...base, filas: ["test.qualquer"], motivo: " " })).rejects.toThrow(/motivo/);
    // O ator que a revisão de escritas não reconhece apareceria como escrita sem autor.
    await expect(deleteRetiredQueues({ ...base, filas: ["test.qualquer"], executor: "agent:x:por:fabricio" }))
      .rejects.toThrow(/agent:<nome>:por:<dono>/);
  });
});
