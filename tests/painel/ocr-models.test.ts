import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import type { LlmProviderId } from "@/src/infra/llm/cascade";
import type { ProviderModels } from "@/src/infra/llm/models";

/** Catálogo de teste quando definido; senão, o de produção. */
const fake = vi.hoisted(() => ({ catalog: null as null | Record<LlmProviderId, ProviderModels> }));
vi.mock("@/src/infra/llm/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/infra/llm/models")>();
  return { ...actual, cascadeModels: (provider: LlmProviderId) => fake.catalog?.[provider] ?? actual.cascadeModels(provider) };
});

const { buildOcrModelPeriods, configuredOcrReaders } = await import("@/src/services/painel/ocr-models");
const { cascadeModels } = await import("@/src/infra/llm/models");

beforeEach(() => {
  // O processo web: sem nenhuma chave de IA.
  for (const key of ["GEMINI_API_KEY", "GEMINI_API_KEYS", "GEMINI_PAID_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
    "LLM_DISABLE_GROQ", "LLM_DISABLE_MISTRAL", "LLM_DISABLE_MISTRAL_CHAT", "MISTRAL_CHAT_NARROW_ONLY", "LLM_MODELS_DISABLED"]) {
    vi.stubEnv(key, undefined);
  }
  resetEnvCacheForTests();
  fake.catalog = {
    gemini: { text: ["g-texto"], vision: ["g-leve", "g-cheio"], precisionVision: ["g-cheio", "g-preciso"], ocr: [] },
    groq: { text: ["q-texto"], vision: ["q-visao"], precisionVision: ["q-visao"], ocr: [] },
    mistral: { text: ["m-chat"], vision: ["m-chat"], precisionVision: ["m-chat"], ocr: ["m-ocr"] },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});

describe("card Modelos de OCR", () => {
  it("lista as rotas de imagem da cascata, na ordem dela, habilitadas mesmo sem as chaves de IA", () => {
    expect(configuredOcrReaders()).toEqual([
      { provider: "gemini", model: "g-leve", endpoint: "generate", enabled: true, scope: "Imagem comum" },
      { provider: "gemini", model: "g-cheio", endpoint: "generate", enabled: true, scope: "Imagem e visão detalhada" },
      { provider: "gemini", model: "g-preciso", endpoint: "generate", enabled: true, scope: "Visão detalhada" },
      { provider: "groq", model: "q-visao", endpoint: "chat", enabled: true, scope: "Imagem e visão detalhada" },
      { provider: "mistral", model: "m-chat", endpoint: "chat", enabled: true, scope: "Imagem e visão detalhada" },
      { provider: "mistral", model: "m-ocr", endpoint: "ocr", enabled: true, scope: "Uma seleção em uma imagem" },
    ]);
  });

  it("as flags do env desligam o provedor, e a leitura restrita muda o escopo da Mistral", () => {
    vi.stubEnv("LLM_DISABLE_GROQ", "1");
    vi.stubEnv("LLM_DISABLE_MISTRAL_CHAT", "1");
    vi.stubEnv("MISTRAL_CHAT_NARROW_ONLY", "1");
    resetEnvCacheForTests();
    const state = () => configuredOcrReaders().map(({ model, enabled, scope }) => `${model} ${enabled ? "ligado" : "desligado"} ${scope}`);
    expect(state()).toEqual([
      "g-leve ligado Imagem comum",
      "g-cheio ligado Imagem e visão detalhada",
      "g-preciso ligado Visão detalhada",
      "q-visao desligado Imagem e visão detalhada",
      "m-chat desligado Bilhete compacto elegível",
      "m-ocr ligado Bilhete compacto elegível",
    ]);
    vi.stubEnv("LLM_DISABLE_MISTRAL", "1");
    resetEnvCacheForTests();
    expect(state().at(-1)).toBe("m-ocr desligado Bilhete compacto elegível");
  });

  it("LLM_MODELS_DISABLED tira o modelo do card, como tira da cascata", () => {
    fake.catalog = null;
    const [gemini] = cascadeModels("gemini").vision;
    const [ocr] = cascadeModels("mistral").ocr;
    const routes = () => buildOcrModelPeriods([], configuredOcrReaders())[0]?.models.map((row) => `${row.provider}/${row.model}/${row.endpoint}`) ?? [];
    const before = routes();
    expect(before).toEqual(expect.arrayContaining([`gemini/${gemini}/generate`, `mistral/${ocr}/ocr`]));

    vi.stubEnv("LLM_MODELS_DISABLED", `gemini/${gemini},mistral/${ocr}`);
    resetEnvCacheForTests();
    expect(routes()).toEqual(before.filter((route) => route !== `gemini/${gemini}/generate` && route !== `mistral/${ocr}/ocr`));
  });
});
