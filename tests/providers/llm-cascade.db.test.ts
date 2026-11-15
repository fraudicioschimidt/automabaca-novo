import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { disconnectPrisma, prisma } from "@/src/infra/prisma";
import { llmGenerateJsonOutcome, type LlmGenerateJsonParams } from "@/src/infra/llm/cascade";
import { deferLlmRoute } from "@/src/infra/llm/route-cooldown";

// A Groq com dois modelos: um fica fora por cota e o outro lê.
vi.mock("@/src/infra/llm/models", async (importOriginal) => {
  const models = ["test/quota-model", "test/reader-model"];
  return {
    ...await importOriginal<typeof import("@/src/infra/llm/models")>(),
    cascadeModels: (provider: string) => provider === "groq"
      ? { text: models, vision: models, precisionVision: models, ocr: [] }
      : { text: [], vision: [], precisionVision: [], ocr: [] },
  };
});

/**
 * Cascata com o adaptador da Groq, o cooldown persistente de rota e o circuito
 * reais; só o HTTP é simulado. Mede o desfecho quando um modelo está fora por
 * cota e os outros leram.
 */
const KEY = "synthetic-groq-key-cascade";
const groqRoute = (model: string) => ({ provider: "Groq", key: KEY, model, endpoint: "chat", baseUrl: "https://api.groq.com/openai/v1" });
const params: LlmGenerateJsonParams = {
  parts: [{ text: "Flamengo x Palmeiras" }], systemInstruction: "json", responseSchema: { type: "object" }, label: "cascade-db",
  accept: () => false,
};

beforeEach(() => {
  for (const key of ["GEMINI_API_KEY", "GEMINI_API_KEYS", "GEMINI_PAID_API_KEY", "MISTRAL_API_KEY", "GROQ_BASE_URL", "LLM_DISABLE_GROQ"]) vi.stubEnv(key, undefined);
  vi.stubEnv("GROQ_API_KEY", KEY);
  resetEnvCacheForTests();
  // Todo modelo que chega ao HTTP responde e tem a leitura recusada.
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: '{"odds":null}' }, finish_reason: "stop" }] })));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
  await prisma.providerRequestGate.deleteMany({ where: { provider: { startsWith: "llm:groq:" } } });
  await prisma.providerCircuit.deleteMany({ where: { provider: { startsWith: "llm:groq" } } });
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("modelo fora por cota e os outros recusando", () => {
  it("cota do dia esgotada num modelo vira recusa definitiva", async () => {
    await deferLlmRoute(groqRoute("test/quota-model"), 429, "Rate limit reached: requests per day (RPD)", "10800");
    expect(await llmGenerateJsonOutcome(params)).toEqual({ kind: "refused" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // A primeira chamada decide pelo cooldown que ela mesma grava: vaga só
  // depois das novas tentativas tira o modelo da rotação; vaga antes, relança.
  it.each([
    { retryAfter: "10800", outcome: { kind: "refused" } },
    { retryAfter: "300", outcome: { kind: "unavailable", responded: true } },
  ])("a chamada que esgota a cota do dia com Retry-After de $retryAfter s", async ({ retryAfter, outcome }) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(
      { error: { message: "Rate limit reached for model test/quota-model: Limit 500000, Used 500000, tokens per day (TPD)" } },
      { status: 429, headers: { "retry-after": retryAfter } }));
    expect(await llmGenerateJsonOutcome(params)).toEqual(outcome);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cooldown que acaba antes das novas tentativas continua relançando", async () => {
    await deferLlmRoute(groqRoute("test/quota-model"), 503, "overloaded");
    expect(await llmGenerateJsonOutcome(params)).toEqual({ kind: "unavailable", responded: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
