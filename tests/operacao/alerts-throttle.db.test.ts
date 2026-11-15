import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import {
  autoResolveStaleOperationalAlerts,
  getOperationalAlertFingerprint,
  sendOperationalAlert,
  raiseOperationalAlertOnce,
  sendOperatorNotification,
  sendRequiredOperatorNotification,
} from "@/src/services/ops/alerts";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;

/** A resposta do Telegram a quem manda rápido demais. */
function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: retryAfterSeconds } }),
    { status: 429 },
  );
}

const originalToken = process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
const originalChatId = process.env.TELEGRAM_NOTIFICATION_CHAT_ID;

beforeAll(() => {
  process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_NOTIFICATION_CHAT_ID = "123";
  resetEnvCacheForTests();
  db = createTestDb();
});

afterAll(async () => {
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
});

describe("throttle de alertas entre processos", () => {
  it("incidente aberto retenta aviso recusado e para só depois da entrega", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = { source: "test.once", key: "outage", title: "Incidente de teste" };
    await raiseOperationalAlertOnce("Incidente persistente", context);
    await raiseOperationalAlertOnce("Incidente persistente", context);
    await raiseOperationalAlertOnce("Incidente persistente", context);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([200, 503])("envio concorrente HTTP %s só gera recibo após entrega confirmada", async (status) => {
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      start(); await finished;
      return new Response("{}", { status });
    }).mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = { source: "test.once", key: "concurrent", title: "Incidente de teste" };
    const first = raiseOperationalAlertOnce("Incidente persistente", context);
    await started;
    try {
      await expect(raiseOperationalAlertOnce("Incidente persistente", context)).resolves.toBe(false);
      expect(await db.prisma.auditEvent.count({ where: { action: "ops.alert_once_delivered" } })).toBe(0);
    } finally { finish(); await first; }
    await expect(first).resolves.toBe(status === 200);
    await expect(raiseOperationalAlertOnce("Incidente persistente", context)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(status === 200 ? 1 : 2);
    expect(await db.prisma.auditEvent.count({ where: { action: "ops.alert_once_delivered" } })).toBe(1);
  });

  it("incidente reaberto recebe aviso próprio mesmo dentro do silêncio anterior", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = { source: "test.once", key: "outage", title: "Incidente de teste" };
    await raiseOperationalAlertOnce("Incidente persistente", context);
    await db.prisma.operationalAction.updateMany({ data: { status: "RESOLVED", resolvedAt: new Date() } });
    await raiseOperationalAlertOnce("Incidente persistente", context);
    await raiseOperationalAlertOnce("Incidente persistente", context);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retentativa do mesmo recurso deduplica, mas outro recurso com o mesmo texto entrega", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendOperatorNotification("Mesmo resultado", { key: "settlement:primeiro:0" })).resolves.toBe(true);
    await expect(sendOperatorNotification("Mesmo resultado", { key: "settlement:primeiro:0" })).resolves.toBe(false);
    await expect(sendOperatorNotification("Mesmo resultado", { key: "settlement:segundo:0" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([
    [200, false], [503, false], [200, true], [503, true],
  ] as const)("envio em voo com HTTP %s e chave explícita %s não confirma outra entrega", async (status, explicitKey) => {
    let start!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      start();
      await finished;
      return new Response("{}", { status });
    }).mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const dedupe = explicitKey ? { key: "concurrent-digest", forMs: 86_400_000 } : undefined;
    const first = sendRequiredOperatorNotification("Resumo concorrente", dedupe).then(
      (value) => value,
      (error: unknown) => error,
    );
    await started;
    try {
      await expect(sendRequiredOperatorNotification("Resumo concorrente", dedupe)).rejects.toThrow("in_flight");
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { finish(); await first; }
    if (status === 503) {
      expect(await first).toBeInstanceOf(Error);
      await expect(sendRequiredOperatorNotification("Resumo concorrente", dedupe)).resolves.toBe("delivered");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
    await expect(sendRequiredOperatorNotification("Resumo concorrente", dedupe)).resolves.toBe("deduplicated");
  });

  it("reserva órfã vence antes do retry e não sobe a escada sem uma entrega", async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await db.prisma.auditEvent.create({ data: {
        action: "ops.alert_throttle", resource: "ops.alert", resourceId: "notif:orphaned",
        details: { expiresAt: new Date(start + 120_000).toISOString(), inFlight: true, streak: 2 },
      } });
      const dedupe = { key: "orphaned", forMs: 86_400_000 };
      await expect(sendRequiredOperatorNotification("Resumo interrompido", dedupe)).rejects.toThrow("in_flight");
      expect(fetchMock).not.toHaveBeenCalled();
      vi.setSystemTime(start + 300_000);
      await expect(sendRequiredOperatorNotification("Resumo interrompido", dedupe)).resolves.toBe("delivered");
      const row = await db.prisma.auditEvent.findFirstOrThrow({ where: { resourceId: "notif:orphaned" }, orderBy: { createdAt: "desc" } });
      expect(row.details).toMatchObject({ streak: 2 });
      expect((row.details as { inFlight?: boolean }).inFlight).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("retry_after de vinte minutos não permite tentar novamente aos dez", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tooManyRequests(1200))
      .mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      await expect(sendRequiredOperatorNotification("Espera longa")).rejects.toThrow("rate_limited");
      vi.setSystemTime(start + 601_000);
      await expect(sendRequiredOperatorNotification("Espera longa")).rejects.toThrow("rate_limited");
      expect(fetchMock).toHaveBeenCalledOnce();
      vi.setSystemTime(start + 1201_000);
      await expect(sendRequiredOperatorNotification("Espera longa")).resolves.toBe("delivered");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("aviso de lote grande cabe no Telegram e conserva a ação de revisão", async () => {
    const message = `📥 10 apostas novas
${(`• ${"Time ".repeat(40)} — ${"Seleção ".repeat(35)} @1.90 · 1u
`).repeat(10)}`;
    let sentText = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      sentText = (JSON.parse(String(init.body)) as { text: string }).text;
      return new Response("{}", { status: Array.from(sentText).length <= 4096 ? 200 : 400 });
    }));
    await expect(sendOperationalAlert(message, { source: "test.large", key: "batch", title: "Lote para revisão", evidence: { batchSize: 10, lastItem: "última seleção do lote" } })).resolves.toBe(true);
    expect(Array.from(sentText).length).toBeLessThanOrEqual(3900);
    expect(sentText).toContain("mensagem truncada; veja o painel.");
    expect(await db.prisma.operationalAction.findFirstOrThrow()).toMatchObject({
      fingerprint: expect.stringMatching(/^test\.large:/), title: "Lote para revisão", status: "OPEN",
      evidence: { batchSize: 10, lastItem: "última seleção do lote" },
    });
  });

  it("entrega obrigatória aceita dedupe, mas rejeita falha real de transporte", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("indisponível", { status: 503 }))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendRequiredOperatorNotification("Digest A")).resolves.toBe("delivered");
    await expect(sendRequiredOperatorNotification("Digest A")).resolves.toBe("deduplicated");
    await expect(sendRequiredOperatorNotification("Digest B")).rejects.toThrow("http_error");
    await expect(sendRequiredOperatorNotification("Digest C")).rejects.toThrow("network_error");
  });

  /**
   * O pg-boss tenta de novo o digest em 5 a 10 min, antes de a reserva de 10
   * min vencer: a reserva do envio que o Telegram recusou não pode passar por
   * entrega, senão o resumo do dia some com o log dizendo "entregue".
   */
  it("429 do Telegram: a nova tentativa respeita o retry_after e entrega, sem passar por dedupe", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tooManyRequests(7))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: startedAt });
    try {
      await expect(sendRequiredOperatorNotification("Resumo do dia")).rejects.toThrow("Falha ao entregar");

      // Dentro do retry_after o Telegram recusaria de novo: nem envia, nem alega entrega.
      vi.setSystemTime(startedAt + 3_000);
      await expect(sendRequiredOperatorNotification("Resumo do dia")).rejects.toThrow("rate_limited");
      expect(fetchMock).toHaveBeenCalledOnce();

      // A retentativa do pg-boss (5 min depois) entrega.
      vi.setSystemTime(startedAt + 300_000);
      await expect(sendRequiredOperatorNotification("Resumo do dia")).resolves.toBe("delivered");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expect(sendRequiredOperatorNotification("Resumo do dia")).resolves.toBe("deduplicated");
    } finally {
      vi.useRealTimers();
    }
  });

  it("entrega obrigatória rejeita bot ausente em vez de alegar sucesso", async () => {
    delete process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
    resetEnvCacheForTests();
    try {
      await expect(sendRequiredOperatorNotification("Digest sem bot"))
        .rejects.toThrow("not_configured");
    } finally {
      process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "test-token";
      resetEnvCacheForTests();
    }
  });

  it("reserva atomicamente e entrega só uma cópia concorrente", async () => {
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const delivered = await Promise.all([
      sendOperatorNotification("Falha repetida na fila X"),
      sendOperatorNotification("Falha repetida na fila X"),
    ]);

    expect(delivered.sort()).toEqual([false, true]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("com chave de dedupe, a trava é curta durante o envio e só vale o prazo inteiro depois da entrega", async () => {
    const expiresAt = async () => {
      const row = await db.prisma.auditEvent.findFirstOrThrow({
        where: { action: "ops.alert_throttle", resourceId: "notif:boletim:1" },
      });
      return new Date((row.details as { expiresAt: string }).expiresAt).getTime();
    };
    let duringSend = 0;
    const fetchMock = vi.fn(async () => {
      duringSend = await expiresAt();
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const start = Date.now();
    await expect(sendRequiredOperatorNotification("Boletim", { key: "boletim:1", forMs: 86_400_000 })).resolves.toBe("delivered");

    // O processo que morresse aqui deixaria a chave vencer antes da retentativa (5 min).
    expect(duringSend - start).toBeLessThanOrEqual(3 * 60_000);
    expect(await expiresAt() - start).toBeGreaterThan(23 * 3_600_000);
    await expect(sendRequiredOperatorNotification("Boletim outro número", { key: "boletim:1", forMs: 86_400_000 }))
      .resolves.toBe("deduplicated");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("mantém cooldown fail-safe quando expiresAt está corrompido", async () => {
    // Notificações de rotina usam hash do texto CRU —
    // a fingerprint semeada segue o mesmo formato de sendOperatorNotification.
    const fingerprint = `notif:${createHash("sha256").update("Falha 123").digest("hex").slice(0, 40)}`;
    await db.prisma.auditEvent.create({
      data: {
        action: "ops.alert_throttle",
        resource: "ops.alert",
        resourceId: fingerprint,
        details: { expiresAt: "inválido" },
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOperatorNotification("Falha 123")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("números diferentes NÃO colidem na fingerprint de notificação", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Normalizar números ("[NUM]") colapsaria os dois textos e engoliria a 2ª.
    await expect(sendOperatorNotification("✅ Liquidada: Jogo A (2-1) +1.50u")).resolves.toBe(true);
    await expect(sendOperatorNotification("✅ Liquidada: Jogo A (2-1) +0.75u")).resolves.toBe(true);
    // Texto idêntico (retry) continua deduplicado.
    await expect(sendOperatorNotification("✅ Liquidada: Jogo A (2-1) +1.50u")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * Escada de silêncio para a MESMA falha repetida.
 *
 * Os ciclos que mais alertam rodam a cada 15 minutos: um throttle fixo de 10
 * venceria SEMPRE antes da próxima tentativa e nunca suprimiria nada. Alerta
 * que vira papel de parede deixa de ser lido justamente no dia em que traz
 * coisa nova — e a `OperationalAction` continua aberta no painel, que é onde
 * mora o registro durável.
 */
describe("backoff do alerta repetido", () => {
  function semearThrottle(fingerprint: string, params: {
    streak: number;
    venceuHaMs: number;
  }) {
    const agora = Date.now();
    return db.prisma.auditEvent.create({
      data: {
        action: "ops.alert_throttle",
        resource: "ops.alert",
        resourceId: fingerprint,
        details: {
          expiresAt: new Date(agora - params.venceuHaMs).toISOString(),
          streak: params.streak,
        },
      },
    });
  }

  /**
   * O degrau da escada, medido pelo `streak` e conferido contra o `expiresAt`.
   * A comparação do TTL é por FAIXA porque `createdAt` vem do relógio do
   * Postgres e `expiresAt` do relógio do Node — alguns ms de diferença são
   * esperados e não significam nada.
   */
  async function degrau(fingerprint: string): Promise<{ streak: number; ttlMs: number }> {
    const row = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "ops.alert_throttle", resourceId: fingerprint },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, details: true },
    });
    const det = row.details as { expiresAt: string; streak: number };
    return {
      streak: det.streak,
      ttlMs: new Date(det.expiresAt).getTime() - row.createdAt.getTime(),
    };
  }

  const perto = (ttlMs: number, esperadoMs: number) =>
    Math.abs(ttlMs - esperadoMs) < 5_000;

  const fingerprint = (msg: string) =>
    `notif:${createHash("sha256").update(msg).digest("hex").slice(0, 40)}`;

  it("primeira ocorrência silencia por 10 min", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const msg = "Falha nova de rotina";
    await expect(sendOperatorNotification(msg)).resolves.toBe(true);
    const d = await degrau(fingerprint(msg));
    expect(d.streak).toBe(1);
    expect(perto(d.ttlMs, 10 * 60_000)).toBe(true);
  });

  it("falha que NÃO parou sobe a escada em vez de repetir a cada ciclo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const msg = "Falha teimosa";
    const fp = fingerprint(msg);
    // Venceu há 5 min: o ciclo de 15 min bateria de novo exatamente assim.
    await semearThrottle(fp, { streak: 1, venceuHaMs: 5 * 60_000 });

    await expect(sendOperatorNotification(msg)).resolves.toBe(true);
    const d = await degrau(fp);
    expect(d.streak).toBe(2);
    expect(perto(d.ttlMs, 60 * 60_000)).toBe(true);
  });

  it("streak corrompido reinicia em valor seguro sem desativar o throttle", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const msg = "Falha com contador corrompido";
    const fp = fingerprint(msg);
    await semearThrottle(fp, { streak: -4, venceuHaMs: 5 * 60_000 });

    await expect(sendOperatorNotification(msg)).resolves.toBe(true);
    await expect(sendOperatorNotification(msg)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    const d = await degrau(fp);
    expect(d.streak).toBe(2);
    expect(perto(d.ttlMs, 60 * 60_000)).toBe(true);
  });

  it("a escada tem teto de 24h", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const msg = "Falha cronica";
    const fp = fingerprint(msg);
    await semearThrottle(fp, { streak: 9, venceuHaMs: 60_000 });

    await expect(sendOperatorNotification(msg)).resolves.toBe(true);
    const d = await degrau(fp);
    expect(d.streak).toBe(10);
    expect(perto(d.ttlMs, 24 * 60 * 60_000)).toBe(true);
  });

  /**
   * O auto-resolve existe para o próximo alerta de um provider recuperado não
   * nascer abafado — e só isso. Deduzir de quem ele fala por
   * `fingerprint.includes(provider)` faria toda a família
   * `settlement.flashscore*` casar com "flashscore", e com o breaker CLOSED (o
   * estado SAUDÁVEL) o heartbeat apagaria o throttle dela a cada 5 minutos: a
   * escada de silêncio deixaria de valer para esses alertas.
   */
  describe("auto-resolve pelo breaker", () => {
    it("preserva o throttle de alerta de settlement que só cita o provider no nome", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
      await db.prisma.providerCircuit.create({
        data: { provider: "flashscore", state: "CLOSED", failures: 0 },
      });
      await sendOperationalAlert("Falhas na observação FlashScore", {
        source: "settlement.flashscore",
        key: "batch-failure",
        title: "Falhas na observação FlashScore",
        resource: "flashscore",
        autoResolve: false,
      });
      const antes = await db.prisma.auditEvent.count({
        where: { action: "ops.alert_throttle" },
      });
      expect(antes).toBe(1);

      await autoResolveStaleOperationalAlerts();

      expect(
        await db.prisma.auditEvent.count({ where: { action: "ops.alert_throttle" } }),
      ).toBe(1);
    });

    it("limpa o throttle do alerta que DECLARA ser sobre o provider", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
      await db.prisma.providerCircuit.create({
        data: { provider: "flashscore", state: "CLOSED", failures: 0 },
      });
      await sendOperationalAlert("Budget flashscore em 95%", {
        source: "budget",
        key: "flashscore:2026-08-05",
        title: "Budget flashscore em 95%",
        // É esta declaração que autoriza o breaker a resolver o alerta.
        resource: "provider",
        resourceId: "flashscore",
      });

      await autoResolveStaleOperationalAlerts();

      expect(
        await db.prisma.auditEvent.count({ where: { action: "ops.alert_throttle" } }),
      ).toBe(0);
    });

    it("alcança provider recuperado atrás de mais de 200 throttles irrelevantes", async () => {
      await db.prisma.providerCircuit.create({
        data: { provider: "flashscore", state: "CLOSED", failures: 0 },
      });
      await db.prisma.auditEvent.createMany({
        data: Array.from({ length: 1_000 }, (_, index) => ({
          action: "ops.alert_throttle",
          resource: "ops.alert",
          resourceId: `irrelevante-${index}`,
          details: { provider: "pinnacle17", expiresAt: "2026-08-21T00:00:00Z" },
        })),
      });
      await db.prisma.auditEvent.create({
        data: {
          action: "ops.alert_throttle",
          resource: "ops.alert",
          resourceId: "flashscore-recuperado",
          details: { provider: "flashscore", expiresAt: "2026-08-21T00:00:00Z" },
        },
      });

      await expect(autoResolveStaleOperationalAlerts()).resolves.toBe(1);
      expect(await db.prisma.auditEvent.findFirst({
        where: { resourceId: "flashscore-recuperado" },
      })).toBeNull();
      expect(await db.prisma.auditEvent.count({
        where: { action: "ops.alert_throttle" },
      })).toBe(1_000);
    });
  });

  it("429 num alerta operacional não sobe a escada: o alerta não chegou a sair", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tooManyRequests(5))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const context = { source: "teste.telegram-429", key: "rajada", title: "Falha na rajada" };
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: startedAt });
    try {
      await expect(sendOperationalAlert("Falha na rajada", context)).resolves.toBe(false);
      vi.setSystemTime(startedAt + 6_000);
      await expect(sendOperationalAlert("Falha na rajada", context)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const row = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "ops.alert_throttle", resourceId: getOperationalAlertFingerprint(context) },
      orderBy: { createdAt: "desc" },
      select: { details: true },
    });
    const det = row.details as { expiresAt: string; streak: number; rateLimited?: boolean };
    expect(det.streak).toBe(1);
    expect(det.rateLimited).toBeUndefined();
    expect(perto(new Date(det.expiresAt).getTime() - (startedAt + 6_000), 10 * 60_000)).toBe(true);
  });

  it("incidente NOVO recomeça de baixo, não herda o silêncio do antigo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const msg = "Falha que voltou meses depois";
    const fp = fingerprint(msg);
    // Venceu há 3h — fora da janela de recorrência (2h).
    await semearThrottle(fp, { streak: 4, venceuHaMs: 3 * 60 * 60_000 });

    await expect(sendOperatorNotification(msg)).resolves.toBe(true);
    const d = await degrau(fp);
    expect(d.streak).toBe(1);
    expect(perto(d.ttlMs, 10 * 60_000)).toBe(true);
  });
});
