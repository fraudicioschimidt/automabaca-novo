import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";

/**
 * "Buscar jogos agora" no card de times: a action enfileira a rodada do
 * pareamento dos catálogos no pg-boss real (a policy `exclusive` da fila é o
 * que segura o duplo clique), e a linha de situação lê as métricas, as
 * ligações e as fichas.
 */
const h = vi.hoisted(() => ({ user: "tester" as string | null, boss: null as PgBoss | null }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => (k === "x-auth-user" ? h.user : null) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/src/infra/boss", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/infra/boss")>()),
  getSharedBoss: async () => h.boss!,
}));

import { createBoss } from "@/src/infra/boss";
import { QUEUES } from "@/src/infra/queue-contract";
import { registerQueue } from "@/src/jobs/queues";
import { effectiveQueueOptions, WORKER_JOBS } from "@/src/jobs/worker-jobs";
import { loadCatalogPairingAction, requestCatalogPairingAction } from "@/app/(painel)/config/actions";
import { getCatalogPairingStatus } from "@/src/services/painel/catalog-pairing";
import { spStartOfTodayUtc } from "@/src/domain/dates";
import { createTestDb, type TestDb } from "../helpers/db";

const Q = QUEUES.teamsCatalogPairing;
let db: TestDb;
let boss: PgBoss;

beforeAll(async () => {
  db = createTestDb();
  boss = createBoss();
  await boss.start();
  const job = WORKER_JOBS.find((item) => item.queue === Q)!;
  await registerQueue(boss, Q, effectiveQueueOptions(job));
  h.boss = boss;
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  await db.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = '${Q}'`);
  h.user = "tester";
});

const queuedJobs = () => db.prisma.$queryRawUnsafe<Array<{ state: string }>>(
  `SELECT state::text FROM pgboss.job WHERE name = '${Q}' AND state IN ('created', 'retry', 'active')`);

describe("requestCatalogPairingAction", () => {
  it("enfileira uma rodada na fila do pareamento e audita com o operador", async () => {
    await expect(requestCatalogPairingAction()).resolves.toEqual({ ok: true, status: "enfileirado" });

    expect(await queuedJobs()).toEqual([{ state: "created" }]);
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "teams.catalog_pairing.request" } });
    expect(audit).toMatchObject({ actor: "tester", resource: "queue", resourceId: Q });
    expect(audit.details).toMatchObject({ enfileirado: true, jobId: expect.any(String) });
  });

  it("não cria outra com uma rodada na fila ou rodando", async () => {
    await requestCatalogPairingAction();
    await expect(requestCatalogPairingAction()).resolves.toEqual({ ok: true, status: "ja_na_fila" });

    // O worker pegou a rodada: rodando também segura o pedido.
    const [job] = await boss.fetch(Q);
    expect(job).toBeDefined();
    await expect(requestCatalogPairingAction()).resolves.toEqual({ ok: true, status: "ja_na_fila" });
    expect(await queuedJobs()).toEqual([{ state: "active" }]);
    const audits = await db.prisma.auditEvent.findMany({ where: { action: "teams.catalog_pairing.request" } });
    expect(audits.map((a) => (a.details as { enfileirado: boolean }).enfileirado).sort()).toEqual([false, false, true]);

    // Terminada, o próximo pedido volta a enfileirar.
    await boss.complete(Q, job!.id);
    await expect(requestCatalogPairingAction()).resolves.toEqual({ ok: true, status: "enfileirado" });
  });

  it("sem sessão é recusada e não enfileira", async () => {
    h.user = null;
    await expect(requestCatalogPairingAction()).rejects.toThrow(/Sessão inválida/);
    await expect(loadCatalogPairingAction()).rejects.toThrow(/Sessão inválida/);
    expect(await queuedJobs()).toEqual([]);
    expect(await db.prisma.auditEvent.count()).toBe(0);
  });
});

describe("situação do pareamento", () => {
  const link = (n: number, kickoffPinnacle: Date, status = "ok") => db.prisma.catalogGameLink.create({ data: {
    sport: "Soccer", pinnacleEventId: `p${n}`, flashscoreMatchId: `f${n}`, kickoffPinnacle, kickoffFlashscore: kickoffPinnacle,
    pinnacleHome: "Azul", pinnacleAway: "Verde", pinnacleLeague: "Liga", flashscoreHome: "Azul", flashscoreAway: "Verde",
    flashscoreHomeTeamId: `fa${n}`, flashscoreAwayTeamId: `fv${n}`, swapped: false, score: 1.9, status,
    lastSeenAt: kickoffPinnacle, lastPairedAt: kickoffPinnacle,
  } });
  const metric = (name: string, occurredAt: Date, stoppedBy: string | null) => db.prisma.operationalMetric.create({
    data: { kind: "action", name, outcome: stoppedBy ? "expected_retry" : "success", occurredAt, labels: { stoppedBy, paired: 3 } },
  });

  it("lê a última rodada, os jogos do dia ligados e as fichas", async () => {
    const now = new Date("2026-09-25T15:00:00Z"); // 12:00 em São Paulo
    const dayStart = spStartOfTodayUtc(now);
    await metric("teams.catalog_pairing", new Date("2026-09-25T11:37:00Z"), null);
    await metric("teams.catalog_pairing", new Date("2026-09-25T14:40:00Z"), "budget");
    // A métrica do próprio pedido (observeAction) não é rodada.
    await metric("teams.catalog_pairing.request", new Date("2026-09-25T14:50:00Z"), null);
    await link(1, new Date(dayStart.getTime() + 60_000));
    await link(2, new Date(dayStart.getTime() + 23 * 3_600_000));
    await link(3, new Date(dayStart.getTime() + 10 * 3_600_000), "conflict");
    await link(4, new Date(dayStart.getTime() - 60_000));
    await link(5, new Date(dayStart.getTime() + 24 * 3_600_000));
    for (const id of ["t1", "t2", "t3"]) {
      await db.prisma.teamCard.create({ data: { sport: "Soccer", flashscoreTeamId: id, flashscoreName: id, category: "principal", lastSeenAt: now } });
    }

    expect(await getCatalogPairingStatus(now)).toEqual({
      lastRound: { at: new Date("2026-09-25T14:40:00Z"), stoppedBy: "budget" },
      linkedToday: 2,
      teamCards: 3,
      inProgress: false,
    });

    await requestCatalogPairingAction();
    expect((await getCatalogPairingStatus(now)).inProgress).toBe(true);
  });

  it("a action devolve a linha pronta para a tela, em São Paulo", async () => {
    const at = new Date();
    await metric("teams.catalog_pairing", at, null);
    const loaded = await loadCatalogPairingAction();
    expect(loaded).toMatchObject({ stoppedBy: null, linkedToday: 0, teamCards: 0, inProgress: false });
    const sp = new Date(at.getTime() - 3 * 3_600_000);
    expect(loaded.lastRound).toBe(`${String(sp.getUTCHours()).padStart(2, "0")}:${String(sp.getUTCMinutes()).padStart(2, "0")}`);
  });

  it("sem rodada registrada, diz que não há", async () => {
    expect((await getCatalogPairingStatus()).lastRound).toBeNull();
    expect((await loadCatalogPairingAction()).lastRound).toBeNull();
  });
});
