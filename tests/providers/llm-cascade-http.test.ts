import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import type { LlmGenerateJsonParams, LlmProviderId } from "@/src/infra/llm/cascade";

const mocks = vi.hoisted(() => ({
  isBreakerOpen: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => false),
  tripBreaker: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/src/infra/circuit-breaker", () => ({
  isBreakerOpen: mocks.isBreakerOpen,
  tripBreaker: mocks.tripBreaker,
  closeExpiredBreaker: vi.fn(async () => undefined),
}));
// Cada cenário parte de rotas disponíveis; o cooldown persistente é exercitado
// em llm-route-cooldown.db.test.ts. Aqui um HTTP 500 não altera o próximo cenário.
vi.mock("@/src/infra/llm/route-cooldown", () => ({
  llmRouteAvailable: vi.fn(async () => true), reportUnavailableRoute: vi.fn(async (_route: unknown, report: ((outcome: "unavailable", model: string) => void) | undefined, model: string) => report?.("unavailable", model)),
  deferLlmRoute: vi.fn(async () => undefined),
}));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: vi.fn(async () => undefined) }));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ warn: mocks.warn, error: mocks.error, info: vi.fn() }),
}));
// Sem rota lembrada do Gemini: a ordem é a do catálogo.
vi.mock("@/src/infra/prisma", () => ({
  prisma: { llmStickyPreference: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) } },
}));

const { llmGenerateJson, llmGenerateJsonOutcome, llmAvailable } = await import("@/src/infra/llm/cascade");
const { cascadeModels } = await import("@/src/infra/llm/models");

const PROVIDERS: LlmProviderId[] = ["gemini", "groq", "mistral"];

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ["GEMINI_API_KEY", "GEMINI_API_KEYS", "GEMINI_PAID_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
    "GROQ_BASE_URL", "MISTRAL_BASE_URL", "LLM_DISABLE_GROQ", "LLM_DISABLE_MISTRAL", "LLM_DISABLE_MISTRAL_CHAT",
    "MISTRAL_CHAT_NARROW_ONLY", "LLM_VISION_EVALUATION", "LLM_MODELS_DISABLED"]) vi.stubEnv(key, undefined);
  mocks.isBreakerOpen.mockResolvedValue(false);
  vi.stubGlobal("fetch", vi.fn());
  resetEnvCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});

const image = {
  inlineData: {
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  },
};

/** Responde como cada API responderia, com o mesmo JSON, e anota quem foi chamado. */
function fakeProviders(answer: (provider: string) => Response | undefined = () => undefined): string[] {
  const calls: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const content = '{"isBet":true}';
    const gemini = url.match(/\/models\/([^:/?]+):generateContent/);
    if (gemini) {
      calls.push(`gemini/${decodeURIComponent(gemini[1] ?? "")}`);
      return answer("gemini") ?? Response.json({ candidates: [{ content: { role: "model", parts: [{ text: content }] }, finishReason: "STOP" }] });
    }
    const model = JSON.parse(String(init?.body)).model as string;
    if (url.endsWith("/ocr")) {
      calls.push(`mistral-ocr/${model}`);
      return answer("mistral-ocr") ?? Response.json({ document_annotation: content, pages: [{ markdown: "bilhete" }] });
    }
    const provider = url.includes("groq") ? "groq" : "mistral";
    calls.push(`${provider}/${model}`);
    return answer(provider) ?? Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  });
  return calls;
}

function allProviders() {
  vi.stubEnv("GEMINI_API_KEYS", "gemini-simulation-key");
  vi.stubEnv("GROQ_API_KEY", "gsk_simulation_key");
  vi.stubEnv("MISTRAL_API_KEY", "msk_simulation_key");
  resetEnvCacheForTests();
}

describe("ordem do catálogo, com os três provedores e HTTP simulado", () => {
  // Toda leitura é recusada: a cascata passa por todos os modelos, na ordem.
  const base: LlmGenerateJsonParams = {
    parts: [{ text: "Real Madrid vs Barcelona - Over 2.5 @ 1.85 (1u)" }],
    systemInstruction: "Extraia a aposta esportiva", responseSchema: { type: "object" }, label: "ordem", accept: () => false,
  };
  const ocrContract = { ocrSystemInstruction: "Contrato OCR", ocrResponseSchema: { type: "object" }, ocrAccept: () => true };
  const chat = (kind: "text" | "vision" | "precisionVision") => (provider: LlmProviderId) =>
    cascadeModels(provider)[kind].map((model) => `${provider}/${model}`);

  it.each([
    { reading: "texto", params: base, expected: () => PROVIDERS.flatMap(chat("text")) },
    { reading: "imagem", params: { ...base, parts: [image, { text: "legenda" }] }, expected: () => PROVIDERS.flatMap(chat("vision")) },
    { reading: "visão de precisão", params: { ...base, parts: [image, { text: "legenda" }], precisionVision: true },
      expected: () => PROVIDERS.flatMap(chat("precisionVision")) },
    // Bilhete simples com contrato de OCR: a Mistral tenta o OCR antes do chat.
    { reading: "OCR", params: { ...base, parts: [image, { text: "legenda" }], ...ocrContract }, expected: () => [
      ...chat("vision")("gemini"), ...chat("vision")("groq"),
      ...cascadeModels("mistral").ocr.map((model) => `mistral-ocr/${model}`), ...chat("vision")("mistral"),
    ] },
  ])("$reading: tenta os modelos na ordem do catálogo", async ({ params, expected }) => {
    allProviders();
    const calls = fakeProviders();
    expect(await llmGenerateJsonOutcome(params)).toEqual({ kind: "refused" });
    expect(calls).toEqual(expected());
  });

  it("LLM_MODELS_DISABLED tira o modelo da cascata sem mudar a ordem do resto", async () => {
    allProviders();
    const [gemini] = cascadeModels("gemini").vision;
    const [ocr] = cascadeModels("mistral").ocr;
    const all = fakeProviders();
    await llmGenerateJsonOutcome({ ...base, parts: [image, { text: "legenda" }], ...ocrContract });
    const expected = all.filter((call) => call !== `gemini/${gemini}` && call !== `mistral-ocr/${ocr}`);
    expect(expected).toHaveLength(all.length - 2);

    vi.stubEnv("LLM_MODELS_DISABLED", `gemini/${gemini},mistral/${ocr}`);
    resetEnvCacheForTests();
    const calls = fakeProviders();
    await llmGenerateJsonOutcome({ ...base, parts: [image, { text: "legenda" }], ...ocrContract });
    expect(calls).toEqual(expected);
  });
});

