import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { LLM_VISION_EVALUATION: "1" } as Record<string, string | undefined>,
  random: vi.fn(() => 2),
  warn: vi.fn(),
}));
vi.mock("@/src/infra/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn() }) }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>(), randomInt: mocks.random }));

const {
  cascadeModels, evaluationOrder, googleModelFamily, googleVisionModelEnabled, mistralModelFamily, PROVIDER_ORDER,
} = await import("@/src/infra/llm/models");

/** Modelo morto na cascata leva 404 e cooldown antes de a vez passar, gastando
 * orçamento de captura: o catálogo não pode trazê-lo de volta. */
const RETIRADOS = [
  "gemini-2.5-pro",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-2.5-computer-use-preview-10-2025",
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it",
];

describe("Modelos retirados da leitura de apostas", () => {
  it.each(RETIRADOS)("recusa %s", (model) => {
    expect(googleVisionModelEnabled(model)).toBe(false);
  });

  it("recusa também o prefixo models/ que a API devolve", () => {
    expect(googleVisionModelEnabled("models/gemini-2.5-pro")).toBe(false);
  });

  it("recusa pelos apelidos, que resolvem para o nome canônico", () => {
    for (const apelido of ["gemini-pro-latest", "nano-banana-pro-preview", "gemini-3-pro-image-preview"]) {
      expect(googleVisionModelEnabled(googleModelFamily(apelido))).toBe(false);
    }
  });

  it("mantém de pé os leitores que continuam em uso", () => {
    for (const model of ["gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.6-flash"]) {
      expect(googleVisionModelEnabled(model)).toBe(true);
    }
  });
});

describe("famílias de modelos da Mistral", () => {
  it("apelidos resolvem para o modelo datado, que divide a quota com eles", () => {
    expect(mistralModelFamily("magistral-small-latest")).toBe("mistral-small-2603");
    expect(mistralModelFamily("ministral-8b-latest")).toBe("ministral-8b-2512");
    expect(mistralModelFamily("mistral-ocr-latest")).toBe("mistral-ocr-4-1");
    expect(mistralModelFamily("mistral-ocr-4-0")).toBe("mistral-ocr-4-0");
  });
});

describe("catálogo da cascata", () => {
  afterEach(() => { mocks.env = { LLM_VISION_EVALUATION: "1" }; mocks.warn.mockClear(); });

  it("cada lista já vem resolvida: nome canônico, sem repetir, sem Gemini retirado e uma família Mistral", () => {
    for (const provider of PROVIDER_ORDER) {
      for (const [kind, models] of Object.entries(cascadeModels(provider))) {
        const where = `${provider}.${kind}`;
        expect(new Set(models).size, where).toBe(models.length);
        if (provider === "gemini") {
          for (const model of models) {
            expect(googleModelFamily(model), where).toBe(model);
            expect(googleVisionModelEnabled(model), where).toBe(true);
          }
        }
        if (provider === "mistral") expect(models.map(mistralModelFamily), where).toEqual(models);
      }
    }
  });

  it("o OCR é só da Mistral: até três modelos de OCR, nenhum no chat", () => {
    expect(cascadeModels("gemini").ocr).toEqual([]);
    expect(cascadeModels("groq").ocr).toEqual([]);
    const mistral = cascadeModels("mistral");
    expect(mistral.ocr.length).toBeGreaterThan(0);
    expect(mistral.ocr.length).toBeLessThanOrEqual(3);
    for (const model of mistral.ocr) expect(model).toMatch(/^mistral-ocr-/);
    for (const model of [...mistral.text, ...mistral.vision, ...mistral.precisionVision]) expect(model).not.toMatch(/^mistral-ocr-/);
  });

  it("LLM_MODELS_DISABLED tira o modelo de todas as listas do provedor, sem mexer na ordem do resto", () => {
    const antes = cascadeModels("gemini");
    const alvo = antes.vision[0] ?? "";
    const outros = { groq: cascadeModels("groq"), mistral: cascadeModels("mistral") };
    mocks.env = { LLM_MODELS_DISABLED: `gemini/${alvo}` };
    const depois = cascadeModels("gemini");
    for (const kind of ["text", "vision", "precisionVision", "ocr"] as const) {
      expect(depois[kind]).toEqual(antes[kind].filter((model) => model !== alvo));
    }
    expect({ groq: cascadeModels("groq"), mistral: cascadeModels("mistral") }).toEqual(outros);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("valor fora do catálogo é ignorado, com um aviso por valor da variável", () => {
    const antes = PROVIDER_ORDER.map((provider) => cascadeModels(provider));
    // Apelido não vale: o nome é o do catálogo, o mesmo do card.
    mocks.env = { LLM_MODELS_DISABLED: "gemini/modelo-que-nao-existe, mistral/mistral-small-latest,groq" };
    expect(PROVIDER_ORDER.map((provider) => cascadeModels(provider))).toEqual(antes);
    expect(PROVIDER_ORDER.map((provider) => cascadeModels(provider))).toEqual(antes);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: "LLM_MODELS_DISABLED_UNKNOWN",
        unknown: ["gemini/modelo-que-nao-existe", "mistral/mistral-small-latest", "groq"] }),
      expect.any(String),
    );
  });
});

describe("ordem de avaliação de visão", () => {
  const image = { parts: [{ inlineData: { mimeType: "image/png", data: "test" } }], systemInstruction: "", responseSchema: {}, label: "test" };
  afterEach(() => { mocks.env.LLM_VISION_EVALUATION = "1"; mocks.random.mockClear(); });

  it("dá chance a cada primeira rota sem duplicar leitores nem embaralhar os fallbacks", () => {
    expect(evaluationOrder(["A", "B", "C", "D"], image)).toEqual(["C", "A", "B", "D"]);
    expect(mocks.random).toHaveBeenCalledWith(4);
  });

  it("não muda texto nem o modo habitual", () => {
    expect(evaluationOrder(["A", "B", "C"], { ...image, parts: [{ text: "post" }] })).toEqual(["A", "B", "C"]);
    mocks.env.LLM_VISION_EVALUATION = "0";
    expect(evaluationOrder(["A", "B", "C"], image)).toEqual(["A", "B", "C"]);
    expect(mocks.random).not.toHaveBeenCalled();
  });
});
