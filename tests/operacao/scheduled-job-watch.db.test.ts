import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { createBoss } from "@/src/infra/boss";
import {
  scheduledJobToleranceMinutes,
  staleScheduledQueues,
  watchScheduledJobs,
} from "@/src/services/ops/scheduled-job-watch";
import { createTestDb, type TestDb } from "../helpers/db";

const DIARIA = "teste.vigia_diaria";
const FREQUENTE = "teste.vigia_frequente";

let db: TestDb;
let boss: PgBoss;

beforeAll(async () => {
  db = createTestDb();
  boss = createBoss({ producerOnly: true });
  await boss.start();
});

afterAll(async () => {
  for (const fila of [DIARIA, FREQUENTE]) await boss.deleteQueue(fila);
  await boss.stop({ graceful: false });
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  for (const fila of [DIARIA, FREQUENTE]) {
    await boss.deleteQueue(fila);
    await boss.createQueue(fila);
  }
});

/** Um job concluído da fila, `minutos` atrás. */
async function concluido(fila: string, minutos: number): Promise<void> {
  const id = await boss.send(fila, null);
  await db.prisma.$executeRawUnsafe(
    `UPDATE pgboss.job SET state = 'completed', completed_on = now() - make_interval(mins => $2::int) WHERE id = $1::uuid`,
    id, minutos,
  );
}

async function filaCriadaHa(fila: string, minutos: number): Promise<void> {
  await db.prisma.$executeRawUnsafe(
    `UPDATE pgboss.queue SET created_on = now() - make_interval(mins => $2::int) WHERE name = $1`, fila, minutos,
  );
}

const agenda = [{ queue: DIARIA, maxGapMinutes: 1440 }, { queue: FREQUENTE, maxGapMinutes: 5 }];

describe("tolerância do vigia", () => {
  it("é o intervalo do cron mais uma folga de 15 min a 1 h", () => {
    expect(scheduledJobToleranceMinutes(1)).toBe(16);
    expect(scheduledJobToleranceMinutes(5)).toBe(20);
    expect(scheduledJobToleranceMinutes(120)).toBe(180);
    expect(scheduledJobToleranceMinutes(1440)).toBe(1500);
  });

  it("logo depois do boot a fila atrasada não abre aviso novo, mas continua atrasada", () => {
    const agora = new Date("2026-09-23T12:00:00Z");
    const semRodarHaTresDias = [{ name: DIARIA, createdOn: new Date("2026-09-01T00:00:00Z"),
      lastCompletedAt: new Date("2026-09-20T06:50:00Z") }];
    const atrasadas = (bootedAt: Date | null) => staleScheduledQueues(agenda, semRodarHaTresDias, agora, bootedAt)
      .map((item) => ({ queue: item.queue, raise: item.raise }));
    // Boot há 10 min: o disparo de recuperação ainda tem chance de sair.
    expect(atrasadas(new Date("2026-09-23T11:50:00Z"))).toEqual([{ queue: DIARIA, raise: false }]);
    expect(atrasadas(null)).toEqual([{ queue: DIARIA, raise: true }]);
    // Passada a carência (até 1 h), o atraso de antes do boot alarma.
    expect(atrasadas(new Date("2026-09-23T10:59:00Z"))).toEqual([{ queue: DIARIA, raise: true }]);
    expect(atrasadas(new Date("2026-09-19T00:00:00Z"))).toEqual([{ queue: DIARIA, raise: true }]);
  });

  it("fila que nunca concluiu conta desde a criação; fila não registrada fica de fora", () => {
    const agora = new Date("2026-09-23T12:00:00Z");
    const stale = staleScheduledQueues(agenda, [
      { name: FREQUENTE, createdOn: new Date("2026-09-23T11:50:00Z"), lastCompletedAt: null },
    ], agora);
    expect(stale).toEqual([]);
    expect(staleScheduledQueues(agenda, [
      { name: FREQUENTE, createdOn: new Date("2026-09-23T11:00:00Z"), lastCompletedAt: null },
    ], agora).map((item) => item.queue)).toEqual([FREQUENTE]);
  });
});

