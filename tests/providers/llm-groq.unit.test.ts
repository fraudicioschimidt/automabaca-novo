import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferLlmRoute, reportUnavailableRoute } from "@/src/infra/llm/route-cooldown";
vi.mock("@/src/infra/llm/route-cooldown", () => ({ llmRouteAvailable: vi.fn(async () => true), reportUnavailableRoute: vi.fn(async (_route: unknown, report: ((outcome: "unavailable", model: string) => void) | undefined, model: string) => report?.("unavailable", model)), deferLlmRoute: vi.fn(async () => undefined) }));
import { resetEnvCacheForTests } from "@/src/infra/env";

const tripBreaker = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const isBreakerOpen = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => false);
const closeExpiredBreaker = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);

vi.mock("@/src/infra/circuit-breaker", () => ({
  isBreakerOpen: (...args: unknown[]) => isBreakerOpen(...args),
  tripBreaker: (...args: unknown[]) => tripBreaker(...args),
  closeExpiredBreaker: (...args: unknown[]) => closeExpiredBreaker(...args),
}));
const catalog = vi.hoisted(() => ({ models: { text: [] as string[], vision: [] as string[], precisionVision: [] as string[], ocr: [] as string[] } }));
vi.mock("@/src/infra/llm/models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/infra/llm/models")>(),
  cascadeModels: () => catalog.models,
}));
/** Modelos da Groq no catálogo de teste: os de texto e, se diferentes, os de imagem. */
const setModels = (text: string[], image = text) => { catalog.models = { text, vision: image, precisionVision: image, ocr: [] }; };

const { groqGenerateJson, groqAvailable } = await import("@/src/infra/llm/groq");

const params = {
  parts: [{ text: "post" }],
  systemInstruction: "sys",
  responseSchema: { type: "object" },
  label: "groq-test",
};

const visionParams = {
  parts: [
    { text: "Extraia o bilhete" },
    { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } },
  ],
  systemInstruction: "sys",
  responseSchema: { type: "object" },
  label: "groq-vision-test",
};

beforeEach(() => {
  process.env.GROQ_API_KEY = "gsk_test";
  setModels(["qwen/qwen3.8-27b", "llama-3.2-11b-vision-preview"]);
  delete process.env.LLM_DISABLE_GROQ;
  resetEnvCacheForTests();
  tripBreaker.mockReset();
  isBreakerOpen.mockReset();
  isBreakerOpen.mockResolvedValue(false);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
  delete process.env.LLM_DISABLE_GROQ;
  resetEnvCacheForTests();
});

