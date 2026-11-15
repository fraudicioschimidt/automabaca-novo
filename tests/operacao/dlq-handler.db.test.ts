import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, PgBoss } from "pg-boss";
import { createBoss } from "@/src/infra/boss";
import { deadLetterOf, QUEUES } from "@/src/infra/queue-contract";
import { registerQueue } from "@/src/jobs/queues";
import {
  descartarDeadLettersSemAssunto,
  discardRetainedScheduledDeadLetters,
  dlqBetId,
  handleDeadLetterBatch,
  isLastTelegramAttempt,
  releaseStuckTelegramKeys,
} from "@/src/services/ops/dlq/handler";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { TELEGRAM_QUEUE_OPTIONS } from "@/src/telegram/bot";
import {
  sendOperationalAlert,
  sendOperatorNotification,
  sendRequiredOperatorNotification,
} from "@/src/services/ops/alerts";
import { sendExecutiveBriefing } from "@/src/services/ops/digests/executive-briefing";
import { enqueueTelegramJob } from "@/src/services/scheduling/enqueue-telegram-job";
import { dlqPerdeuAssunto, recordDeadLetterRequeue } from "@/src/services/ops/dlq/repository";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: vi.fn().mockResolvedValue(true),
  sendOperatorNotification: vi.fn().mockResolvedValue(true),
  sendRequiredOperatorNotification: vi.fn().mockResolvedValue("delivered"),
  raiseOperationalAlertOnce: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Dead-letter cuja APOSTA sumiu não tem replay possível: reprocessar só falharia
 * de novo, e a ação reabriria no topo da caixa a cada ciclo. O watcher descarta
 * a que chega já sem assunto; a varredura alcança a que perdeu o assunto depois
 * de retida (a `.dlq` tem `retryLimit: 0` e entrega cada job uma única vez).
 */

let db: TestDb;
let boss: PgBoss;
const deletados: Array<{ fila: string; id: string }> = [];

/** Boss falso para o watcher: aqui o que importa é a DECISÃO, não o transporte. */
const fakeBoss = {
  deleteJob: async (fila: string, id: string) => {
    deletados.push({ fila, id: String(id) });
  },
} as unknown as PgBoss;

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
  deletados.length = 0;
  // `db.reset()` trunca as tabelas de negócio; o schema `pgboss` sobrevive, e
  // sem esta limpeza os jobs de um teste vazam para o seguinte.
  await db.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name LIKE '%.dlq'`);
});

async function apostaViva(): Promise<string> {
  const banca = await db.prisma.bankroll.upsert({
    where: { slug: "dlq" },
    create: { nome: "DLQ", slug: "dlq" },
    update: {},
  });
  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: banca.id,
      data: new Date("2026-08-02T18:00:00Z"),
      evento: "Time A vs Time B",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Casa",
      odds: 2,
      stake: 1,
      status: "PENDING",
    },
  });
  return bet.id;
}

/** Marca o job como JÁ retido — o estado que só a varredura alcança. */
async function marcarRetida(jobId: string): Promise<void> {
  await db.prisma.auditEvent.create({
    data: {
      actor: "system",
      action: "job.dlq_retained",
      resource: QUEUES.sharpEnrich,
      resourceId: jobId,
      details: { errorMsg: "erro de negocio qualquer", dlqClass: "business" },
    },
  });
}

function jobDe(id: string, betId: string): Job {
  return {
    id,
    name: deadLetterOf(QUEUES.sharpEnrich),
    data: { betId, origem: "revive" },
    sourceOutput: { name: "Error", message: "falha de negocio" },
  } as unknown as Job;
}

const processar = (job: Job) =>
  handleDeadLetterBatch(fakeBoss, QUEUES.sharpEnrich, {}, [job]);

/**
 * Insere uma dead-letter no estado em que o watcher a deixa: `failed`.
 *
 * `startAfter` no futuro é OBRIGATÓRIO: `registerQueue` deixa um watcher VIVO
 * na fila `.dlq`, e sem isso ele disputava o job com o `UPDATE` abaixo —
 * descartando-o pelo caminho da ENTREGA e gravando um rastro a mais. O teste
 * passava isolado e falhava sob carga da suíte cheia, que é o pior modo de
 * falhar. Aqui o job nasce inelegível para entrega, que é exatamente o estado
 * que esta varredura existe para alcançar.
 */
async function deadLetterPresa(fila: string, betId: string): Promise<string> {
  const id = await boss.send(
    deadLetterOf(fila),
    { betId, origem: "revive" },
    { startAfter: 3_600 },
  );
  if (!id) throw new Error("pg-boss recusou o job de teste");
  await db.prisma.$executeRawUnsafe(
    `UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1::uuid`,
    id,
  );
  return id;
}

async function existeJob(id: string): Promise<boolean> {
  const linhas = await db.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM pgboss.job WHERE id = $1::uuid`,
    id,
  );
  return Number(linhas[0]?.n ?? 0) > 0;
}