describe("vigia das tarefas agendadas (Postgres e pg-boss reais)", () => {
  it("abre uma ação para a fila que parou de concluir e fecha quando ela volta", async () => {
    await filaCriadaHa(DIARIA, 3 * 24 * 60);
    await filaCriadaHa(FREQUENTE, 3 * 24 * 60);
    await concluido(DIARIA, 60);
    await concluido(FREQUENTE, 45);

    expect((await watchScheduledJobs(agenda)).stale).toEqual([FREQUENTE]);
    const aberta = await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: FREQUENTE } });
    expect(aberta).toMatchObject({ status: "OPEN", title: `Tarefa agendada parada: ${FREQUENTE}` });
    expect(aberta.description).toContain("Última conclusão há 45 min.");

    // Rodar de novo não abre outra ação nem reenvia o aviso.
    await watchScheduledJobs(agenda);
    expect(await db.prisma.operationalAction.count({ where: { resourceId: FREQUENTE } })).toBe(1);

    await concluido(FREQUENTE, 1);
    expect((await watchScheduledJobs(agenda)).stale).toEqual([]);
    expect(await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: FREQUENTE } }))
      .toMatchObject({ status: "RESOLVED" });
  });

  it("a ação de fila parada sobrevive ao boot e não abre outra durante a carência", async () => {
    await filaCriadaHa(FREQUENTE, 3 * 24 * 60);
    await concluido(FREQUENTE, 45);
    expect((await watchScheduledJobs(agenda)).stale).toEqual([FREQUENTE]);

    // Deploy: o worker acabou de subir, e a diária, que nunca concluiu, já estava atrasada.
    await filaCriadaHa(DIARIA, 3 * 24 * 60);
    const bootedAt = new Date(Date.now() - 5 * 60_000);
    expect((await watchScheduledJobs(agenda, { bootedAt })).stale).toEqual([DIARIA, FREQUENTE]);
    expect(await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: FREQUENTE } }))
      .toMatchObject({ status: "OPEN" });
    // A diária atrasou antes do boot, mas só avisa depois da carência.
    expect(await db.prisma.operationalAction.count({ where: { resourceId: DIARIA } })).toBe(0);
  });

  it("o aviso de disparo perdido não fecha sozinho sem uma conclusão depois da falha", async () => {
    await concluido(DIARIA, 20 * 60);
    await db.prisma.auditEvent.create({ data: {
      actor: "system", action: "job.dlq_tick_discarded", resource: DIARIA, resourceId: "tique-diario",
      createdAt: new Date(Date.now() - 7 * 60 * 60_000),
    } });
    await db.prisma.operationalAction.create({ data: {
      fingerprint: (await import("@/src/services/ops/operational-actions")).operationalActionFingerprint("jobs.scheduled-failure", DIARIA),
      area: "incidentes", actionType: "incident.review", title: "não rodou", description: "x",
      resource: "pgboss-queue", resourceId: DIARIA, lastSeenAt: new Date(),
    } });

    expect((await watchScheduledJobs(agenda)).failing).toEqual([DIARIA]);
    expect(await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: DIARIA } }))
      .toMatchObject({ status: "OPEN" });
  });

  it("o aviso de falha repetida fecha quando a fila conclui depois da última falha", async () => {
    await concluido(FREQUENTE, 2);
    await db.prisma.auditEvent.create({ data: {
      actor: "system", action: "job.dlq_tick_discarded", resource: FREQUENTE, resourceId: "tique-1",
    } });
    await db.prisma.operationalAction.create({ data: {
      fingerprint: (await import("@/src/services/ops/operational-actions")).operationalActionFingerprint("jobs.scheduled-failure", FREQUENTE),
      area: "incidentes", actionType: "incident.review", title: "falhando", description: "x",
      resource: "pgboss-queue", resourceId: FREQUENTE, lastSeenAt: new Date(),
    } });

    expect((await watchScheduledJobs(agenda)).failing).toEqual([FREQUENTE]);
    expect(await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: FREQUENTE } }))
      .toMatchObject({ status: "OPEN" });

    await concluido(FREQUENTE, 0);
    expect((await watchScheduledJobs(agenda)).failing).toEqual([]);
    expect(await db.prisma.operationalAction.findFirstOrThrow({ where: { resourceId: FREQUENTE } }))
      .toMatchObject({ status: "RESOLVED" });
  });
});
