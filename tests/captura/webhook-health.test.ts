import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";

const ops = vi.hoisted(() => ({ alert: vi.fn(), resolve: vi.fn() }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: ops.alert }));
vi.mock("@/src/services/ops/operational-actions", () => ({ resolveOperationalActionBySourceKey: ops.resolve }));

const { evaluateWebhook, INITIAL_WEBHOOK_STATE, startWebhookHealthCheck } = await import("@/src/telegram/webhook-health");

const URL = "https://painel.example/api/telegram/webhook";
const NOW = new Date("2026-09-23T12:00:00Z");
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
const info = (patch: Record<string, unknown> = {}) => ({ url: URL, has_custom_certificate: false, pending_update_count: 0, ...patch });
const failing = (at: Date, pending = 0) => info({ last_error_date: seconds(at), last_error_message: "Wrong response from the webhook: 401 Unauthorized", pending_update_count: pending });

/** Checagens seguidas, 5 min entre elas, como o timer do worker. */
function run(infos: ReturnType<typeof info>[]) {
  let state = INITIAL_WEBHOOK_STATE;
  return infos.map((item, index) => {
    const verdict = evaluateWebhook(item, { url: URL, now: minutes(index * 5) }, state);
    state = verdict.state;
    return verdict.problem;
  });
}

describe("evaluateWebhook", () => {
  it("o 502 isolado do deploy não alerta", () => {
    const deploy = minutes(-1);
    expect(run([failing(deploy), failing(deploy), failing(deploy), info()])).toEqual([null, null, null, null]);
  });

  it("erro novo em duas checagens seguidas alerta; voltar ao normal limpa", () => {
    const problems = run([failing(minutes(-1)), failing(minutes(4)), failing(minutes(4)), info()]);
    expect(problems[0]).toBeNull();
    expect(problems[1]).toContain("401 Unauthorized");
    expect(problems.slice(2)).toEqual([null, null]);
  });

  it("erro com a fila crescendo alerta já na segunda checagem, mesmo com o mesmo erro", () => {
    const at = minutes(-1);
    const problems = run([failing(at, 25), failing(at, 40)]);
    expect(problems).toEqual([null, expect.stringContaining("40 updates")]);
  });

  it("endereço trocado alerta na hora", () => {
    expect(run([info({ url: "" })])[0]).toContain("nenhum");
  });
});

describe("startWebhookHealthCheck", () => {
  beforeEach(() => { vi.useFakeTimers(); ops.alert.mockReset(); ops.resolve.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it("alerta quando o erro persiste e fecha o alerta quando volta ao normal", async () => {
    vi.setSystemTime(NOW);
    const getWebhookInfo = vi.fn()
      .mockImplementationOnce(async () => failing(new Date(Date.now())))
      .mockImplementationOnce(async () => failing(new Date(Date.now())))
      .mockImplementationOnce(async () => info());
    startWebhookHealthCheck({ getWebhookInfo } as unknown as Api, URL);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ops.alert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ops.alert).toHaveBeenCalledWith(expect.stringContaining("401 Unauthorized"), expect.objectContaining({ source: "telegram.webhook" }));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(ops.resolve).toHaveBeenCalledWith("telegram.webhook", "webhook-health", expect.any(String));
  });
});