describe("watcher: dead-letter retida sem assunto", () => {
  it("dlqBetId lê o payload cru, sem política de fila", () => {
    expect(dlqBetId({ betId: "abc" })).toBe("abc");
    // `capture.sport_resolve` também nomeia aposta — restringir o DESCARTE a uma
    // fila só deixaria dead-letters mortas presas nas outras.
    expect(dlqBetId({ betId: "abc", attempt: 0 })).toBe("abc");
    // Payload sem aposta segue o caminho normal de retenção.
    expect(dlqBetId({ kind: "edited_channel_post" })).toBeNull();
    expect(dlqBetId({ outro: 1 })).toBeNull();
    expect(dlqBetId(null)).toBeNull();
  });

  it("descarta a retida de OUTRA fila escopada por aposta", async () => {
    const jobId = "44444444-4444-4444-8444-444444444444";
    await db.prisma.auditEvent.create({
      data: {
        actor: "system", action: "job.dlq_retained",
        resource: QUEUES.sportResolve, resourceId: jobId,
        details: { errorMsg: "x", dlqClass: "business" },
      },
    });
    const job = {
      id: jobId,
      name: deadLetterOf(QUEUES.sportResolve),
      data: { betId: "55555555-5555-4555-8555-555555555555", attempt: 0 },
      sourceOutput: { name: "Error", message: "falha" },
    } as unknown as Job;

    await expect(
      handleDeadLetterBatch(fakeBoss, QUEUES.sportResolve, {}, [job]),
    ).resolves.toBeUndefined();
    expect(deletados).toEqual([{ fila: deadLetterOf(QUEUES.sportResolve), id: jobId }]);
  });

  it("aposta inexistente perdeu o assunto", async () => {
    expect(await dlqPerdeuAssunto("00000000-0000-4000-8000-000000000000")).toBe(true);
  });

  it("aposta removida (👎) perdeu o assunto; viva, não", async () => {
    const betId = await apostaViva();
    expect(await dlqPerdeuAssunto(betId)).toBe(false);
    await db.prisma.bet.update({ where: { id: betId }, data: { deletedAt: new Date() } });
    expect(await dlqPerdeuAssunto(betId)).toBe(true);
  });

  it("descarta a retida cuja aposta sumiu — com rastro, e sem re-erguer a falha", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    await marcarRetida(jobId);

    await expect(
      processar(jobDe(jobId, "22222222-2222-4222-8222-222222222222")),
    ).resolves.toBeUndefined();

    expect(deletados).toEqual([
      { fila: deadLetterOf(QUEUES.sharpEnrich), id: jobId },
    ]);
    const rastro = await db.prisma.auditEvent.findFirst({
      where: { action: "job.dlq_discarded", resourceId: jobId },
    });
    expect(rastro).not.toBeNull();
    expect(rastro?.details).toMatchObject({ motivo: "aposta removida ou inexistente" });
  });

  it("retida com aposta VIVA continua sendo retida — nada é descartado", async () => {
    const jobId = "33333333-3333-4333-8333-333333333333";
    const betId = await apostaViva();
    await marcarRetida(jobId);

    await expect(processar(jobDe(jobId, betId))).rejects.toThrow(/retida para replay manual/);
    expect(deletados).toEqual([]);
    expect(
      await db.prisma.auditEvent.count({ where: { action: "job.dlq_discarded" } }),
    ).toBe(0);
  });
});

