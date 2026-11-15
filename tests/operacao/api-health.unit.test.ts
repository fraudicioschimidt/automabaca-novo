import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
const queryRawUnsafe = vi.fn();
const metric = vi.fn();
const logError = vi.fn();
vi.mock("@/src/infra/prisma", () => ({
  prisma: { $queryRaw: queryRaw, $queryRawUnsafe: queryRawUnsafe },
  getMetricsPool: () => ({ query: metric }),
}));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError }),
}));
const outageAlert = vi.fn();
const notification = vi.fn();
const resolveAction = vi.fn();
const reconcileSource = vi.fn(async () => 0);
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlertEvenIfDatabaseDown: outageAlert,
  sendRequiredOperatorNotification: notification,
}));
vi.mock("@/src/services/ops/operational-actions", () => ({
  reconcileOperationalActionSource: reconcileSource,
  resolveOperationalActionBySourceKey: resolveAction,
}));

const { GET, resetPublicHealthCache } = await import("@/app/api/health/route");
/** A métrica do health sai sem a resposta esperar: deixa a gravação começar. */
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const request = () => new Request("http://localhost/api/health");
const release = (process.env.AUTOMABACA_RELEASE_SHA ?? "development").slice(0, 12);

beforeEach(() => {
  resetPublicHealthCache();
  queryRaw.mockReset();
  queryRawUnsafe.mockReset();
  queryRawUnsafe.mockResolvedValue([{ held: true }]);
  logError.mockReset();
});

describe("GET /api/health", () => {
  it("falha fechada com 503 quando o Postgres está indisponível", async () => {
    const error = new Error("connection refused");
    queryRaw.mockRejectedValueOnce(error);
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false, db: false, worker: false, heartbeat: "unavailable", release,
    });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: "HEALTH_DATABASE_QUERY_FAILED", err: error }),
      "sonda do banco no health falhou",
    );
  });

  it("reporta banco vivo, mas 503 quando o heartbeat está ausente ou velho", async () => {
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce([
      { completed_on: null },
    ]);
    let response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false, db: true, worker: false, heartbeat: "stale", release,
    });

    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce([
      { completed_on: new Date(Date.now() - 60 * 60_000) },
    ]);
    response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false, db: true, worker: false, heartbeat: "stale", release,
    });
  });

  it("distingue falha da leitura do heartbeat e preserva a causa no log", async () => {
    const error = new Error("pgboss heartbeat relation unavailable");
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]).mockRejectedValueOnce(error);

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      db: true,
      worker: false,
      heartbeat: "unavailable",
      release,
    });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: "HEALTH_HEARTBEAT_QUERY_FAILED", err: error }),
      "consulta do heartbeat do worker falhou",
    );
  });

  it("só retorna 200 quando banco e worker estão saudáveis", async () => {
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce([
      { completed_on: new Date() },
    ]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true, db: true, worker: true, heartbeat: "fresh", release,
    });
  });

  it("503 quando o lock do worker não está preso mesmo com heartbeat fresco (B10)", async () => {
    queryRawUnsafe.mockResolvedValue([{ held: false }]);
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce([
      { completed_on: new Date() },
    ]);
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false, db: true, worker: false, heartbeat: "fresh", release,
    });
  });

  it("não reconsulta o banco no segundo GET dentro de 2s (B06)", async () => {
    queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce([
      { completed_on: new Date() },
    ]);
    const first = await GET(request());
    const second = await GET(request());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe("cache da sondagem pública", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OBSERVABILITY_METRICS_IN_TEST", "true");
    resetPublicHealthCache();
    queryRaw.mockReset();
    queryRaw.mockResolvedValueOnce([{ value: 1 }]).mockResolvedValueOnce([{ completed_on: new Date() }]);
    queryRawUnsafe.mockResolvedValue([{ held: true }]);
    metric.mockResolvedValue({});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("cache evita consultas e escritas repetidas", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await GET(request())).status).toBe(200);
    }
    await settle();
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(metric).toHaveBeenCalledTimes(1);
  });

  it("requisições concorrentes compartilham sondagem e mantêm correlação individual", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => GET(new Request("http://localhost/api/health", {
      headers: { "x-correlation-id": `probe-request-${i}` },
    }))));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await settle();
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(metric).toHaveBeenCalledTimes(1);
    expect(new Set(responses.map((response) => response.headers.get("x-correlation-id"))).size).toBe(20);
  });

  it("expiração reavalia indisponibilidade e grava uma nova métrica", async () => {
    vi.useFakeTimers();
    await GET(request());
    vi.advanceTimersByTime(2001);
    queryRaw.mockRejectedValueOnce(new Error("synthetic outage"));
    expect((await GET(request())).status).toBe(503);
    await settle();
    expect(metric).toHaveBeenCalledTimes(2);
  });

  it("com o status parado grava uma amostra a cada 5 min, e a mudança na hora", async () => {
    // Uma métrica por sonda (a cada 2 s de cache) faria do health quase metade da tabela.
    vi.useFakeTimers();
    const saudavel = () => queryRaw.mockResolvedValueOnce([{ value: 1 }]).mockResolvedValueOnce([{ completed_on: new Date() }]);
    await GET(request());
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(30_000);
      saudavel();
      expect((await GET(request())).status).toBe(200);
    }
    await settle();
    expect(metric).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000);
    saudavel();
    await GET(request());
    await settle();
    expect(metric).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2001);
    queryRaw.mockRejectedValueOnce(new Error("synthetic outage"));
    expect((await GET(request())).status).toBe(503);
    await settle();
    expect(metric).toHaveBeenCalledTimes(3);
    expect(metric.mock.calls[2]?.[1]).toEqual(expect.arrayContaining(["http", "/api/health", "error", 503]));
  });

  it("a resposta não espera a gravação da métrica", async () => {
    metric.mockReturnValue(new Promise(() => undefined));
    expect((await GET(request())).status).toBe(200);
  });
});

