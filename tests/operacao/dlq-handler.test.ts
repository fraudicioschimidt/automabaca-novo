import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, PgBoss } from "pg-boss";

const mocks = vi.hoisted(() => ({
  count: vi.fn(), record: vi.fn(), retained: vi.fn(), send: vi.fn(), notify: vi.fn(), findUnique: vi.fn(),
  tickDiscards: vi.fn(), countTicks: vi.fn(async () => 1), raiseOnce: vi.fn(),
  bankrolls: vi.fn(async () => [] as Array<{ nome: string; telegramChannelId: bigint }>),
}));
vi.mock("@/src/infra/prisma", () => ({
  prisma: { bet: { findUnique: mocks.findUnique }, bankroll: { findMany: mocks.bankrolls } },
}));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperatorNotification: mocks.notify, sendOperationalAlert: vi.fn(), raiseOperationalAlertOnce: mocks.raiseOnce,
}));
vi.mock("@/src/services/ops/dlq/repository", () => ({
  countDeadLetterRequeues: mocks.count, recordDeadLetterRequeue: mocks.record,
  recordDeadLetterRetained: mocks.retained, hasRetainedDeadLetter: async () => false,
  findOriginalDeadLetterMetadata: vi.fn(), isBetStillPendingForDlq: vi.fn(),
  recordDeadLetterDiscards: vi.fn(), dlqPerdeuAssunto: async () => false,
  recordScheduledTickDiscards: mocks.tickDiscards, countScheduledTickDiscards: mocks.countTicks,
  findRetainedDeadLetterErrors: vi.fn(async () => new Map()),
}));
import { handleDeadLetterBatch, transientStartAfterSeconds } from "@/src/services/ops/dlq/handler";
import { recoverDlqSingletonKey } from "@/src/infra/queue-contract";

type Repository = typeof import("@/src/services/ops/dlq/repository");
const { isBetStillPendingForDlq } = await vi.importActual<Repository>("@/src/services/ops/dlq/repository");

describe("estado da tip no requeue da DLQ", () => {
  beforeEach(() => mocks.findUnique.mockReset());

  it("só considera elegível tip existente, ativa e PENDING", async () => {
    mocks.findUnique.mockResolvedValueOnce({ status: "PENDING", deletedAt: null });
    await expect(isBetStillPendingForDlq("bet-1")).resolves.toBe(true);

    mocks.findUnique.mockResolvedValueOnce({ status: "WON", deletedAt: null });
    await expect(isBetStillPendingForDlq("bet-1")).resolves.toBe(false);

    mocks.findUnique.mockResolvedValueOnce({ status: "PENDING", deletedAt: new Date() });
    await expect(isBetStillPendingForDlq("bet-1")).resolves.toBe(false);
  });

  it("propaga indisponibilidade do banco em vez de convertê-la em descarte", async () => {
    const failure = new Error("database unavailable");
    mocks.findUnique.mockRejectedValueOnce(failure);
    await expect(isBetStillPendingForDlq("bet-1")).rejects.toBe(failure);
  });
});

describe("cadência do requeue transitório", () => {
  it("usa cadência rápida de 120s para filas telegram e 7200s para as demais", () => {
    expect(transientStartAfterSeconds("telegram.updates")).toBe(120);
    expect(transientStartAfterSeconds("telegram.deferred")).toBe(120);
    expect(transientStartAfterSeconds("sharp.enrich")).toBe(7200);
  });

  it("espaça falhas persistentes sem mudar a cadência das outras filas", () => {
    expect([0, 1, 2].map((attempt) => transientStartAfterSeconds("telegram.updates", attempt)))
      .toEqual([120, 600, 1800]);
    expect(transientStartAfterSeconds("telegram.updates", 10)).toBe(1800);
    expect(transientStartAfterSeconds("sharp.enrich", 2)).toBe(7200);
  });
});

