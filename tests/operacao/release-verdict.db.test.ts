import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { createBoss } from "@/src/infra/boss";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { getRecentReleases, judgePendingReleases, recordReleaseReady } from "@/src/services/ops/release-verdict";
import { createTestDb, type TestDb } from "../helpers/db";

const QUEUE = "teste.veredito_captura";
const OTHER_QUEUE = "teste.veredito_fechamento";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

let db: TestDb;
let boss: PgBoss;
const originalToken = process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
const originalChatId = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;

beforeAll(async () => {
  process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_NOTIFICATION_CHAT_ID = "123";
  resetEnvCacheForTests();
  db = createTestDb();
  boss = createBoss({ producerOnly: true });
  await boss.start();
});

afterAll(async () => {
  for (const queue of [QUEUE, OTHER_QUEUE]) await boss.deleteQueue(queue);
  await boss.stop({ graceful: false });
  if (originalToken === undefined) delete process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
  else process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = originalToken;
  if (originalChatId === undefined) delete process.env.TELEGRAM_NOTIFICATION_CHAT_ID;
  else process.env.TELEGRAM_NOTIFICATION_CHAT_ID = originalChatId;
  resetEnvCacheForTests();
  await db.dispose();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.reset();
  vi.unstubAllGlobals();
  for (const queue of [QUEUE, OTHER_QUEUE]) {
    await boss.deleteQueue(queue);
    await boss.createQueue(queue);
  }
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** Release que ficou pronta um minuto depois do boot. */
async function release(releaseId: string, sha: string, bootMinutesAgo: number) {
  const bootedAt = minutesAgo(bootMinutesAgo);
  expect(await recordReleaseReady({ releaseId, sha, bootedAt, readyAt: new Date(bootedAt.getTime() + 60_000) }))
    .toBe("recorded");
}

/** Job que falhou com o erro, como o pg-boss o guarda. */
async function failedJob(queue: string, error: Record<string, unknown>, state: "retry" | "failed" = "retry"): Promise<string> {
  const id = await boss.send(queue, { teste: true });
  if (!id) throw new Error("job não criado");
  await db.prisma.$executeRawUnsafe(
    `UPDATE pgboss.job SET state = $2::pgboss.job_state, output = $3::jsonb, started_on = now() WHERE id = $1::uuid`,
    id, state, JSON.stringify({ ...error, stack: `${String(error.name)}: ${String(error.message)}\n    at handler (worker.js:1:1)` }),
  );
  return id;
}

/** Uma tentativa que falhou, na release que a rodou. */
async function attempt(queue: string, jobId: string, releaseId: string, minutes: number, errorName?: string) {
  await db.prisma.operationalMetric.create({
    data: {
      kind: "queue",
      name: queue,
      outcome: "error",
      labels: { releaseId, jobId, releaseSha: "x", ...(errorName ? { error: errorName } : {}) },
      occurredAt: minutesAgo(minutes),
    },
  });
}

async function verdictOf(releaseId: string) {
  const row = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "release.verdict", resourceId: releaseId } });
  return row.details as Record<string, unknown>;
}

function telegramOk() {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const sentTexts = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([, init]) => (
  JSON.parse(String((init as RequestInit).body)) as { text: string }
).text);

