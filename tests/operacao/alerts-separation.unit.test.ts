import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reportOperationalAction: vi.fn(),
  findThrottle: vi.fn(),
  findClosedProviders: vi.fn(),
  findStaleThrottles: vi.fn(),
  deleteStaleThrottles: vi.fn(),
  transaction: vi.fn(),
  env: {
    TELEGRAM_NOTIFICATION_BOT_TOKEN: undefined as string | undefined,
    TELEGRAM_NOTIFICATION_CHAT_ID: undefined as string | undefined,
  },
}));

vi.mock("@/src/infra/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/src/infra/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    auditEvent: {
      findFirst: mocks.findThrottle,
      create: vi.fn(),
      findMany: mocks.findStaleThrottles,
      deleteMany: mocks.deleteStaleThrottles,
    },
    providerCircuit: { findMany: mocks.findClosedProviders },
  },
}));
vi.mock("@/src/services/ops/operational-actions", async (original) => ({
  ...await original<Record<string, unknown>>(),
  reportOperationalAction: mocks.reportOperationalAction,
}));

const {
  autoResolveStaleOperationalAlerts,
  persistOperationalAlert,
  sendOperationalAlert,
  sendOperationalAlertEvenIfDatabaseDown,
  sendOperatorNotification,
} = await import("@/src/services/ops/alerts");

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = undefined;
  mocks.env.TELEGRAM_NOTIFICATION_CHAT_ID = undefined;
});

describe("separação entre notificação e ação acionável", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findThrottle.mockResolvedValue(null);
    mocks.reportOperationalAction.mockResolvedValue({ id: "action-1" });
    mocks.findClosedProviders.mockResolvedValue([]);
    mocks.findStaleThrottles.mockResolvedValue([]);
    mocks.deleteStaleThrottles.mockResolvedValue({ count: 0 });
  });

  it("notificação de rotina nunca persiste ação", async () => {
    await expect(sendOperatorNotification("Aposta registrada com sucesso")).resolves.toBe(false);
    expect(mocks.reportOperationalAction).not.toHaveBeenCalled();
  });

  it("alerta acionável persiste contexto antes de tentar a entrega", async () => {
    await expect(
      sendOperationalAlert("Falha ao processar aposta bet-1", {
        source: "test.failure",
        key: "bet-1",
        title: "Falha de teste",
        resource: "bet",
        resourceId: "bet-1",
      }),
    ).resolves.toBe(false);

    expect(mocks.reportOperationalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "test.failure",
        key: "bet-1",
        area: "incidentes",
        actionType: "incident.review",
        title: "Falha de teste",
        resource: "bet",
        resourceId: "bet-1",
      }),
      expect.any(Date),
    );
  });

  it("refresh persistente não tenta uma nova entrega", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(persistOperationalAlert(
      "Falha ainda presente",
      {
        source: "vps-monitor",
        key: "infra:vps:anomaly",
        title: "Alerta de infraestrutura",
      },
      { incrementOccurrence: false },
    )).resolves.toBeUndefined();

    expect(mocks.reportOperationalAction).toHaveBeenCalledWith(
      expect.objectContaining({ incrementOccurrence: false }),
      expect.any(Date),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("não engole falha ao persistir a ação", async () => {
    mocks.reportOperationalAction.mockRejectedValueOnce(new Error("banco indisponível"));
    await expect(
      sendOperationalAlert("Falha crítica", {
        source: "test.failure",
        key: "critical",
        title: "Falha crítica",
      }),
    ).rejects.toThrow("banco indisponível");
  });

  it("com o banco fora, o aviso de queda sai pelo Telegram mesmo sem a caixa de ações", async () => {
    mocks.env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "bot-token";
    mocks.env.TELEGRAM_NOTIFICATION_CHAT_ID = "42";
    mocks.reportOperationalAction.mockRejectedValueOnce(new Error("banco indisponível"));
    mocks.transaction.mockRejectedValueOnce(new Error("banco indisponível"));
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(sendOperationalAlertEvenIfDatabaseDown("🛑 O banco não responde há 20 min", {
      source: "health.outage",
      key: "database",
      title: "Banco fora do ar",
    })).resolves.toBe(true);
    expect(mocks.reportOperationalAction).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body)) as { chat_id: string; text: string };
    expect(body).toEqual({ chat_id: "42", text: "🛑 O banco não responde há 20 min" });
  });

  /**
   * A identidade do provider vem do que o ALERTA declarou (`resource:
   * "provider"`), gravado no throttle — comparada por igualdade.
   *
   * Casar por `fingerprint.includes(provider)` não serve: o fingerprint carrega
   * o `source` inteiro, e toda a família `settlement.flashscore*` casaria com
   * "flashscore" e teria o throttle apagado a cada heartbeat enquanto o breaker
   * estivesse CLOSED — o estado SAUDÁVEL —, anulando a escada de silêncio.
   */
  it("só limpa throttle do provider cujo breaker fechou", async () => {
    mocks.findClosedProviders.mockResolvedValue([{ provider: "bridgeodds" }]);
    mocks.findStaleThrottles.mockResolvedValue([
      { resourceId: "op:budget:bridgeodds:aaa", details: { provider: "bridgeodds" } },
      { resourceId: "op:budget:pinnacle17:bbb", details: { provider: "pinnacle17" } },
      // Alerta de SETTLEMENT que só menciona o provider no nome do source:
      // não é sobre a saúde dele e não pode ser limpo pelo breaker.
      { resourceId: "op:settlement.bridgeodds-recheck:bet-1:ccc", details: {} },
    ]);
    mocks.deleteStaleThrottles.mockResolvedValue({ count: 1 });

    await expect(autoResolveStaleOperationalAlerts()).resolves.toBe(1);
    expect(mocks.deleteStaleThrottles).toHaveBeenCalledWith({
      where: {
        action: "ops.alert_throttle",
        resource: "ops.alert",
        resourceId: { in: ["op:budget:bridgeodds:aaa"] },
      },
    });
  });
});
