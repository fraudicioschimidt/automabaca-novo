import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss } from "@/src/infra/boss";
import { prisma } from "@/src/infra/prisma";
import { ensureQueueWithDeadLetter, registerQueue } from "@/src/jobs/queues";
import { listRecentPgBossFailures } from "@/src/services/ops/dlq/pgboss-queues";
import { listDeadLetters } from "@/src/services/ops/dlq/replay";
import type { PgBoss } from "pg-boss";

/**
 * Dead-letter contra pg-boss REAL: garante que o tratamento extra
 * `onDeadLetter` RODA quando um job esgota os retries — é o elo que liga o
 * enrich esgotado à fila humana (UNMATCHED), e morto ele não dá sinal.
 */

let boss: PgBoss;

beforeAll(async () => {
  boss = createBoss();
  await boss.start();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await prisma.$disconnect();
});

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout esperando condição");
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("registerQueue + dead-letter (pg-boss real)", () => {
  it("criar a topologia NÃO liga consumidor; registerQueue liga", async () => {
    // Contrato que sustenta o portão `tests/operacao/fixture-de-dlq-vs-watcher.test.ts`:
    // quem só precisa da fila não pode ganhar um worker de brinde. Se
    // `ensureQueueWithDeadLetter` passar a chamar `boss.work`, o portão
    // estático continuaria verde (ninguém escreveu `registerQueue`) e a corrida
    // pela dead-letter em `active` apareceria calada. Aqui ela reprova.
    const fila = `teste.topologia.${Date.now()}`;
    const dlq = await ensureQueueWithDeadLetter(boss, fila);
    expect(boss.getWipData().map((w) => w.name)).not.toContain(dlq);

    await registerQueue(boss, fila);
    expect(boss.getWipData().map((w) => w.name)).toContain(dlq);
    await boss.offWork(dlq);
  });

  it("job que esgota retries dispara onDeadLetter com o payload original", async () => {
    const fila = `teste.dlq.${Date.now()}`;
    const recebidos: unknown[] = [];

    await registerQueue(boss, fila, {
      retryLimit: 0,
      onDeadLetter: async (data) => {
        recebidos.push(data);
      },
    });
    await boss.work(fila, { pollingIntervalSeconds: 1 }, async () => {
      throw new Error("falha proposital");
    });

    // Payload sem `betId`: aqui o alvo é a maquinaria genérica da DLQ. Um
    // `betId` inventado faria o handler descartar o job (aposta inexistente),
    // testando outra coisa.
    await boss.send(fila, { itemId: "item-teste-123" });

    await waitFor(() => recebidos.length > 0, 20_000);
    expect(recebidos[0]).toEqual({ itemId: "item-teste-123" });
    await waitFor(async () => {
      const retained = await prisma.auditEvent.count({
        where: { action: "job.dlq_retained", resource: fila },
      });
      return retained === 1;
    }, 10_000);
    // O handler grava a auditoria e chama `onDeadLetter` ainda dentro do
    // callback do job DLQ. O pg-boss só muda active -> failed DEPOIS que esse
    // callback termina; ler imediatamente após a auditoria cria uma corrida sob
    // carga. Aguarda o estado que o contrato realmente promete.
    await waitFor(async () => {
      const rows = await prisma.$queryRaw<Array<{ state: string }>>`
        SELECT state::text AS state FROM pgboss.job
        WHERE name = ${`${fila}.dlq`}
        ORDER BY created_on DESC
        LIMIT 1
      `;
      return rows[0]?.state === "failed";
    }, 10_000);

    const dlq = (await listDeadLetters(200, null)).find((row) => row.fila === fila);
    expect(dlq?.erro).toContain("falha proposital");
    expect(dlq?.erro).not.toContain("retida para replay manual");
  });

  it("dead-letter que o watcher ainda não tratou já aparece com a causa da origem", async () => {
    const fila = `teste.dlq.espera.${Date.now()}`;
    // Só a topologia: sem watcher, a cópia fica em `created`, como no intervalo
    // entre a falha e o tratamento (ou com o worker parado).
    const deadLetter = await ensureQueueWithDeadLetter(boss, fila, { retryLimit: 0 });
    await boss.work(fila, { pollingIntervalSeconds: 1 }, async () => {
      throw new Error("fetch failed na origem");
    });
    await boss.send(fila, { itemId: "item-em-espera" });

    await waitFor(async () => {
      const rows = await prisma.$queryRaw<Array<{ state: string }>>`
        SELECT state::text AS state FROM pgboss.job WHERE name = ${deadLetter}
      `;
      return rows[0]?.state === "created";
    }, 20_000);
    await boss.offWork(fila);

    const naCaixa = (await listDeadLetters(200, null)).find((row) => row.fila === fila);
    expect(naCaixa?.erro).toContain("fetch failed na origem");

    const falhas = (await listRecentPgBossFailures(new Date(Date.now() - 60_000), 500))
      .filter((row) => row.name === deadLetter);
    expect(falhas).toEqual([
      expect.objectContaining({ output: expect.objectContaining({ message: "fetch failed na origem" }) }),
    ]);
  });
});