describe("groqGenerateJson", () => {
  it("usa o modo OCR qualificado apenas em uma imagem comum", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }));
    await groqGenerateJson(visionParams);
    const first = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));
    expect(first).toMatchObject({ reasoning_effort: "none", max_completion_tokens: 1000 });
    for (const other of [params, { ...visionParams, precisionVision: true }, { ...visionParams, parts: [...visionParams.parts, visionParams.parts[1]!] }]) {
      await groqGenerateJson(other);
      const request = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));
      expect(request).not.toHaveProperty("reasoning_effort");
      expect(request).not.toHaveProperty("max_completion_tokens");
    }
  });
  it("envia o schema e reduz saída uma vez ao limite OTPM anunciado", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ error: { message: "Request too large for model in organization on output tokens per minute (OTPM): Limit 1000, Requested 1787." } }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }] }));
    expect(await groqGenerateJson(params)).toEqual({ a: 1 });
    expect(tripBreaker).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body));
    expect(request.max_completion_tokens).toBe(1000);
    expect(request.messages[0].content).toContain(JSON.stringify(params.responseSchema));
  });
  it("o ajuste ao limite de saída não avisa queda: o desfecho é o da nova tentativa", async () => {
    setModels(["qwen/qwen3.8-27b"]);
    const tooLarge = () => Response.json({ error: { message: "Request too large for model in organization on output tokens per minute (OTPM): Limit 1000, Requested 1787." } }, { status: 429 });
    const outcomes: string[] = [];
    const onRouteOutcome = (outcome: string) => { outcomes.push(outcome); };
    vi.mocked(fetch).mockResolvedValueOnce(tooLarge())
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }] }));
    expect(await groqGenerateJson({ ...params, onRouteOutcome })).toEqual({ a: 1 });
    expect(outcomes).toEqual(["responded"]);
    // A nova tentativa tira a rota da rotação (cota do dia): não é queda, e o
    // post não é relançado por causa do primeiro 429.
    outcomes.length = 0;
    vi.mocked(reportUnavailableRoute).mockImplementationOnce(async () => undefined);
    vi.mocked(fetch).mockResolvedValueOnce(tooLarge())
      .mockResolvedValueOnce(Response.json({ error: { message: "Rate limit reached for model on tokens per day (TPD): Limit 500000, Used 500000." } }, { status: 429 }));
    expect(await groqGenerateJson({ ...params, onRouteOutcome })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(outcomes).toEqual([]);
  });
  it("não tenta o próximo modelo quando o chamador dispensa o resto da Groq", async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ choices: [{ message: { content: '{"odds":null}' }, finish_reason: "stop" }] }));
    let read = 0;
    expect(await groqGenerateJson({ ...params, accept: () => { read += 1; return false; },
      skipRemainingModels: (provider) => provider === "groq" && read > 0 })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("avisa a cascata se a rota respondeu ou caiu por transporte, cota ou cooldown", async () => {
    const outcomes: string[] = [];
    const onRouteOutcome = (outcome: string) => { outcomes.push(outcome); };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "overloaded" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }] }));
    await groqGenerateJson({ ...params, onRouteOutcome });
    expect(outcomes).toEqual(["unavailable", "responded"]);
    outcomes.length = 0;
    const { llmRouteAvailable } = await import("@/src/infra/llm/route-cooldown");
    vi.mocked(llmRouteAvailable).mockResolvedValue(false);
    await groqGenerateJson({ ...params, onRouteOutcome });
    expect(outcomes).toEqual(["unavailable", "unavailable"]);
    vi.mocked(llmRouteAvailable).mockResolvedValue(true);
  });
  it("modelo que o orçamento não alcançou avisa a cascata que não foi ouvido", async () => {
    const outcomes: string[] = [];
    await groqGenerateJson({ ...params, deadlineAt: Date.now() - 1, onRouteOutcome: (outcome) => { outcomes.push(outcome); } });
    expect(fetch).not.toHaveBeenCalled();
    expect(outcomes.length).toBeGreaterThan(0);
    expect(new Set(outcomes)).toEqual(new Set(["unavailable"]));
  });
  it("descarta resposta truncada mesmo quando contém JSON válido", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ choices: [{ message: { content: '{"a":1}' }, finish_reason: "length" }] }));
    expect(await groqGenerateJson(params)).toBeNull();
  });
  it("retorna null sem chave", async () => {
    delete process.env.GROQ_API_KEY;
    resetEnvCacheForTests();
    expect(await groqAvailable()).toBe(false);
    expect(await groqGenerateJson(params)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("parseia JSON válido em texto", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"a":1}' } }] }),
    } as Response);
    expect(await groqGenerateJson(params)).toEqual({ a: 1 });
  });

  it("em 429 tripBreaker e retorna null", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "rate limit" } }),
    } as Response);
    expect(await groqGenerateJson(params)).toBeNull();
    expect(deferLlmRoute).toHaveBeenCalledWith(expect.objectContaining({ model: "qwen/qwen3.8-27b" }), 429, expect.any(String), undefined);
  });

  it("retorna null para JSON inválido", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "não é json" } }] }),
    } as Response);
    expect(await groqGenerateJson(params)).toBeNull();
  });

  it("trata erro 400 graciosamente sem disparar tripBreaker", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid model or request" } }),
    } as Response);
    expect(await groqGenerateJson(params)).toBeNull();
    expect(tripBreaker).not.toHaveBeenCalled();
  });

  it("faz fallback para o próximo modelo se o primeiro retornar erro 400", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Model deprecated" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"fallback":true}' } }] }),
      } as Response);

    expect(await groqGenerateJson(params)).toEqual({ fallback: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a imagem vai à lista de imagem do catálogo, e o texto à de texto", async () => {
    setModels(["openai/gpt-oss-120b", "qwen/qwen3.8-27b"], ["qwen/qwen3.8-27b"]);

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"isBet":true,"evento":"A vs B"}' } }] }),
    } as Response);

    const result = await groqGenerateJson(visionParams);
    expect(result).toEqual({ isBet: true, evento: "A vs B" });
    const requestBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(requestBody.model).toBe("qwen/qwen3.8-27b");
    expect(requestBody.messages[1].content[1].type).toBe("image_url");

    await groqGenerateJson(params);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body)).model).toBe("openai/gpt-oss-120b");
  });

  it("rejeita JSON incompleto via accept e avança para o próximo modelo", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"isBet":true,"evento":"A vs B"}' } }] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"isBet":true,"evento":"A vs B","odds":1.90}' } }] }),
      } as Response);

    const result = await groqGenerateJson({
      ...visionParams,
      accept: (data) => {
        const d = data as { odds?: number };
        return typeof d.odds === "number" && d.odds > 1;
      },
    });

    expect(result).toEqual({ isBet: true, evento: "A vs B", odds: 1.90 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
