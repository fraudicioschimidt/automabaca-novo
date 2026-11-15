import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../helpers/db";
import { getSharedBoss } from "@/src/infra/boss";
import { deadLetterOf, QUEUES } from "@/src/infra/queue-contract";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { TELEGRAM_QUEUE_OPTIONS } from "@/src/telegram/bot";
import {
  dispatchDeadLetterReplayAudit,
  listDeadLetters,
  replayDeadLetter,
  replayDeadLetters,
} from "@/src/services/ops/dlq/replay";
import { recordDeadLetterRetained } from "@/src/services/ops/dlq/repository";

/**
 * Fecho do ciclo fail-loud contra pg-boss real: dead-letter visível →
 * replay reenfileira na fila de origem, remove da DLQ e audita; reprocesso
 * em massa enfileira pendências pulando quem já tem job na fila.
 */

let db: TestDb;
let boss: PgBoss;
const DLQ = deadLetterOf(QUEUES.sharpEnrich);
/** Fila exclusive do contrato: o replay só manda trabalho para fila que esta versão consome. */
const EXCLUSIVE_QUEUE = QUEUES.closingSeriesSweep;
const EXCLUSIVE_DLQ = deadLetterOf(EXCLUSIVE_QUEUE);
const TELEGRAM_DLQ = deadLetterOf(QUEUES.telegramUpdates);
/** Fila que saiu do código mas continua registrada no pg-boss. */
const RETIRED_QUEUE = "test.ops-deadletters-aposentada";
const RETIRED_DLQ = deadLetterOf(RETIRED_QUEUE);

beforeAll(async () => {
  db = createTestDb();
  boss = await getSharedBoss();
  // TOPOLOGIA, não `registerQueue`: aqui as dead-letters são FIXTURE — elas
  // precisam ficar paradas para o replay do painel encontrá-las. O watcher que
  // o `registerQueue` liga faz poll da DLQ a cada 2s e, enquanto processa, deixa a
  // linha em `active` — fora do `state IN ('created','retry','failed')` que o
  // serviço filtra, e o replay devolveria null ao acaso. Portão:
  // `tests/operacao/fixture-de-dlq-vs-watcher.test.ts`.
  await ensureQueueWithDeadLetter(boss, QUEUES.sharpEnrich);
  await ensureQueueWithDeadLetter(boss, EXCLUSIVE_QUEUE, { policy: "exclusive" });
  await ensureQueueWithDeadLetter(boss, RETIRED_QUEUE, { policy: "exclusive" });
  await ensureQueueWithDeadLetter(boss, QUEUES.telegramUpdates, TELEGRAM_QUEUE_OPTIONS[QUEUES.telegramUpdates]);
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});

async function limparJobsDoArquivo(): Promise<void> {
  await db.prisma.$executeRawUnsafe(
    `DELETE FROM pgboss.job WHERE name IN ('${QUEUES.sharpEnrich}', '${DLQ}', '${EXCLUSIVE_QUEUE}', '${EXCLUSIVE_DLQ}', '${TELEGRAM_DLQ}', '${QUEUES.telegramUpdates}', '${RETIRED_QUEUE}', '${RETIRED_DLQ}')`,
  );
}

beforeEach(async () => {
  await db.reset();
  await limparJobsDoArquivo();
});

afterEach(limparJobsDoArquivo);