describe("aviso de queda pela web", () => {
  const MIN = 60_000;
  // 11:30 em São Paulo, meia hora antes da primeira sonda.
  const lastBeat = new Date("2026-09-24T14:30:00Z");
  const stuckWorker = () => queryRaw.mockResolvedValueOnce([{ value: 1 }]).mockResolvedValueOnce([{ completed_on: lastBeat }]);
  const healthy = () => queryRaw.mockResolvedValueOnce([{ value: 1 }]).mockResolvedValueOnce([{ completed_on: new Date() }]);
  /** Uma sonda do healthcheck do Docker depois de `minutes`, já fora do cache de 2 s. */
  const probeAfter = async (minutes: number) => {
    vi.advanceTimersByTime(minutes * MIN);
    const response = await GET(request());
    await settle();
    return response.status;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T15:00:00Z"));
    outageAlert.mockReset().mockResolvedValue(true);
    notification.mockReset().mockResolvedValue(true);
    resolveAction.mockReset().mockResolvedValue(true);
    reconcileSource.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("worker travado: avisa uma vez aos 20 min fora e, na volta, diz quanto durou", async () => {
    for (const minutes of [0, 10, 9]) {
      stuckWorker();
      expect(await probeAfter(minutes)).toBe(503);
    }
    expect(outageAlert).not.toHaveBeenCalled();

    stuckWorker();
    await probeAfter(1);
    stuckWorker();
    await probeAfter(1);
    expect(outageAlert).toHaveBeenCalledOnce();
    const [message, context] = outageAlert.mock.calls[0] ?? [];
    expect(message).toContain("O worker está travado há 20 min");
    expect(message).toContain("O último heartbeat foi às 11:30");
    expect(context).toEqual(expect.objectContaining({ source: "health.outage", key: "worker", title: "Worker fora do ar" }));

    healthy();
    expect(await probeAfter(9)).toBe(200);
    expect(resolveAction).toHaveBeenCalledWith("health.outage", "worker", expect.stringContaining("30 min"), expect.any(Date));
    expect(notification).toHaveBeenCalledWith("✅ O worker voltou\nO /api/health ficou fora 30 min, de 12:00 a 12:30.");
    expect(reconcileSource).toHaveBeenCalledOnce();
  });

  it("a web que sobe com a produção de pé fecha a queda que ficou aberta, uma vez", async () => {
    healthy();
    await probeAfter(0);
    healthy();
    await probeAfter(1);
    expect(reconcileSource).toHaveBeenCalledOnce();
    expect(reconcileSource).toHaveBeenCalledWith("health.outage", [], expect.any(Date));
  });

  it("o processo fora (sem lock) e o banco fora têm aviso próprio", async () => {
    queryRawUnsafe.mockResolvedValue([{ held: false }]);
    healthy();
    await probeAfter(0);
    healthy();
    await probeAfter(20);
    expect(outageAlert.mock.calls[0]?.[0]).toContain("O worker está fora do ar há 20 min");

    resetPublicHealthCache();
    queryRaw.mockRejectedValueOnce(new Error("connection refused"));
    await probeAfter(0);
    queryRaw.mockRejectedValueOnce(new Error("connection refused"));
    await probeAfter(20);
    expect(outageAlert).toHaveBeenCalledTimes(2);
    expect(outageAlert.mock.calls[1]?.[0]).toContain("O banco não responde há 20 min");
    expect(outageAlert.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ key: "database", title: "Banco fora do ar" }));
  });

  it("retenta aviso não entregue sem repetir a cada sonda", async () => {
    outageAlert.mockResolvedValueOnce(false).mockResolvedValue(true);
    stuckWorker(); await probeAfter(0);
    stuckWorker(); await probeAfter(20);
    stuckWorker(); await probeAfter(0.1);
    expect(outageAlert).toHaveBeenCalledOnce();
    stuckWorker(); await probeAfter(1);
    stuckWorker(); await probeAfter(1);
    expect(outageAlert).toHaveBeenCalledTimes(2);
  });

  it("retenta a conferência inicial da caixa se o banco falhar", async () => {
    reconcileSource.mockRejectedValueOnce(new Error("pool indisponível"));
    healthy(); await probeAfter(0);
    healthy(); await probeAfter(1);
    healthy(); await probeAfter(1);
    expect(reconcileSource).toHaveBeenCalledTimes(2);
  });

  it("retenta fechar a ação recuperada sem repetir o aviso já entregue", async () => {
    stuckWorker(); await probeAfter(0);
    stuckWorker(); await probeAfter(20);
    resolveAction.mockRejectedValueOnce(new Error("pool indisponível"));
    healthy(); await probeAfter(1);
    healthy(); await probeAfter(1);
    healthy(); await probeAfter(1);
    expect(resolveAction).toHaveBeenCalledTimes(2);
    expect(notification).toHaveBeenCalledOnce();
  });

  it("retenta o aviso de recuperação sem reescrever uma ação já fechada", async () => {
    stuckWorker(); await probeAfter(0);
    stuckWorker(); await probeAfter(20);
    notification.mockRejectedValueOnce(new Error("Telegram indisponível")).mockResolvedValue(true);
    healthy(); await probeAfter(1);
    healthy(); await probeAfter(1);
    healthy(); await probeAfter(1);
    expect(resolveAction).toHaveBeenCalledOnce();
    expect(notification).toHaveBeenCalledTimes(2);
    expect(notification.mock.calls[0]).toEqual(notification.mock.calls[1]);
  });

  it("recuperação espera o alerta em andamento antes de fechar a ação", async () => {
    let release!: (delivered: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { release = resolve; });
    outageAlert.mockReturnValueOnce(pending);
    stuckWorker(); await probeAfter(0);
    stuckWorker(); await probeAfter(20);
    healthy(); expect(await probeAfter(1)).toBe(200);
    expect(resolveAction).not.toHaveBeenCalled();
    release(true); await settle();
    expect(resolveAction).toHaveBeenCalledOnce();
    expect(notification).toHaveBeenCalledOnce();
  });

  it("nova queda cancela o aviso de recuperação que ainda não foi entregue", async () => {
    stuckWorker(); await probeAfter(0);
    stuckWorker(); await probeAfter(20);
    notification.mockRejectedValueOnce(new Error("Telegram indisponível"));
    healthy(); await probeAfter(1);
    stuckWorker(); await probeAfter(1);
    stuckWorker(); await probeAfter(20);
    expect(notification).toHaveBeenCalledOnce();
    expect(outageAlert).toHaveBeenCalledTimes(2);
    healthy(); await probeAfter(1);
    expect(notification).toHaveBeenCalledTimes(2);
    expect(notification.mock.calls[1]?.[0]).toContain("de 12:22 a 12:43");
    expect(resolveAction).toHaveBeenCalledTimes(2);
  });

  it("queda curta, como a troca de release, não avisa nem na ida nem na volta", async () => {
    stuckWorker();
    await probeAfter(0);
    stuckWorker();
    await probeAfter(8);
    healthy();
    await probeAfter(1);
    expect(outageAlert).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });
});