describe("registro da release pronta", () => {
  it("grava uma vez por release, com a anterior, e ignora o que não é release publicada", async () => {
    await release("auto-aaaaaaa", SHA_A, 120);
    const bootedAt = minutesAgo(30);
    expect(await recordReleaseReady({ releaseId: "auto-bbbbbbb", sha: SHA_B, bootedAt })).toBe("recorded");
    // Restart da mesma release não abre outra observação.
    expect(await recordReleaseReady({ releaseId: "auto-bbbbbbb", sha: SHA_B, bootedAt: minutesAgo(5) })).toBe("already_recorded");
    expect(await recordReleaseReady({ releaseId: "development", sha: "development", bootedAt })).toBe("not_a_release");

    const rows = await db.prisma.auditEvent.findMany({ where: { action: "release.ready" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => row.resourceId)).toEqual(["auto-aaaaaaa", "auto-bbbbbbb"]);
    expect(rows[1]?.details).toMatchObject({
      releaseId: "auto-bbbbbbb", sha: SHA_B, bootedAt: bootedAt.toISOString(), previousSha: SHA_A,
    });
  });
});

describe("veredito das releases (Postgres e pg-boss reais)", () => {
  it("aponta o erro novo na release que o trouxe, avisa uma vez e não repete na seguinte", async () => {
    // Antes das releases: um erro que já acontecia.
    const old = await failedJob(QUEUE, { name: "Error", message: "Aposta 123 sem esporte confirmado pela regra" }, "failed");
    await attempt(QUEUE, old, "auto-velha", 200);

    await release("auto-aaaaaaa", SHA_A, 180);
    await release("auto-bbbbbbb", SHA_B, 120);

    // A: erro de código novo, 3 tentativas do mesmo job.
    const fresh = await failedJob(QUEUE, { name: "TypeError", message: "Cannot read properties of undefined (reading 'odds')" });
    for (const minutes of [175, 170, 160]) await attempt(QUEUE, fresh, "auto-aaaaaaa", minutes);
    // A: o erro conhecido, com outro número na mensagem.
    const known = await failedJob(QUEUE, { name: "Error", message: "Aposta 456 sem esporte confirmado pela regra" }, "failed");
    await attempt(QUEUE, known, "auto-aaaaaaa", 165);
    // A: fornecedor fora não é da release.
    const provider = await failedJob(OTHER_QUEUE, { name: "CircuitOpenError", message: "circuit breaker aberto para \"pinnacle17\"" });
    for (const minutes of [174, 173, 172]) await attempt(OTHER_QUEUE, provider, "auto-aaaaaaa", minutes);

    // B: o mesmo erro de A continua, e um novo aparece só duas vezes.
    const continued = await failedJob(QUEUE, { name: "TypeError", message: "Cannot read properties of undefined (reading 'odds')" });
    for (const minutes of [115, 110, 100]) await attempt(QUEUE, continued, "auto-bbbbbbb", minutes);
    const hiccup = await failedJob(OTHER_QUEUE, { name: "Error", message: "resposta vazia do fechamento" });
    for (const minutes of [112, 111]) await attempt(OTHER_QUEUE, hiccup, "auto-bbbbbbb", minutes);

    const fetchMock = telegramOk();
    expect(await judgePendingReleases()).toEqual({ judged: 2, flagged: 1, notified: 1 });

    expect(await verdictOf("auto-aaaaaaa")).toMatchObject({
      verdict: "erro_novo",
      knownErrors: 1,
      previousSha: null,
      findings: [{
        queue: QUEUE,
        text: "TypeError: Cannot read properties of undefined (reading 'odds')",
        occurrences: 3,
        jobs: 1,
      }],
      notifiedAt: expect.any(String),
    });
    // O erro novo que ficou abaixo do mínimo não aponta, mas fica no veredito.
    expect(await verdictOf("auto-bbbbbbb")).toMatchObject({
      verdict: "sem_erro_novo",
      findings: [],
      belowThreshold: [{ queue: OTHER_QUEUE, text: "resposta vazia do fechamento", occurrences: 2, jobs: 1 }],
      knownErrors: 3,
      notifiedAt: null,
    });

    const [message, ...rest] = sentTexts(fetchMock);
    expect(rest).toEqual([]);
    expect(message).toContain("Erro novo junto com a release auto-aaaaaaa");
    expect(message).toContain(`• ${QUEUE} — TypeError: Cannot read properties of undefined (reading 'odds'): 3× em 1 job`);

    // A passada seguinte não julga de novo nem reenvia.
    expect(await judgePendingReleases()).toEqual({ judged: 0, flagged: 0, notified: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("o nome do erro separa a impressão digital, e a tentativa com outro erro que o da última falha não leva a mensagem dela", async () => {
    // Antes das releases: RangeError com esta mensagem já acontecia.
    const old = await failedJob(QUEUE, { name: "RangeError", message: "Invalid time value" }, "failed");
    await attempt(QUEUE, old, "auto-velha", 200, "RangeError");

    await release("auto-aaaaaaa", SHA_A, 180);
    await release("auto-bbbbbbb", SHA_B, 120);
    // A: TypeError com a mesma mensagem é outro erro.
    const renamed = await failedJob(QUEUE, { name: "TypeError", message: "Invalid time value" });
    for (const minutes of [175, 170, 165]) await attempt(QUEUE, renamed, "auto-aaaaaaa", minutes, "TypeError");
    // Um job que falhou em A por fornecedor fora e, na última tentativa, já em B,
    // com erro de código: as tentativas de A não são desse erro.
    const crossing = await failedJob(OTHER_QUEUE, { name: "TypeError", message: "Cannot read properties of undefined (reading 'lines')" });
    for (const minutes of [174, 172, 171]) await attempt(OTHER_QUEUE, crossing, "auto-aaaaaaa", minutes, "ProviderRequestError");
    await attempt(OTHER_QUEUE, crossing, "auto-bbbbbbb", 110, "TypeError");

    telegramOk();
    expect(await judgePendingReleases()).toMatchObject({ judged: 2, flagged: 1 });
    expect(await verdictOf("auto-aaaaaaa")).toMatchObject({
      verdict: "erro_novo",
      findings: [{ queue: QUEUE, text: "TypeError: Invalid time value", occurrences: 3, jobs: 1 }],
      belowThreshold: [],
      knownErrors: 0,
    });
    expect(await verdictOf("auto-bbbbbbb")).toMatchObject({
      verdict: "sem_erro_novo",
      belowThreshold: [{ queue: OTHER_QUEUE, text: "TypeError: Cannot read properties of undefined (reading 'lines')", occurrences: 1 }],
      knownErrors: 0,
    });
  });

  it("a memória dos vereditos lembra o erro depois que o job some do pg-boss", async () => {
    await release("auto-aaaaaaa", SHA_A, 180);
    const fresh = await failedJob(QUEUE, { name: "TypeError", message: "x is not a function" }, "failed");
    for (const minutes of [175, 170, 165]) await attempt(QUEUE, fresh, "auto-aaaaaaa", minutes);
    telegramOk();
    expect(await judgePendingReleases()).toMatchObject({ judged: 1, flagged: 1 });

    // O pg-boss apagou o job; a release seguinte repete o erro.
    await db.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE id = $1::uuid`, fresh);
    await release("auto-ccccccc", SHA_C, 90);
    const again = await failedJob(QUEUE, { name: "TypeError", message: "x is not a function" });
    for (const minutes of [85, 80, 75]) await attempt(QUEUE, again, "auto-ccccccc", minutes);

    expect(await judgePendingReleases()).toEqual({ judged: 1, flagged: 0, notified: 0 });
    expect(await verdictOf("auto-ccccccc")).toMatchObject({ verdict: "sem_erro_novo", knownErrors: 3 });
  });

  it("a memória recomeça quando o erro volta: a release grava o que produziu, e a linha de base, o lembrado há mais de 7 dias", async () => {
    const recordedDaysAgo = async (resourceId: string, days: number, seen: string[]) => {
      await db.prisma.auditEvent.create({
        data: {
          action: "release.verdict", resource: "release", resourceId,
          details: { releaseId: resourceId, verdict: "sem_erro_novo", seen },
          createdAt: new Date(Date.now() - days * 86_400_000),
        },
      });
    };
    const produced = `${QUEUE}|TypeError: x is not a function`;
    const stale = `${OTHER_QUEUE}|RangeError: Invalid time value`;
    const fresh = `${OTHER_QUEUE}|TypeError: y is not a function`;
    await recordedDaysAgo("auto-antiga-1", 25, [produced]);
    await recordedDaysAgo("auto-antiga-2", 10, [stale]);
    await recordedDaysAgo("auto-antiga-3", 2, [fresh]);

    // Linha de base: os dois erros da fila de fechamento ainda estão no pg-boss.
    const staleJob = await failedJob(OTHER_QUEUE, { name: "RangeError", message: "Invalid time value" }, "failed");
    await attempt(OTHER_QUEUE, staleJob, "auto-velha", 200);
    const freshJob = await failedJob(OTHER_QUEUE, { name: "TypeError", message: "y is not a function" }, "failed");
    await attempt(OTHER_QUEUE, freshJob, "auto-velha", 200);

    await release("auto-aaaaaaa", SHA_A, 180);
    const again = await failedJob(QUEUE, { name: "TypeError", message: "x is not a function" });
    for (const minutes of [175, 170, 165]) await attempt(QUEUE, again, "auto-aaaaaaa", minutes);

    telegramOk();
    expect(await judgePendingReleases()).toEqual({ judged: 1, flagged: 0, notified: 0 });
    const verdict = await verdictOf("auto-aaaaaaa");
    expect(verdict).toMatchObject({ verdict: "sem_erro_novo", knownErrors: 3 });
    // O lembrado há 2 dias não é gravado de novo.
    expect([...(verdict.seen as string[])].sort()).toEqual([stale, produced].sort());
  });

  it("o aviso que não saiu é tentado de novo na passada seguinte", async () => {
    await release("auto-aaaaaaa", SHA_A, 180);
    const fresh = await failedJob(QUEUE, { name: "RangeError", message: "Invalid time value" });
    for (const minutes of [175, 170, 165]) await attempt(QUEUE, fresh, "auto-aaaaaaa", minutes);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("indisponível", { status: 503 })));
    expect(await judgePendingReleases()).toEqual({ judged: 1, flagged: 1, notified: 0 });
    expect(await verdictOf("auto-aaaaaaa")).toMatchObject({ verdict: "erro_novo", notifiedAt: null });

    const fetchMock = telegramOk();
    expect(await judgePendingReleases()).toEqual({ judged: 0, flagged: 0, notified: 1 });
    expect(sentTexts(fetchMock)[0]).toContain("RangeError: Invalid time value");
    expect(await verdictOf("auto-aaaaaaa")).toMatchObject({ notifiedAt: expect.any(String) });
  });

  it("o Monitoramento lê a release em observação, a julgada e a que ficou sem veredito", async () => {
    await release("auto-aaaaaaa", SHA_A, 26 * 60);
    await release("auto-bbbbbbb", SHA_B, 120);
    await release("auto-ccccccc", SHA_C, 10);
    const fresh = await failedJob(QUEUE, { name: "TypeError", message: "Cannot read properties of null (reading 'id')" });
    for (const minutes of [115, 110, 105, 100]) await attempt(QUEUE, fresh, "auto-bbbbbbb", minutes);
    telegramOk();
    // A de 26 h passou do prazo: não é julgada tarde, com a linha de base já perdida.
    expect(await judgePendingReleases()).toMatchObject({ judged: 1, flagged: 1 });

    const { releases, flaggedLast24h } = await getRecentReleases();
    expect(flaggedLast24h).toBe(1);
    expect(releases.map((r) => [r.releaseId, r.state])).toEqual([
      ["auto-ccccccc", "em_observacao"],
      ["auto-bbbbbbb", "erro_novo"],
      ["auto-aaaaaaa", "sem_veredito"],
    ]);
    expect(releases[1]).toMatchObject({
      sha: SHA_B,
      previousSha: SHA_A,
      notice: "sent",
      knownErrors: 0,
      belowThreshold: [],
      findings: [{ queue: QUEUE, text: "TypeError: Cannot read properties of null (reading 'id')", occurrences: 4, jobs: 1 }],
    });
  });
  it("Desempenho mostra e conta a release apontada nas últimas 24 h mesmo fora das 10 últimas", async () => {
    await release("auto-ontem", SHA_A, 23 * 60);
    const old = await failedJob(QUEUE, { name: "TypeError", message: "Cannot read properties of undefined (reading 'stake')" });
    for (const minutes of [23 * 60 - 5, 23 * 60 - 10, 23 * 60 - 15]) await attempt(QUEUE, old, "auto-ontem", minutes);
    await release("auto-noite", SHA_B, 20 * 60);
    const night = await failedJob(OTHER_QUEUE, { name: "RangeError", message: "Invalid time value" });
    for (const minutes of [20 * 60 - 5, 20 * 60 - 10, 20 * 60 - 15]) await attempt(OTHER_QUEUE, night, "auto-noite", minutes);
    telegramOk();
    expect(await judgePendingReleases()).toMatchObject({ judged: 2, flagged: 2 });
    // O veredito da primeira saiu há mais de 24 h: já não acende o número.
    await db.prisma.$executeRawUnsafe(
      `UPDATE audit_events SET "createdAt" = now() - interval '25 hours' WHERE action = 'release.verdict' AND "resourceId" = 'auto-ontem'`,
    );
    // Onze publicações depois da apontada, como numa noite de merges seguidos.
    for (let index = 0; index < 11; index += 1) {
      await release(`auto-depois-${String(index).padStart(2, "0")}`, SHA_C, 19 * 60 - index * 10);
    }

    const { releases, flaggedLast24h } = await getRecentReleases(10);
    expect(flaggedLast24h).toBe(1);
    expect(releases).toHaveLength(11);
    expect(releases.slice(0, 10).every((r) => r.releaseId.startsWith("auto-depois-"))).toBe(true);
    expect(releases[10]).toMatchObject({
      releaseId: "auto-noite",
      state: "erro_novo",
      findings: [{ queue: OTHER_QUEUE, text: "RangeError: Invalid time value", occurrences: 3 }],
    });
    expect(releases.some((r) => r.releaseId === "auto-ontem")).toBe(false);
  });
});