describe("varredura de dead-letters sem assunto", () => {
  /** Fila só deste teste: payload que não nomeia aposta. */
  const SEM_APOSTA = "test.dlq-sem-aposta";

  beforeEach(async () => {
    await registerQueue(boss, QUEUES.sharpEnrich, { retryLimit: 0, policy: "exclusive" });
    await registerQueue(boss, QUEUES.sportResolve, { retryLimit: 0, policy: "exclusive" });
    await registerQueue(boss, SEM_APOSTA, { retryLimit: 0, policy: "exclusive" });
  });

  it("descarta as presas de qualquer fila escopada por aposta, com rastro", async () => {
    const a = await deadLetterPresa(QUEUES.sharpEnrich, "11111111-1111-4111-8111-111111111111");
    const b = await deadLetterPresa(QUEUES.sportResolve, "22222222-2222-4222-8222-222222222222");

    expect(await descartarDeadLettersSemAssunto(boss)).toBe(2);

    expect(await existeJob(a)).toBe(false);
    expect(await existeJob(b)).toBe(false);
    // Filtra pelos DOIS jobs deste teste, em vez de contar tudo que a tabela
    // tem: a fila `.dlq` recebe um watcher vivo em `registerQueue`, e entre o
    // `boss.send` do fixture e o UPDATE para `failed` ele pode ganhar a corrida
    // e descartar o job pelo caminho da ENTREGA — outro rastro legítimo, que
    // fazia a contagem global oscilar só sob carga da suíte cheia.
    const rastros = await db.prisma.auditEvent.findMany({
      where: { action: "job.dlq_discarded", resourceId: { in: [a, b] } },
      select: { resource: true, resourceId: true },
    });
    expect(rastros).toHaveLength(2);
    // A fila ORIGINAL é a identidade do trabalho; `.dlq` é só o transporte.
    expect(rastros.map((r) => r.resource).sort()).toEqual(
      [QUEUES.sharpEnrich, QUEUES.sportResolve].sort(),
    );
  });

  it("aposta VIVA mantém a dead-letter presa — decisão continua sendo humana", async () => {
    const betId = await apostaViva();
    const job = await deadLetterPresa(QUEUES.sharpEnrich, betId);

    expect(await descartarDeadLettersSemAssunto(boss)).toBe(0);
    expect(await existeJob(job)).toBe(true);
  });

  it("aposta removida (👎) DEPOIS da retenção é o caso que o watcher não alcança", async () => {
    const betId = await apostaViva();
    const job = await deadLetterPresa(QUEUES.sharpEnrich, betId);
    // Nada acontece enquanto a aposta está viva…
    expect(await descartarDeadLettersSemAssunto(boss)).toBe(0);

    // …e é o 👎 posterior que torna o trabalho irreplayável.
    await db.prisma.bet.update({ where: { id: betId }, data: { deletedAt: new Date() } });
    expect(await descartarDeadLettersSemAssunto(boss)).toBe(1);
    expect(await existeJob(job)).toBe(false);
  });

  /**
   * A versão anterior filtrava `state <> 'created'` e teria apagado o job DEBAIXO
   * do watcher: uma sonda mostrou que pg-boss coloca o job em **`active`**
   * enquanto ele é processado, não em `created`. Apagar ali engoliria a
   * notificação que o operador recebe. Só `failed` — veredito já dado, ninguém
   * mais vai olhar — pode ser varrido.
   */
  it.each(["created", "active"])("dead-letter em `%s` não é tocada", async (estado) => {
    const id = await boss.send(
      deadLetterOf(QUEUES.sharpEnrich),
      { betId: "33333333-3333-4333-8333-333333333333" },
      { startAfter: 3_600 },
    );
    expect(id).not.toBeNull();
    await db.prisma.$executeRawUnsafe(
      `UPDATE pgboss.job SET state = $2 WHERE id = $1::uuid`,
      id,
      estado,
    );

    expect(await descartarDeadLettersSemAssunto(boss)).toBe(0);
    expect(await existeJob(String(id))).toBe(true);
  });

  it("payload sem aposta nunca é descartado", async () => {
    const id = await boss.send(
      deadLetterOf(SEM_APOSTA),
      { kind: "edited_channel_post", messageId: 7 },
      { startAfter: 3_600 },
    );
    await db.prisma.$executeRawUnsafe(
      `UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1::uuid`,
      id,
    );

    expect(await descartarDeadLettersSemAssunto(boss)).toBe(0);
    expect(await existeJob(String(id))).toBe(true);
  });
});