describe("requeue transitório com falhas persistidas", () => {
  const job = {
    id: "synthetic-dlq", name: "closing.price_series.dlq", data: { betId: "bet-1" },
    sourceId: "synthetic-original", singletonKey: "closing-series:bet-1",
    sourceOutput: { name: "Error", message: "fetch failed" },
  } as unknown as Job;
  const run = () => handleDeadLetterBatch({ send: mocks.send } as unknown as PgBoss, "closing.price_series", {}, [job]);

  beforeEach(() => { vi.clearAllMocks(); mocks.send.mockResolvedValue("next-job"); });

  it("agenda a recuperação seguinte mantendo o payload original e a dedupe", async () => {
    mocks.count.mockResolvedValue(1);
    await run();
    expect(mocks.send).toHaveBeenCalledWith("closing.price_series", job.data, { startAfter: 7200, singletonKey: "closing-series:bet-1" });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ startAfterSeconds: 7200, requeuedJobId: "next-job" }));
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("retém o item quando o orçamento de requeues acaba, em vez de reenviar para sempre", async () => {
    mocks.count.mockResolvedValue(3);
    await expect(run()).rejects.toThrow("retida para replay manual");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.retained).toHaveBeenCalledWith(expect.objectContaining({ jobId: job.id, classification: "transient" }));
  });

  it("update do Telegram sem a origem volta pela fila ordenada, no fim da chave do post", async () => {
    mocks.count.mockResolvedValue(1);
    const photo = {
      kind: "channel_photo", chatId: "-1001", messageId: 1, caption: "", postDate: "2026-09-20T12:00:00.000Z", fileId: "f",
    };
    await handleDeadLetterBatch({ send: mocks.send } as unknown as PgBoss, "telegram.updates", {}, [{
      id: "dlq-tg", name: "telegram.updates.dlq", data: { ...photo, _observability: { correlationId: "job_original" } },
      sourceOutput: { name: "TelegramParseRetryError", message: "Cascata indisponível" },
    } as unknown as Job]);
    expect(mocks.send).toHaveBeenCalledWith(
      "telegram.updates",
      { ...photo, _observability: { correlationId: "job_original" } },
      expect.objectContaining({ singletonKey: "tg:-1001:msg:1", group: { id: "-1001" }, startAfter: 600, id: expect.any(String) }),
    );
    expect(mocks.send.mock.calls[0]?.[2]).not.toHaveProperty("singletonSeconds");
  });
});

describe("aviso de dead-letter retida das filas telegram", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.bankrolls.mockResolvedValue([]); });
  const boss = { deleteJob: async () => undefined } as unknown as PgBoss;
  const retain = (data: object, sourceOutput: object) => handleDeadLetterBatch(boss, "telegram.updates", {}, [
    { id: "dlq-1", name: "telegram.updates.dlq", data, sourceId: "original", singletonKey: "k", sourceOutput } as unknown as Job,
  ]).catch(() => undefined);

  it("recusa de negócio diz banca, post e trecho, sem 🛑", async () => {
    mocks.bankrolls.mockResolvedValue([{ nome: "Tipster Alfa", telegramChannelId: -1001234567890n }]);
    await retain(
      { kind: "edited_channel_post", chatId: "-1001234567890", messageId: 42, text: "Flamengo x Vasco\nOver 2.5 @1.90   1u", postDate: "2026-09-20T12:00:00Z" },
      { name: "InvalidSettlementMarketError", message: "A aposta possui kickoff provisório.", businessRefusal: true },
    );
    const message = String(mocks.notify.mock.calls[0]?.[0]);
    expect(message).toMatch(/^⚠️ Tarefa recusada pela regra · telegram\.updates/);
    expect(message).toContain("Tipster Tipster Alfa · mensagem 42 do canal -1001234567890 (https://t.me/c/1234567890/42)");
    expect(message).toContain("“Flamengo x Vasco Over 2.5 @1.90 1u”");
    expect(message).toContain("👉 Se o post era aposta, registre-a à mão");
    expect(mocks.retained).toHaveBeenCalledWith(expect.objectContaining({ classification: "business" }));
  });

  it("recusa que o tempo resolve diz quando reprocessar e guarda a espera na retenção", async () => {
    await retain(
      { kind: "edited_channel_post", chatId: "-1001234567890", messageId: 43, text: "Green", postDate: "2026-09-20T12:00:00Z" },
      { name: "RecusaDeNegocioError", message: "Este evento é futuro.", businessRefusal: true, waitsFor: "o evento começar" },
    );
    const message = String(mocks.notify.mock.calls[0]?.[0]);
    expect(message).toMatch(/^⚠️ Tarefa recusada pela regra/);
    expect(message).toContain("isso se resolve quando o evento começar");
    expect(message).toContain("👉 Quando o evento começar, reprocesse em Monitoramento");
    expect(message).not.toContain("enquanto o dado não mudar");
    expect(mocks.retained).toHaveBeenCalledWith(expect.objectContaining({ classification: "business", waitsFor: "o evento começar" }));
  });

  it("falha de DM não expõe texto nem chat da conversa", async () => {
    await retain({ kind: "dm_message", chatId: "5550001", messageId: 9, text: "texto privado do dono", postDate: "2026-09-20T12:00:00Z" },
      { name: "Error", message: "boom" });
    const message = String(mocks.notify.mock.calls[0]?.[0]);
    expect(message).toMatch(/^🛑 Tarefa esgotou as tentativas/);
    expect(message).toContain("Mensagem 9 da conversa com o bot");
    expect(message).not.toContain("texto privado");
    expect(message).not.toContain("5550001");
  });
});

describe("recoverDlqSingletonKey", () => {
  it("preserva metadata e reconstrói dedupe de jobs legados", () => {
    expect(recoverDlqSingletonKey({
      name: "sharp.enrich",
      data: { betId: "bet-1" },
      metadataKey: null,
    })).toBe("bet:bet-1");
    expect(recoverDlqSingletonKey({
      name: "telegram.updates",
      data: {},
      metadataKey: "original",
    })).toBe("original");
  });
});

