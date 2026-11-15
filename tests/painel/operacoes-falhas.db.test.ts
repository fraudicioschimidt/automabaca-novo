import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../helpers/db";
import { getSharedBoss } from "@/src/infra/boss";
import { deadLetterOf, QUEUES } from "@/src/infra/queue-contract";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { countActiveDeadLetters } from "@/src/services/ops/dlq/pgboss-queues";
import { replayDeadLetter } from "@/src/services/ops/dlq/replay";
import { recordDeadLetterRetained } from "@/src/services/ops/dlq/repository";
import { getJobFailures } from "@/src/services/painel/operacoes/falhas";

/**
 * O pg-boss real: ao esgotar as tentativas ele reinsere o job de origem como
 * `failed` E cria a cópia na dead-letter, então cada falha existe em duas
 * linhas. O cartão mostra uma, e o veredito conta só o que segue retido.
 */

let db: TestDb;
let boss: PgBoss;
const QUEUE = QUEUES.sharpEnrich;
const DLQ = deadLetterOf(QUEUE);

beforeAll(async () => {
  db = createTestDb();
  boss = await getSharedBoss();
  // Topologia sem o watcher: a retenção é feita à mão, no passo exato.
  await ensureQueueWithDeadLetter(boss, QUEUE);
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});

async function clearFileJobs(): Promise<void> {
  await db.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name IN ('${QUEUE}', '${DLQ}')`);
}

beforeEach(async () => {
  await db.reset();
  await clearFileJobs();
});

afterEach(clearFileJobs);

async function queueGroups() {
  const falhas = await getJobFailures();
  return {
    retidas: falhas.retidas,
    grupos: falhas.grupos
      .filter((grupo) => grupo.fila === QUEUE || grupo.fila === DLQ)
      .map((grupo) => ({ fila: grupo.fila, causa: grupo.causa, n: grupo.n, replayable: grupo.replayable })),
  };
}

describe("getJobFailures (pg-boss real)", () => {
  it("falha retida aparece uma vez, com a causa real; depois do Replay vira histórico e sai do veredito", async () => {
    const base = await countActiveDeadLetters();
    const erro = { name: "Error", message: "Aposta bet-falha not found" };
    await boss.send(QUEUE, { betId: "bet-falha" }, { retryLimit: 0 });
    const [job] = await boss.fetch(QUEUE);
    await boss.fail(QUEUE, job!.id, erro);

    // Antes do watcher: a origem `failed` e a cópia na dead-letter são a mesma falha.
    expect((await queueGroups()).grupos).toEqual([
      { fila: DLQ, causa: "regra_de_negocio", n: 1, replayable: true },
    ]);

    // O watcher retém: falha a cópia com o sentinela e guarda a causa na auditoria.
    const [copia] = await boss.fetch(DLQ);
    await boss.fail(DLQ, copia!.id, { name: "Error", message: `Dead-letter ${copia!.id} retida para replay manual.` });
    await recordDeadLetterRetained({
      queue: QUEUE, jobId: copia!.id, errorMessage: erro.message, classification: "business",
    });
    const retida = await queueGroups();
    expect(retida.grupos).toEqual([{ fila: DLQ, causa: "regra_de_negocio", n: 1, replayable: true }]);
    expect(retida.retidas).toBe(base + 1);

    // A retida é trabalho pendente de qualquer idade: o cartão a mostra enquanto o veredito a conta.
    await db.prisma.$executeRawUnsafe(
      `UPDATE pgboss.job SET created_on = now() - interval '30 days' WHERE name = '${DLQ}'`,
    );
    expect((await queueGroups()).grupos).toEqual([{ fila: DLQ, causa: "regra_de_negocio", n: 1, replayable: true }]);

    await replayDeadLetter(copia!.id, "ui");
    const tratada = await queueGroups();
    expect(tratada.grupos).toEqual([{ fila: QUEUE, causa: "regra_de_negocio", n: 1, replayable: false }]);
    expect(tratada.retidas).toBe(base);
  });
});
