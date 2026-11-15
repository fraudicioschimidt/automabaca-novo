import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOSS_DRAIN_TIMEOUT_MS,
  POST_DRAIN_RESERVE_MS,
  WORKER_SHUTDOWN_BUDGET_MS,
} from "@/src/jobs/worker-lifecycle";

/**
 * Portão: a cadeia de encerramento do worker precisa CABER em si mesma.
 *
 * São três esperas encaixadas — drain do pg-boss ⊂ orçamento do shutdown ⊂
 * `stop_grace_period` do container — e cada uma vive num arquivo diferente.
 * Se o drain pede mais que o orçamento, o `Promise.race` do worker vence antes,
 * SEMPRE, e o processo morre no meio do drain — sem soltar o lock singleton e
 * sem fechar Prisma e pool, que é precisamente o que o orçamento existe para
 * garantir.
 *
 * O defeito é invisível em teste de unidade porque cada constante, sozinha, é
 * plausível; e é raro em produção porque só aparece quando o drain realmente
 * demora. Um teste que fixa o valor literal grava o número errado em vez de
 * conferir a relação.
 *
 * Por isso o portão afirma a ORDEM, não os valores: mexer em qualquer um dos
 * três sem mexer nos outros reprova aqui.
 */

const RAIZ = path.resolve(__dirname, "../..");

/**
 * `stop_grace_period` do worker lido do compose REAL de produção: o tempo que o
 * `docker compose` espera depois do SIGTERM antes do SIGKILL. Ler o arquivo em
 * vez de repetir o número aqui é o que faz o portão enxergar a mudança de quem
 * editar só o compose — a fronteira que ninguém lembra de conferir ao mexer no
 * shutdown.
 */
function stopGraceDoWorkerMs(): number {
  const compose = readFileSync(path.join(RAIZ, "deploy", "compose.yaml"), "utf8");
  const bloco = compose.slice(compose.indexOf("\n  worker:\n"));
  const achado = /^ {4}stop_grace_period:\s*(\d+)s\s*$/m.exec(bloco);
  if (!achado?.[1]) throw new Error("stop_grace_period do worker não encontrado em deploy/compose.yaml");
  return Number(achado[1]) * 1000;
}

describe("orçamento de shutdown do worker", () => {
  it("o drain do pg-boss alcança o próprio limite antes do orçamento estourar", () => {
    expect(
      BOSS_DRAIN_TIMEOUT_MS,
      `drain (${BOSS_DRAIN_TIMEOUT_MS}ms) precisa ser MENOR que o orçamento ` +
        `(${WORKER_SHUTDOWN_BUDGET_MS}ms) — senão o race externo mata o processo no meio dele`,
    ).toBeLessThan(WORKER_SHUTDOWN_BUDGET_MS);
  });

  it("sobra tempo para soltar o lock e fechar o banco depois do drain", () => {
    expect(
      BOSS_DRAIN_TIMEOUT_MS + POST_DRAIN_RESERVE_MS,
      "drain + reserva não podem passar do orçamento: os passos pós-drain " +
        "(lock singleton, Prisma, pool) rodam DEPOIS e não têm teto próprio",
    ).toBeLessThanOrEqual(WORKER_SHUTDOWN_BUDGET_MS);
    expect(POST_DRAIN_RESERVE_MS).toBeGreaterThan(0);
  });

  it("o processo sai sozinho antes do SIGKILL do Docker", () => {
    const killTimeout = stopGraceDoWorkerMs();
    expect(
      WORKER_SHUTDOWN_BUDGET_MS,
      `orçamento (${WORKER_SHUTDOWN_BUDGET_MS}ms) precisa ser MENOR que o ` +
        `stop_grace_period do worker (${killTimeout}ms) — passar disso é SIGKILL e job ` +
        "fica `active` no limbo até expirar",
    ).toBeLessThan(killTimeout);
  });
});
