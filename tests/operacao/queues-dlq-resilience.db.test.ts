import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { createBoss } from "@/src/infra/boss";
import { deadLetterOf, QUEUES } from "@/src/infra/queue-contract";
import { registerQueue } from "@/src/jobs/queues";
import { sendOperationalAlert, sendOperatorNotification } from "@/src/services/ops/alerts";
import { createTestDb, type TestDb } from "../helpers/db";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { enrichSingletonKey } from "@/src/infra/queue-contract";
import { SportNotConfirmedError } from "@/src/services/bets/settle";

vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: vi.fn().mockResolvedValue(true),
  sendOperatorNotification: vi.fn().mockResolvedValue(true),
}));

let boss: PgBoss;
let db: TestDb;

beforeAll(async () => {
  db = createTestDb();
  boss = createBoss();
  await boss.start();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  vi.clearAllMocks();
});

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout esperando condição");
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("DLQ Watcher transient error resilience", () => {
  it("bloqueio de esporte preserva singletonKey no requeue exclusive", async () => {
    const fila = `teste.sport-blocked.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
    const singletonKey = "telegram-retry:sport-blocked";
    const payload = { kind: "edited_channel_post", messageId: 42 };

    await registerQueue(boss, fila, {
      retryLimit: 0,
      retryDelay: 1,
      policy: "exclusive",
    });
    await boss.work(fila, { pollingIntervalSeconds: 1 }, async () => {
      throw new SportNotConfirmedError("bet-sport-blocked");
    });
    await boss.send(fila, payload, { singletonKey });

    await waitFor(async () => {
      return Boolean(await db.prisma.auditEvent.findFirst({
        where: { action: "job.dlq_requeue", resource: fila },
      }));
    }, 20_000);

    const rows = await db.prisma.$queryRaw<Array<{ singletonKey: string | null }>>`
      SELECT singleton_key AS "singletonKey"
      FROM pgboss.job
      WHERE name = ${fila}
        AND state IN ('created', 'retry')
      ORDER BY created_on DESC
      LIMIT 1
    `;
    expect(rows[0]?.singletonKey).toBe(singletonKey);
    expect(sendOperationalAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["fetch failed"],
    ["BridgeOdds query falhou: HTTP 429"],
    ['CircuitOpenError: Circuit breaker aberto para "bridgeodds"'],
  ])(
    "erro transitório (%s) → requeue +2h e alerta INFO (não falha dura)",
    async (message) => {
      const fila = `teste.transient.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;

      await registerQueue(boss, fila, {
        retryLimit: 0,
        retryDelay: 1,
      });

      await boss.work(fila, { pollingIntervalSeconds: 1 }, async () => {
        throw new Error(message);
      });

      await boss.send(fila, { betId: "bet-resilience-1" });

      await waitFor(async () => {
        const row = await db.prisma.auditEvent.findFirst({
          where: { action: "job.dlq_requeue", resource: fila },
        });
        return row !== null;
      }, 20_000);

      const audit = await db.prisma.auditEvent.findFirst({
        where: { action: "job.dlq_requeue", resource: fila },
      });
      expect(audit).toBeTruthy();
      expect(audit!.details).toMatchObject({
        errorMsg: expect.stringContaining(message),
        startAfterSeconds: 7200,
      });
      const calls = (sendOperatorNotification as unknown as { mock: { calls: string[][] } }).mock
        .calls;
      expect(calls.every((c) => !String(c[0]).includes("esgotou as tentativas"))).toBe(true);
      expect(calls.some((c) => String(c[0]).includes("Tarefa adiada"))).toBe(true);
    },
    30_000,
  );

  it("erro de lógica → alerta dura sem requeue", async () => {
    const fila = `teste.logic.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
    const onDeadLetter = vi.fn().mockResolvedValue(undefined);

    await registerQueue(boss, fila, {
      retryLimit: 0,
      retryDelay: 1,
      onDeadLetter,
    });

    await boss.work(fila, { pollingIntervalSeconds: 1 }, async () => {
      throw new Error("erro de logica gravíssimo");
    });

    // Aposta REAL: erro de negócio só é retido quando o trabalho ainda tem
    // assunto. Com um id inventado o handler descarta — e com razão, já
    // que replay de aposta inexistente só pode falhar de novo.
    const bankrollLogica = await db.prisma.bankroll.create({
      data: { nome: "DLQ", slug: `dlq-logica-${Date.now()}`, sharpMode: "CLV_ONLY" },
    });
    const betLogica = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankrollLogica.id,
        data: new Date("2026-08-10T18:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 1.9,
        stake: 1,
      },
    });
    await boss.send(fila, { betId: betLogica.id });

    await waitFor(async () => {
      return (
        (sendOperatorNotification as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0
      );
    }, 20_000);

    // NOTIFICA, não abre ação: a linha da caixa é do coletor `dlq`, que lê a
    // fila direto. Abrir aqui também dava duas linhas para o mesmo job.
    expect(sendOperatorNotification).toHaveBeenCalledWith(
      expect.stringContaining("Erro: erro de logica gravíssimo"),
    );
    expect(sendOperationalAlert).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: "jobs.dead-letter" }),
    );
    const requeue = await db.prisma.auditEvent.findFirst({
      where: { action: "job.dlq_requeue", resource: fila },
    });
    expect(requeue).toBeNull();
    await waitFor(() => onDeadLetter.mock.calls.length > 0, 10_000);
    expect(onDeadLetter).toHaveBeenCalled();
  });

  it("4º requeue transitório → alerta dura + onDeadLetter (sem 4º audit)", async () => {
    const fila = `teste.exhaust.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
    const onDeadLetter = vi.fn().mockResolvedValue(undefined);
    const payload = { betId: "bet-exhaust-4" };
    const payloadKey = canonicalSha256(payload);

    for (let i = 0; i < 3; i++) {
      await db.prisma.auditEvent.create({
        data: {
          actor: "system",
          action: "job.dlq_requeue",
          resource: fila,
          resourceId: payloadKey,
          details: { prior: i },
        },
      });
    }

    await registerQueue(boss, fila, {
      retryLimit: 0,
      retryDelay: 1,
      onDeadLetter,
    });

    await boss.work(fila, { pollingIntervalSeconds: 1 }, async () => {
      throw new Error("BridgeOdds query falhou: HTTP 429");
    });

    await boss.send(fila, payload);

    await waitFor(() => onDeadLetter.mock.calls.length > 0, 20_000);
    expect(sendOperatorNotification).toHaveBeenCalledWith(
      expect.stringContaining("esgotou as tentativas"),
    );
    expect(
      await db.prisma.auditEvent.count({
        where: { action: "job.dlq_requeue", resource: fila },
      }),
    ).toBe(3);
  });

  it("requeue recusado por dedupe NÃO vira pedido de intervenção manual", async () => {
    // Fila `exclusive` + chave: se o mesmo trabalho já está agendado, o `send`
    // devolve null. Isso é o requeue tendo sucesso por outro caminho, não
    // falha — tratar como falha abriria ação com autoResolve false, que fica
    // na caixa até alguém fechar na mão.
    // Precisa ser a fila canônica: é dela que o handler tira o `betId` para
    // montar a chave, e é ela que roda `exclusive` em produção.
    const fila = QUEUES.sharpEnrich;
    await boss.deleteQueue(fila).catch(() => undefined);
    await boss.deleteQueue(deadLetterOf(fila)).catch(() => undefined);

    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "DLQ", slug: `dlq-dedupe-${Date.now()}`, sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date("2026-08-10T18:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 1.9,
        stake: 1,
      },
    });
    const payload = { betId: bet.id };

    await registerQueue(boss, fila, { retryLimit: 0, retryDelay: 1, policy: "exclusive" });
    // Ocupa a chave que o requeue vai tentar usar.
    await boss.send(fila, payload, {
      singletonKey: enrichSingletonKey(bet.id),
      startAfter: 3_600,
    });

    await boss.work(fila, { pollingIntervalSeconds: 1 }, async () => {
      throw new Error("fetch failed");
    });
    // Sem chave: entra ao lado do job acima (chave vazia ≠ chave ocupada).
    await boss.send(fila, payload);

    await waitFor(async () => {
      const row = await db.prisma.auditEvent.findFirst({
        where: { action: "job.dlq_requeue", resource: fila },
      });
      return row !== null;
    }, 20_000);

    const audit = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "job.dlq_requeue", resource: fila },
    });
    expect(audit.details).toMatchObject({ deduplicado: true, requeuedJobId: null });
    const alertas = (sendOperationalAlert as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.stringify(alertas)).not.toContain("Falha ao reenfileirar");
  });

  it("tip settled → sem requeue nem onDeadLetter", async () => {
    const fila = QUEUES.sharpEnrich;
    const onDeadLetter = vi.fn().mockResolvedValue(undefined);

    // A fila canônica pode ter sido criada com outra policy por um arquivo
    // anterior no mesmo banco do worker. Este cenário precisa ser autônomo.
    await boss.deleteQueue(fila).catch(() => undefined);
    await boss.deleteQueue(deadLetterOf(fila)).catch(() => undefined);

    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "DLQ", slug: `dlq-settled-${Date.now()}`, sharpMode: "CLV_ONLY" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: new Date("2026-07-09T15:00:00Z"),
        bankrollId: bankroll.id,
        data: new Date("2026-07-09T15:00:00Z"),
        evento: "A vs B",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "A",
        odds: 1.9,
        stake: 1,
        status: "WON",
      },
    });
    const payload = { betId: bet.id };

    await registerQueue(boss, fila, {
      retryLimit: 0,
      retryDelay: 1,
      onDeadLetter,
    });

    await boss.work(fila, { pollingIntervalSeconds: 1 }, async () => {
      throw new Error("fetch failed");
    });

    const jobId = await boss.send(fila, payload);
    expect(jobId).not.toBeNull();

    await waitFor(async () => {
      const calls = (sendOperatorNotification as unknown as { mock: { calls: string[][] } }).mock
        .calls;
      return calls.some((c) => String(c[0]).includes("não precisa repetir"));
    }, 20_000);

    expect(
      await db.prisma.auditEvent.count({
        where: { action: "job.dlq_requeue", resource: fila },
      }),
    ).toBe(0);
    expect(onDeadLetter).not.toHaveBeenCalled();
  });
});