describe("cascata com provedores reais e HTTP simulado", () => {
  const imagePayload: LlmGenerateJsonParams = {
    parts: [{ text: "Bilhete Bet365 com handicap" }, image],
    systemInstruction: "Extraia a aposta esportiva estritamente em JSON",
    responseSchema: {
      type: "object",
      properties: {
        isBet: { type: "boolean" },
        evento: { type: "string" },
        selecao: { type: "string" },
        odds: { type: "number" },
      },
      required: ["isBet", "evento", "selecao", "odds"],
    },
    label: "sim-image-bet",
    accept: (data: unknown) => {
      const d = data as { isBet?: boolean; odds?: number };
      if (!d || d.isBet !== true) return false;
      return typeof d.odds === "number" && d.odds > 1;
    },
  };

  const textPayload: LlmGenerateJsonParams = {
    parts: [{ text: "Real Madrid vs Barcelona - Over 2.5 @ 1.85 (1u)" }],
    systemInstruction: "Extraia a aposta esportiva",
    responseSchema: { type: "object" },
    label: "sim-text-bet",
    accept: (data: unknown) => {
      const d = data as { isBet?: boolean; odds?: number };
      return Boolean(d && d.isBet && typeof d.odds === "number" && d.odds > 1);
    },
  };

  const chatAnswer = (data: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }] });

  it("imagem sem Gemini: a Groq lê com o primeiro modelo de imagem do catálogo", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_simulation_key");
    vi.stubEnv("MISTRAL_API_KEY", "msk_simulation_key");
    resetEnvCacheForTests();
    const bet = { isBet: true, evento: "Arsenal vs Chelsea", selecao: "Arsenal -0.5", odds: 1.95 };
    vi.mocked(fetch).mockResolvedValueOnce(chatAnswer(bet));

    expect(await llmGenerateJson(imagePayload)).toEqual({ provider: "groq", data: bet });
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(request.model).toBe(cascadeModels("groq").vision[0]);
  });

  it("imagem com a Groq fora: a Mistral lê no 3º nível, com a imagem", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_simulation_key");
    vi.stubEnv("MISTRAL_API_KEY", "msk_simulation_key");
    resetEnvCacheForTests();
    const bet = { isBet: true, evento: "Liverpool vs Man City", selecao: "Over 2.5", odds: 1.88 };
    const calls = fakeProviders((provider) => provider === "groq"
      ? Response.json({ error: { message: "Internal server error" } }, { status: 500 })
      : chatAnswer(bet));

    expect(await llmGenerateJson(imagePayload)).toEqual({ provider: "mistral", data: bet });
    expect(calls.at(-1)).toBe(`mistral/${cascadeModels("mistral").vision[0]}`);
    const mistralBody = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));
    expect(mistralBody.messages[1].content[1].type).toBe("image_url");
    expect(mistralBody.messages[1].content[1].image_url.url).toContain("data:image/png;base64");
  });

  it("texto com a Groq falhando: a Mistral resolve", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_simulation_key");
    vi.stubEnv("MISTRAL_API_KEY", "msk_simulation_key");
    resetEnvCacheForTests();
    const bet = { isBet: true, evento: "PSG vs Marseille", odds: 1.75 };
    fakeProviders((provider) => provider === "groq"
      ? Response.json({ error: { message: "Internal server error" } }, { status: 500 })
      : chatAnswer(bet));

    expect(await llmGenerateJson(textPayload)).toEqual({ provider: "mistral", data: bet });
  });

  it("llmAvailable detecta provedores ativos", async () => {
    expect(await llmAvailable()).toBe(false);

    vi.stubEnv("MISTRAL_API_KEY", "msk_active");
    resetEnvCacheForTests();
    expect(await llmAvailable()).toBe(true);
  });
});
