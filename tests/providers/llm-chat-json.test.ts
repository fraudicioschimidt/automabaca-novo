import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";

const mocks = vi.hoisted(() => ({
  tripBreaker: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/src/infra/circuit-breaker", () => ({
  isBreakerOpen: vi.fn(async () => false),
  tripBreaker: mocks.tripBreaker,
  closeExpiredBreaker: vi.fn(async () => undefined),
}));
vi.mock("@/src/infra/llm/route-cooldown", () => ({
  llmRouteAvailable: vi.fn(async () => true), reportUnavailableRoute: vi.fn(async (_route: unknown, report: ((outcome: "unavailable", model: string) => void) | undefined, model: string) => report?.("unavailable", model)),
  deferLlmRoute: vi.fn(async () => undefined),
}));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: vi.fn(async () => undefined) }));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ warn: mocks.warn, error: mocks.error, info: vi.fn() }),
}));
// Dois modelos por provedor: a falha do primeiro passa a vez ao segundo.
vi.mock("@/src/infra/llm/models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/infra/llm/models")>(),
  cascadeModels: () => ({ text: ["modelo-a", "modelo-b"], vision: ["modelo-a", "modelo-b"], precisionVision: ["modelo-a", "modelo-b"], ocr: [] }),
}));

const { groqGenerateJson } = await import("@/src/infra/llm/groq");
const { mistralGenerateJson } = await import("@/src/infra/llm/mistral");
const { deferLlmRoute } = await import("@/src/infra/llm/route-cooldown");
const { recordOperationalMetric } = await import("@/src/infra/operational-metrics");
const metric = (name: string) => vi.mocked(recordOperationalMetric).mock.calls.map(([row]) => row).filter((row) => row.name === name);

const chatParams = { parts: [{ text: "tip" }], systemInstruction: "json", responseSchema: {}, label: "errors" };
const chatProviders = [
  { provider: "groq", generate: groqGenerateJson },
  { provider: "mistral", generate: mistralGenerateJson },
];

describe.each(chatProviders)("falhas HTTP do chat $provider", ({ generate }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GROQ_API_KEY", "test");
    vi.stubEnv("MISTRAL_API_KEY", "test");
    vi.stubEnv("LLM_DISABLE_GROQ", "0");
    vi.stubEnv("LLM_DISABLE_MISTRAL", "0");
    vi.stubGlobal("fetch", vi.fn());
    resetEnvCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
  });

  it.each(["null", "[]", "<html>quota</html>"])("respeita 429 com corpo %s", async (body) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(body, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    expect(await generate(chatParams)).toEqual({ ok: true });
    expect(deferLlmRoute).toHaveBeenCalledWith(expect.objectContaining({ model: "modelo-a" }), 429, expect.any(String), null);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // A Groq valida o json_object no servidor: o JSON inválido do modelo volta
  // como 400, com a geração recusada no corpo.
  const jsonValidateFailed = (failedGeneration?: string) => Response.json({ error: {
    message: "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
    type: "invalid_request_error", code: "json_validate_failed",
    ...(failedGeneration === undefined ? {} : { failed_generation: failedGeneration }),
  } }, { status: 400 });

  it("400 json_validate_failed lê a geração recusada como leria um 200", async () => {
    const outcomes: string[] = [];
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonValidateFailed('{"ok": true, "odds": 1.8333,}'))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"other":true}' } }] }));
    expect(await generate({ ...chatParams, onRouteOutcome: (outcome) => { outcomes.push(outcome); } })).toEqual({ ok: true, odds: 1.8333 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["responded"]);
    // O transporte funcionou: a tentativa aceita grava 200, como num 2xx.
    expect(metric("llm.attempt")).toEqual([expect.objectContaining({ statusCode: 200, outcome: "success", labels: expect.objectContaining({ result: "accepted" }) })]);
    expect(metric("llm.transport.groq.chat").concat(metric("llm.transport.mistral.chat"))).toEqual([expect.objectContaining({ statusCode: 200, outcome: "success" })]);
  });

  it("geração recusada vazia fecha como JSON inválido, não como queda", async () => {
    const outcomes: string[] = [];
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonValidateFailed(""))
      .mockResolvedValueOnce(jsonValidateFailed("  "));
    expect(await generate({ ...chatParams, onRouteOutcome: (outcome, model) => { outcomes.push(`${model}:${outcome}`); } })).toBeNull();
    expect(outcomes).toEqual(["modelo-a:responded", "modelo-b:responded"]);
    expect(metric("llm.attempt").map((row) => [row.statusCode, row.labels?.result])).toEqual([[200, "invalid_json"], [200, "invalid_json"]]);
  });

  it("JSON recusado sem geração aproveitável conta como resposta, não como queda da rota", async () => {
    const outcomes: string[] = [];
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonValidateFailed())
      .mockResolvedValueOnce(jsonValidateFailed('{"isBet": true, "bets": [{"odds": 1.9'))
      .mockResolvedValueOnce(Response.json({ error: { message: "Invalid model or request" } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    const onRouteOutcome = (outcome: string, model: string) => { outcomes.push(`${model}:${outcome}`); };
    expect(await generate({ ...chatParams, onRouteOutcome })).toBeNull();
    expect(outcomes).toEqual(["modelo-a:responded", "modelo-b:responded"]);
    expect(deferLlmRoute).not.toHaveBeenCalled();
    // Outro 400 continua sendo erro da rota.
    expect(await generate({ ...chatParams, onRouteOutcome })).toEqual({ ok: true });
    expect(outcomes.slice(2)).toEqual(["modelo-a:unavailable", "modelo-b:responded"]);
    expect(deferLlmRoute).toHaveBeenCalledWith(expect.objectContaining({ model: "modelo-a" }), 400, "Invalid model or request", null);
    expect(mocks.tripBreaker).not.toHaveBeenCalled();
  });

  it("recusa corpo acima do teto antes de interpretar JSON e libera o stream", async () => {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '{"partial":true}' } }] }))); controller.close(); },
      cancel,
    }), { headers: { "content-length": String(25 * 1024 * 1024 + 1) } }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"complete":true}' } }] }));
    expect(await generate(chatParams)).toEqual({ complete: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["content_filter", "tool_calls"])("não aceita JSON interrompido por %s", async (finish_reason) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ choices: [{ finish_reason, message: { content: '{"partial":true}' } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"complete":true}' } }] }));
    expect(await generate(chatParams)).toEqual({ complete: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejeita um envelope malformado e tenta o próximo modelo", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: { unexpected: true } } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    expect(await generate(chatParams)).toEqual({ ok: true });
    expect(mocks.warn).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining("envelope inválido"));
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.tripBreaker).not.toHaveBeenCalled();
  });
});