describe("dead-letter de fila agendada", () => {
  const tick = {
    id: "tick-dlq", name: "closing.sync.dlq", data: null, sourceId: "tick-original",
    sourceOutput: { name: "Error", message: "fetch failed" },
  } as unknown as Job;
  const deleteJob = vi.fn();
  const run = () => handleDeadLetterBatch(
    { send: mocks.send, deleteJob } as unknown as PgBoss, "closing.sync", { cronMaxGapMinutes: 5 }, [tick],
  );

  beforeEach(() => { vi.clearAllMocks(); mocks.countTicks.mockResolvedValue(1); });

  it("cron curto: não volta nem fica retido; o próximo disparo refaz", async () => {
    // Voltar com espera e sem chave ocuparia a vaga da fila exclusive, e os
    // disparos do cron seriam descartados até ele rodar.
    await expect(run()).resolves.toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.retained).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.tickDiscards).toHaveBeenCalledWith([expect.objectContaining({
      queue: "closing.sync", jobId: "tick-dlq", errorMessage: "fetch failed", classification: "transient",
    })]);
    expect(deleteJob).toHaveBeenCalledWith("closing.sync.dlq", "tick-dlq");
    expect(mocks.raiseOnce).not.toHaveBeenCalled();
  });

  it("a falha que se repete vira um aviso só, pela fila", async () => {
    mocks.countTicks.mockResolvedValue(3);
    await run();
    expect(mocks.raiseOnce).toHaveBeenCalledTimes(1);
    expect(mocks.raiseOnce).toHaveBeenCalledWith(
      expect.stringContaining("Tarefa agendada falhando de novo · closing.sync"),
      expect.objectContaining({ source: "jobs.scheduled-failure", key: "closing.sync", resourceId: "closing.sync" }),
    );
  });

  describe("cron longo", () => {
    const briefing = (data: unknown = null) => ({
      id: "briefing-dlq", name: "executive.briefing.dlq", data, sourceId: "briefing-00-05",
      sourceOutput: { name: "Error", message: "Falha ao entregar notificação obrigatória ao operador (network_error)." },
    }) as unknown as Job;
    const runBriefing = (job: Job) => handleDeadLetterBatch(
      { send: mocks.send, deleteJob } as unknown as PgBoss, "executive.briefing", { cronMaxGapMinutes: 1440 }, [job],
    );

    it("o disparo que falhou volta à fila com chave própria e roda de novo em 2 h", async () => {
      // Descartar faria o briefing do dia não sair: o próximo disparo é amanhã.
      await runBriefing(briefing());
      expect(mocks.send).toHaveBeenCalledWith(
        "executive.briefing",
        { scheduledRetry: { origin: "briefing-00-05", attempt: 1 } },
        { singletonKey: "scheduled-retry:briefing-00-05", startAfter: 7200 },
      );
      expect(deleteJob).toHaveBeenCalledWith("executive.briefing.dlq", "briefing-dlq");
      expect(mocks.tickDiscards).toHaveBeenCalledWith([expect.objectContaining({ retry: { attempt: 1, startAfterSeconds: 7200 } })]);
      expect(mocks.retained).not.toHaveBeenCalled();
      expect(mocks.raiseOnce).not.toHaveBeenCalled();
    });

    it("a segunda falha conta sobre o mesmo disparo; na terceira retentativa esgotada, avisa", async () => {
      await runBriefing(briefing({ scheduledRetry: { origin: "briefing-00-05", attempt: 1 } }));
      expect(mocks.send).toHaveBeenCalledWith("executive.briefing",
        { scheduledRetry: { origin: "briefing-00-05", attempt: 2 } }, expect.objectContaining({ singletonKey: "scheduled-retry:briefing-00-05" }));

      vi.clearAllMocks();
      await runBriefing(briefing({ scheduledRetry: { origin: "briefing-00-05", attempt: 3 } }));
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.raiseOnce).toHaveBeenCalledWith(
        expect.stringContaining("Tarefa agendada não rodou · executive.briefing"),
        expect.objectContaining({ source: "jobs.scheduled-failure", key: "executive.briefing" }),
      );
    });

    it("cron de 2 em 2 h volta em 1 h, sem cair no disparo seguinte", async () => {
      await handleDeadLetterBatch({ send: mocks.send, deleteJob } as unknown as PgBoss, "settlement.ia_judge",
        { cronMaxGapMinutes: 120 }, [{ ...briefing(), name: "settlement.ia_judge.dlq" } as unknown as Job]);
      expect(mocks.send).toHaveBeenCalledWith("settlement.ia_judge", expect.anything(),
        expect.objectContaining({ startAfter: 3600 }));
    });
  });
});