async function jobsNaFila(name: string): Promise<number> {
  const rows = await db.prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${name}
  `;
  return rows[0]?.n ?? 0;
}

describe("dead-letters (pg-boss real)", () => {
  it("lista, reenfileira na fila de origem, remove da DLQ e audita", async () => {
    const dlqId = await boss.send(DLQ, { betId: "bet-morta" });
    expect(dlqId).not.toBeNull();

    const lista = await listDeadLetters(10);
    expect(lista.map((d) => d.id)).toContain(dlqId);
    expect(lista.find((d) => d.id === dlqId)?.fila).toBe(QUEUES.sharpEnrich);

    const r = await replayDeadLetter(dlqId!, "ui");
    expect(r).toEqual({ fila: QUEUES.sharpEnrich });
    expect(await jobsNaFila(QUEUES.sharpEnrich)).toBe(1);
    expect(await jobsNaFila(DLQ)).toBe(0);
    expect(await db.prisma.auditEvent.count({ where: { action: "dlq_replay" } })).toBe(1);

    // Segundo replay do mesmo id: não existe mais.
    expect(await replayDeadLetter(dlqId!, "ui")).toBeNull();
  });

  async function seedUnmatchedBet(slug: string, deletedAt: Date | null = null) {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: slug, slug } });
    return db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), bankrollId: bankroll.id, deletedAt,
        data: new Date(Date.now() - 2 * 3_600_000), evento: "Home FC vs Away FC", esporte: "Soccer",
        mercado: "Total", selecao: "Over 2.5", odds: 1.9, stake: 1, status: "PENDING",
        sharp: { create: {
          identityStatus: "UNMATCHED", confidence: 0, identityResolvedAt: new Date(), noOddsReason: "identidade_nao_casada",
        } },
      },
    });
  }

  it("replay do sharp.enrich reabre a identidade que a dead-letter encerrou", async () => {
    // Sem reabrir, o enrich reenviado sairia em `terminal_identity` sem consultar ninguém.
    const bet = await seedUnmatchedBet("dlq-replay-sharp");
    const dlqId = await boss.send(DLQ, { betId: bet.id });

    await replayDeadLetter(dlqId!, "fabricio");

    // Sem o motivo terminal: a tela não diz "nenhum provider casou" enquanto o enrich busca.
    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ identityStatus: "PENDING", identityResolvedAt: null, noOddsReason: null });
    expect(await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "bet_sharp.reopen_unmatched", resourceId: bet.id },
    })).toMatchObject({ actor: "fabricio", details: { origem: "dlq-replay" } });
    expect(await jobsNaFila(QUEUES.sharpEnrich)).toBe(1);
  });

  it("replay do sharp.enrich de aposta removida não reabre a identidade", async () => {
    const bet = await seedUnmatchedBet("dlq-replay-removida", new Date());
    const dlqId = await boss.send(DLQ, { betId: bet.id });

    await replayDeadLetter(dlqId!, "fabricio");

    expect((await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } })).identityStatus).toBe("UNMATCHED");
    expect(await db.prisma.auditEvent.count({ where: { action: "bet_sharp.reopen_unmatched" } })).toBe(0);
  });

  it("entrega o erro que matou o job — é o que a caixa de ações mostra", async () => {
    const dlqId = await boss.send(DLQ, { betId: "bet-com-erro" });
    await db.prisma.$executeRaw`
      UPDATE pgboss.job SET output = '{"message":"BridgeOdds query falhou: HTTP 429"}'::jsonb
      WHERE id = ${dlqId}::uuid
    `;
    const linha = (await listDeadLetters(10)).find((d) => d.id === dlqId);
    expect(linha?.erro).toBe("BridgeOdds query falhou: HTTP 429");
  });

  it("sem saída preservada, o erro vem nulo em vez de string vazia", async () => {
    const dlqId = await boss.send(DLQ, { betId: "bet-sem-output" });
    expect((await listDeadLetters(10)).find((d) => d.id === dlqId)?.erro).toBeNull();
  });

  it("expõe e audita só o allowlist do payload, com erro sanitizado", async () => {
    const secret = "sentinelDlqBearerToken123456789";
    const dlqId = await boss.send(EXCLUSIVE_DLQ, {
      updateId: "update-seguro",
      text: `Authorization: Bearer ${secret}`,
      token: secret,
    });
    expect(dlqId).not.toBeNull();
    await db.prisma.$executeRaw`
      UPDATE pgboss.job
      SET output = ${JSON.stringify({ message: `Authorization: Bearer ${secret}` })}::jsonb
      WHERE id = ${dlqId}::uuid
    `;

    const row = (await listDeadLetters(10)).find((item) => item.id === dlqId);
    expect(row?.data).toEqual({ updateId: "update-seguro" });
    expect(row?.erro).toContain("[redacted]");
    expect(JSON.stringify(row)).not.toContain(secret);

    await replayDeadLetter(dlqId!, "ui");
    const audit = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "dlq_replay", resourceId: dlqId! },
    });
    expect(audit.details).toMatchObject({ payload: { updateId: "update-seguro" } });
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("falha de captura traz banca, post, trecho e a classe registrada na retenção", async () => {
    await db.prisma.bankroll.create({ data: { nome: "Tipster Alfa", slug: "tipster-alfa", telegramChannelId: -1001234567890n } });
    const canal = await boss.send(TELEGRAM_DLQ, {
      kind: "channel_photo", chatId: "-1001234567890", messageId: 42, caption: "Flamengo x Vasco  Over 2.5\n1u", postDate: "2026-09-20T12:00:00Z", fileId: "foto-42",
    });
    const dm = await boss.send(TELEGRAM_DLQ, { kind: "dm_message", chatId: "5550001", messageId: 9, text: "texto privado", postDate: "2026-09-20T12:00:00Z" });
    await recordDeadLetterRetained({ queue: QUEUES.telegramUpdates, jobId: canal!, errorMessage: "kickoff provisório", classification: "business", waitsFor: "o evento começar" });

    const linhas = await listDeadLetters(10);
    const doCanal = linhas.find((row) => row.id === canal);
    expect(doCanal).toMatchObject({ classe: "business", waitsFor: "o evento começar", erro: "kickoff provisório", post: {
      bankroll: "Tipster Alfa", channelId: "-1001234567890", messageId: 42, excerpt: "Flamengo x Vasco Over 2.5 1u",
    } });
    const daConversa = linhas.find((row) => row.id === dm);
    expect(daConversa?.post).toEqual({ bankroll: null, channelId: null, messageId: 9, mediaGroupId: null, excerpt: null });
    expect(JSON.stringify(daConversa)).not.toContain("texto privado");
  });

  it("replay de update do Telegram volta pela fila ordenada, na chave do post", async () => {
    const dlqId = await boss.send(TELEGRAM_DLQ, {
      kind: "edited_channel_post", chatId: "-1001234", messageId: 42, text: "editado",
      postDate: "2026-09-20T12:00:00.000Z", editDate: "2026-09-20T12:05:00.000Z", _observability: { correlationId: "job_antigo" },
    });
    await expect(replayDeadLetter(dlqId!, "ui")).resolves.toEqual({ fila: QUEUES.telegramUpdates });
    const rows = await db.prisma.$queryRaw<Array<{ singletonKey: string; data: Record<string, unknown> }>>`
      SELECT singleton_key AS "singletonKey", data FROM pgboss.job WHERE name = ${QUEUES.telegramUpdates}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ singletonKey: "tg:-1001234:msg:42", data: { kind: "edited_channel_post", messageId: 42 } });
    expect(await jobsNaFila(TELEGRAM_DLQ)).toBe(0);
  });

  it("dead-letter de fila que saiu do código continua listada, mas não é reprocessada", async () => {
    // Nada consome a origem: o replay deixaria o job parado lá para sempre.
    const dlqId = await boss.send(RETIRED_DLQ, { kind: "edited_channel_post", chatId: "-1001234", messageId: 44 });
    expect((await listDeadLetters(10)).map((row) => row.id)).toContain(dlqId);
    await expect(replayDeadLetter(dlqId!, "ui")).rejects.toThrow(/não existe mais/);
    expect(await db.prisma.auditEvent.count({ where: { action: "dlq_replay" } })).toBe(0);
    expect(await jobsNaFila(RETIRED_DLQ)).toBe(1);
    expect(await jobsNaFila(RETIRED_QUEUE)).toBe(0);
  });

  it("dead-letter do Telegram fora do contrato não vira pedido de replay", async () => {
    const dlqId = await boss.send(TELEGRAM_DLQ, { kind: "channel_photo", chatId: "-1001234", messageId: 43 });
    await expect(replayDeadLetter(dlqId!, "ui")).rejects.toThrow(/fora do contrato/);
    expect(await db.prisma.auditEvent.count({ where: { action: "dlq_replay" } })).toBe(0);
    expect(await jobsNaFila(TELEGRAM_DLQ)).toBe(1);
  });

  it("a reconciliação enxerga DLQ antiga que a listagem esconde", async () => {
    // A listagem recorta 14 dias; a caixa de ações NÃO pode recortar, senão uma
    // falha some sozinha por envelhecer, sem ninguém ter olhado.
    const dlqId = await boss.send(DLQ, { betId: "bet-antiga" });
    await db.prisma.$executeRaw`
      UPDATE pgboss.job SET created_on = now() - interval '30 days' WHERE id = ${dlqId}::uuid
    `;
    expect((await listDeadLetters(10)).map((d) => d.id)).not.toContain(dlqId);
    expect((await listDeadLetters(10, null)).map((d) => d.id)).toContain(dlqId);
  });

  it("não lista nem permite replay de DLQ já concluída pelo watcher", async () => {
    const dlqId = await boss.send(DLQ, { betId: "bet-tratada" });
    expect(dlqId).not.toBeNull();
    await db.prisma.$executeRaw`
      UPDATE pgboss.job SET state = 'completed', completed_on = now()
      WHERE id = ${dlqId}::uuid
    `;
    expect((await listDeadLetters(10)).map((d) => d.id)).not.toContain(dlqId);
    expect(await replayDeadLetter(dlqId!, "ui")).toBeNull();
  });

  it("fila exclusive ocupada não bloqueia o replay", async () => {
    // Sem `singletonKey`, o replay disputaria a chave VAZIA com qualquer job
    // pendente da fila e seria recusado — justo o replay em lote quebraria.
    const occupyingId = await boss.send(EXCLUSIVE_QUEUE, { updateId: "ocupando" });
    const dlqId = await boss.send(EXCLUSIVE_DLQ, { updateId: "reenfileirar" });
    expect(occupyingId).not.toBeNull();
    expect(dlqId).not.toBeNull();

    await expect(replayDeadLetter(dlqId!, "ui")).resolves.toMatchObject({
      fila: EXCLUSIVE_QUEUE,
    });
    expect(await jobsNaFila(EXCLUSIVE_QUEUE)).toBe(2);
    expect(await jobsNaFila(EXCLUSIVE_DLQ)).toBe(0);
  });

  it("deduplica contra a unidade original pela mesma singletonKey", async () => {
    const singletonKey = "telegram-update:logical-unit-42";
    const occupyingId = await boss.send(
      EXCLUSIVE_QUEUE,
      { updateId: "unidade-original" },
      { singletonKey },
    );
    const dlqId = await boss.send(
      EXCLUSIVE_DLQ,
      { updateId: "unidade-original" },
      { singletonKey },
    );
    expect(occupyingId).not.toBeNull();
    expect(dlqId).not.toBeNull();

    await expect(replayDeadLetter(dlqId!, "ui")).resolves.toEqual({
      fila: EXCLUSIVE_QUEUE,
    });
    expect(await jobsNaFila(EXCLUSIVE_QUEUE)).toBe(1);
    expect(await jobsNaFila(EXCLUSIVE_DLQ)).toBe(0);
    const audit = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "dlq_replay", resourceId: dlqId! },
    });
    expect(audit).toMatchObject({ outcome: "success" });
    expect(audit.details).toMatchObject({ deduplicado: true, replayJobId: null });
  });

  it("a unidade que falhou de novo depois de um replay não barra o replay seguinte", async () => {
    // D1 → replay → o job falha outra vez e volta como D2; o dono conserta e
    // reprocessa D2 na mesma semana, com o job falho ainda guardado na origem.
    const singletonKey = "album-flush:grupo-1";
    const d1 = await boss.send(EXCLUSIVE_DLQ, { updateId: "album" }, { singletonKey });
    await replayDeadLetter(d1!, "ui");
    await db.prisma.$executeRaw`
      UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE name = ${EXCLUSIVE_QUEUE}
    `;
    const d2 = await boss.send(EXCLUSIVE_DLQ, { updateId: "album" }, { singletonKey });

    await expect(replayDeadLetter(d2!, "ui")).resolves.toEqual({ fila: EXCLUSIVE_QUEUE });
    const estados = await db.prisma.$queryRaw<Array<{ state: string }>>`
      SELECT state::text FROM pgboss.job WHERE name = ${EXCLUSIVE_QUEUE} ORDER BY created_on
    `;
    expect(estados.map((row) => row.state)).toEqual(["failed", "created"]);
    const audit = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "dlq_replay", resourceId: d2! },
    });
    expect(audit.details).not.toHaveProperty("deduplicado");
  });

  it("envio recusado sem unidade viva não apaga a dead-letter nem diz que reprocessou", async () => {
    const dlqId = await boss.send(EXCLUSIVE_DLQ, { updateId: "recusado" }, { singletonKey: "sem-unidade-viva" });
    const audit = await db.prisma.auditEvent.create({
      data: {
        actor: "ui", action: "dlq_replay", resource: "pgboss_job", resourceId: dlqId!, outcome: "pending",
        details: { fila: EXCLUSIVE_QUEUE, payload: { updateId: "recusado" }, executionId: null },
      },
    });
    const refusingBoss = { send: async () => null, deleteJob: boss.deleteJob.bind(boss) } as unknown as PgBoss;

    await expect(dispatchDeadLetterReplayAudit(refusingBoss, audit.id)).rejects.toThrow(/não agendou/);
    expect(await jobsNaFila(EXCLUSIVE_DLQ)).toBe(1);
    await expect(db.prisma.auditEvent.findUniqueOrThrow({ where: { id: audit.id } }))
      .resolves.toMatchObject({ outcome: "failure" });
  });

  it("replay em lote esvazia a DLQ de uma fila exclusive", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await boss.send(EXCLUSIVE_DLQ, { updateId: `lote-${i}` });
      expect(id).not.toBeNull();
      ids.push(id!);
    }

    await expect(replayDeadLetters(ids, "ui")).resolves.toEqual({
      replayed: 3,
      alreadyGone: 0,
      failures: 0,
    });
    expect(await jobsNaFila(EXCLUSIVE_DLQ)).toBe(0);
    expect(await jobsNaFila(EXCLUSIVE_QUEUE)).toBe(3);
  });

  it("replay concorrente do MESMO item não duplica trabalho nem trava", async () => {
    const dlqId = await boss.send(EXCLUSIVE_DLQ, { updateId: "duplo-clique" });
    expect(dlqId).not.toBeNull();
    // Simula o primeiro clique tendo agendado o replay antes do segundo ler a DLQ.
    await boss.send(EXCLUSIVE_QUEUE, { updateId: "duplo-clique" }, {
      singletonKey: `dlq-replay:${dlqId}`,
    });

    await expect(replayDeadLetter(dlqId!, "ui")).resolves.toMatchObject({
      fila: EXCLUSIVE_QUEUE,
    });
    expect(await jobsNaFila(EXCLUSIVE_QUEUE)).toBe(1);
    expect(await jobsNaFila(EXCLUSIVE_DLQ)).toBe(0);
    const audit = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "dlq_replay", resourceId: dlqId! },
    });
    expect(audit.details).toMatchObject({ deduplicado: true, replayJobId: null });
  });

  it("retoma pelo outbox se a resposta se perde após o send e antes do audit final", async () => {
    const singletonKey = "logical-unit:uncertain-send";
    const dlqId = await boss.send(
      EXCLUSIVE_DLQ,
      { updateId: "uncertain-send" },
      { singletonKey },
    );
    const audit = await db.prisma.auditEvent.create({
      data: {
        actor: "ui",
        action: "dlq_replay",
        resource: "pgboss_job",
        resourceId: dlqId!,
        outcome: "pending",
        details: {
          fila: EXCLUSIVE_QUEUE,
          payload: { updateId: "uncertain-send" },
          executionId: null,
        },
      },
    });
    const uncertainBoss = {
      send: async (...args: Parameters<PgBoss["send"]>) => {
        await boss.send(...args);
        throw new Error("socket caiu depois do commit do pg-boss");
      },
    } as unknown as PgBoss;

    await expect(dispatchDeadLetterReplayAudit(uncertainBoss, audit.id)).rejects.toThrow("socket");
    expect(await jobsNaFila(EXCLUSIVE_QUEUE)).toBe(1);
    expect(await jobsNaFila(EXCLUSIVE_DLQ)).toBe(1);
    await expect(db.prisma.auditEvent.findUniqueOrThrow({ where: { id: audit.id } }))
      .resolves.toMatchObject({ outcome: "pending" });

    await expect(dispatchDeadLetterReplayAudit(boss, audit.id)).resolves.toEqual({
      fila: EXCLUSIVE_QUEUE,
    });
    expect(await jobsNaFila(EXCLUSIVE_QUEUE)).toBe(1);
    expect(await jobsNaFila(EXCLUSIVE_DLQ)).toBe(0);
    await expect(db.prisma.auditEvent.findUniqueOrThrow({ where: { id: audit.id } }))
      .resolves.toMatchObject({ outcome: "success" });
  });
});