describe("dead-letter retida de fila agendada", () => {
  it("sai com rastro; a de fila sem cron continua esperando decisão", async () => {
    // Só topologia: sem o watcher, a fixture não é consumida no meio do teste.
    await ensureQueueWithDeadLetter(boss, QUEUES.closingSync, { retryLimit: 0, policy: "exclusive" });
    await ensureQueueWithDeadLetter(boss, QUEUES.sharpEnrich, { retryLimit: 0, policy: "exclusive" });
    const tique = await deadLetterPresa(QUEUES.closingSync, "33333333-3333-4333-8333-333333333333");
    const apostaViva = await deadLetterPresa(QUEUES.sharpEnrich, "44444444-4444-4444-8444-444444444444");

    expect(await discardRetainedScheduledDeadLetters(boss, [QUEUES.closingSync])).toBe(1);

    expect(await existeJob(tique)).toBe(false);
    expect(await existeJob(apostaViva)).toBe(true);
    const rastro = await db.prisma.auditEvent.findFirst({ where: { action: "job.dlq_tick_discarded", resourceId: tique } });
    expect(rastro).toMatchObject({ resource: QUEUES.closingSync, details: expect.objectContaining({ origem: "varredura" }) });
  });
});

describe("disparo de cron diário que falha (pg-boss real)", () => {
  /** Fila só deste teste, com o intervalo do briefing: a de produção pode existir com outra policy no banco de teste. */
  const DIARIA = "test.cron-diario";
  const options = { retryLimit: 0, policy: "exclusive" as const, cronMaxGapMinutes: 1440 };

  it("Telegram fora às 00:05: o briefing volta à fila com chave própria, não trava o cron e sai depois", async () => {
    await ensureQueueWithDeadLetter(boss, DIARIA, options);
    await db.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = $1`, DIARIA);

    // O disparo das 00:05 esgota as tentativas com o Telegram fora.
    const tickId = await boss.send(DIARIA, null);
    const [tick] = await boss.fetch(DIARIA);
    expect(tick?.id).toBe(tickId);
    await boss.fail(DIARIA, tick!.id, new Error("Falha ao entregar notificação obrigatória ao operador (network_error)."));
    const [deadLetter] = await boss.fetch(deadLetterOf(DIARIA), { includeMetadata: true });
    await handleDeadLetterBatch(boss, DIARIA, options, [deadLetter as Job]);

    const [retry] = await db.prisma.$queryRawUnsafe<Array<{ id: string; singleton_key: string; wait_s: number }>>(
      `SELECT id::text, singleton_key, extract(epoch FROM start_after - now())::float8 AS wait_s
       FROM pgboss.job WHERE name = $1 AND state = 'created'`, DIARIA);
    expect(retry?.singleton_key).toBe(`scheduled-retry:${tickId}`);
    expect(retry?.wait_s).toBeGreaterThan(7_100);
    expect(retry?.wait_s).toBeLessThanOrEqual(7_200);

    // A retentativa tem chave própria: o disparo seguinte do cron não é recusado pela vaga exclusive.
    const nextTick = await boss.send(DIARIA, null);
    expect(nextTick).toBeTruthy();
    await boss.deleteJob(DIARIA, nextTick!);

    // Duas horas depois, com o Telegram de volta, a retentativa roda e o briefing do dia sai.
    await db.prisma.$executeRawUnsafe(`UPDATE pgboss.job SET start_after = now() WHERE id = $1::uuid`, retry!.id);
    const [again] = await boss.fetch(DIARIA);
    expect(again?.data).toEqual({ scheduledRetry: { origin: tickId, attempt: 1 } });
    await sendExecutiveBriefing(new Date("2026-09-24T05:05:00Z"));
    expect(vi.mocked(sendRequiredOperatorNotification)).toHaveBeenCalledWith(
      expect.stringContaining("Resumo do dia · 23/09/2026"),
      expect.objectContaining({ key: "executive-briefing:23/09/2026" }),
    );
  });
});

describe("fila ordenada do Telegram: chave do post presa por falha", () => {
  const Q = QUEUES.telegramUpdates;
  const post = (messageId: number, text = "tip") => ({
    kind: "channel_post" as const, chatId: "-1001234", messageId, text, postDate: "2026-09-20T12:00:00.000Z",
  });

  beforeAll(async () => {
    await ensureQueueWithDeadLetter(boss, Q, TELEGRAM_QUEUE_OPTIONS[Q]);
  });

  beforeEach(async () => {
    await db.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name LIKE 'telegram.updates%'`);
    vi.clearAllMocks();
  });

  /** Falha o primeiro job do post e devolve a cópia que o pg-boss pôs na dead-letter. */
  async function falharPost(messageId: number, error: Error): Promise<Job> {
    const id = await enqueueTelegramJob(boss, post(messageId));
    const [job] = await boss.fetch(Q, { batchSize: 1 });
    expect(job?.id).toBe(id);
    // Última tentativa: a falha vai direto para a dead-letter.
    await db.prisma.$executeRaw`UPDATE pgboss.job SET retry_limit = 0 WHERE name = ${Q} AND id = ${id}::uuid`;
    await boss.fail(Q, id!, error);
    const [dead] = await boss.fetch(deadLetterOf(Q), { batchSize: 1, includeMetadata: true });
    if (!dead) throw new Error("pg-boss não gerou a dead-letter");
    return dead as Job;
  }

  it("o watcher apaga a origem: a edição do mesmo post volta a andar e o dono é avisado", async () => {
    const dead = await falharPost(20, new Error("dado sintético sem saída"));
    await enqueueTelegramJob(boss, post(20, "editado"));
    expect(await boss.getBlockedKeys(Q)).toEqual(["tg:-1001234:msg:20"]);
    expect(await boss.fetch(Q, { batchSize: 5 })).toEqual([]);

    await expect(handleDeadLetterBatch(boss, Q, {}, [dead])).rejects.toThrow(/retida/);
    expect(await boss.getBlockedKeys(Q)).toEqual([]);
    const [next] = await boss.fetch(Q, { batchSize: 5 });
    expect(next?.data).toMatchObject({ messageId: 20, text: "editado" });
    expect(sendOperatorNotification).toHaveBeenCalledWith(expect.stringContaining("mensagem 20"));
  });

  it("falha passageira volta como cabeça da fila do post: a edição continua atrás", async () => {
    const dead = await falharPost(21, new Error("fetch failed"));
    await enqueueTelegramJob(boss, post(21, "editado"));
    await handleDeadLetterBatch(boss, Q, {}, [dead]);

    const rows = await db.prisma.$queryRaw<Array<{ id: string; state: string; startAfter: Date }>>`
      SELECT id::text, state::text AS state, start_after AS "startAfter"
      FROM pgboss.job WHERE name = ${Q} AND data->>'text' = 'tip'
    `;
    expect(rows).toEqual([expect.objectContaining({ id: (dead as Job & { sourceId: string }).sourceId, state: "retry" })]);
    expect(rows[0]!.startAfter.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(await boss.fetch(Q, { batchSize: 5 })).toEqual([]);
    expect(await db.prisma.auditEvent.count({ where: { action: "job.dlq_requeue", resource: Q } })).toBe(1);

    // Vencida a espera, o post sai antes da edição.
    await db.prisma.$executeRaw`UPDATE pgboss.job SET start_after = now() WHERE name = ${Q} AND state = 'retry'`;
    const [first] = await boss.fetch(Q, { batchSize: 5 });
    expect(first?.data).toMatchObject({ messageId: 21, text: "tip" });
  });

  it("a varredura solta a chave presa há mais de 10 min e avisa; a recente fica com o watcher", async () => {
    await falharPost(22, new Error("watcher fora"));
    await falharPost(23, new Error("watcher fora"));
    await db.prisma.$executeRaw`
      UPDATE pgboss.job SET completed_on = now() - interval '11 minutes'
      WHERE name = ${Q} AND singleton_key = 'tg:-1001234:msg:22'
    `;
    expect(await releaseStuckTelegramKeys(boss)).toBe(1);
    expect(await boss.getBlockedKeys(Q)).toEqual(["tg:-1001234:msg:23"]);
    expect(sendOperationalAlert).toHaveBeenCalledWith(expect.stringContaining("destravados · 1"), expect.objectContaining({ source: "telegram.blocked-keys" }));
    // A cópia na dead-letter continua para o dono decidir.
    const dlq = await db.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${deadLetterOf(Q)}`;
    expect(dlq[0]?.n).toBe(2);
  });
});

describe("última tentativa de um job do Telegram", () => {
  const data = { kind: "channel_post", chatId: "-100123", messageId: 71, text: "tip", postDate: "2026-09-23T12:00:00.000Z" };
  const requeue = (n: number) => recordDeadLetterRequeue({
    queue: QUEUES.telegramUpdates, payloadKey: canonicalSha256(data), jobId: `dlq-${n}`, requeuedJobId: "origem",
    errorMessage: "Cascata de extração indisponível", startAfterSeconds: 120,
  });

  it("só depois das 5 tentativas da fila e dos 3 reenvios da dead-letter", async () => {
    const limit = TELEGRAM_QUEUE_OPTIONS[QUEUES.telegramUpdates].retryLimit;
    expect(await isLastTelegramAttempt(QUEUES.telegramUpdates, { data, retryCount: limit - 1, retryLimit: limit })).toBe(false);
    expect(await isLastTelegramAttempt(QUEUES.telegramUpdates, { data, retryCount: limit, retryLimit: limit })).toBe(false);
    for (const n of [1, 2]) await requeue(n);
    // Cada reenvio da dead-letter dá uma tentativa a mais: o limite sobe com ele.
    expect(await isLastTelegramAttempt(QUEUES.telegramUpdates, { data, retryCount: limit + 2, retryLimit: limit + 2 })).toBe(false);
    await requeue(3);
    expect(await isLastTelegramAttempt(QUEUES.telegramUpdates, { data, retryCount: limit + 3, retryLimit: limit + 3 })).toBe(true);
    expect(await isLastTelegramAttempt(QUEUES.telegramUpdates, { data: { ...data, messageId: 72 }, retryCount: limit + 3, retryLimit: limit + 3 })).toBe(false);
  });

  it("os reenvios de um incidente antigo não gastam os do incidente seguinte", async () => {
    const limit = TELEGRAM_QUEUE_OPTIONS[QUEUES.telegramUpdates].retryLimit;
    for (const n of [1, 2, 3]) await requeue(n);
    await db.prisma.auditEvent.updateMany({
      where: { action: "job.dlq_requeue" }, data: { createdAt: new Date(Date.now() - 49 * 3_600_000) },
    });
    expect(await isLastTelegramAttempt(QUEUES.telegramUpdates, { data, retryCount: limit + 3, retryLimit: limit + 3 })).toBe(false);
  });

  it("sem os metadados do job não é a última", async () => {
    expect(await isLastTelegramAttempt(QUEUES.telegramUpdates, { data })).toBe(false);
  });

  it("o flush do álbum conta os reenvios da própria fila, que recomeçam as tentativas", async () => {
    const flush = { kind: "media_album_flush", chatId: "-100123", mediaGroupId: "alb-1" };
    const limit = TELEGRAM_QUEUE_OPTIONS[QUEUES.telegramDeferred].retryLimit;
    for (const n of [1, 2, 3]) {
      await recordDeadLetterRequeue({
        queue: QUEUES.telegramDeferred, payloadKey: canonicalSha256(flush), jobId: `dlq-album-${n}`, requeuedJobId: `album-${n}`,
        errorMessage: "Cascata de extração indisponível", startAfterSeconds: 120,
      });
    }
    expect(await isLastTelegramAttempt(QUEUES.telegramDeferred, { data: flush, retryCount: limit - 1, retryLimit: limit })).toBe(false);
    expect(await isLastTelegramAttempt(QUEUES.telegramDeferred, { data: flush, retryCount: limit, retryLimit: limit })).toBe(true);
    // Os reenvios de outra fila não contam.
    expect(await isLastTelegramAttempt(QUEUES.telegramUpdates, { data: flush, retryCount: limit, retryLimit: limit })).toBe(false);
  });
});
