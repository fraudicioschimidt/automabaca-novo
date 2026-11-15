import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  construct: vi.fn(),
  env: {} as Record<string, string | undefined>,
  models: { text: [], vision: [], precisionVision: [], ocr: [] } as Record<"text" | "vision" | "precisionVision" | "ocr", string[]>,
  sticky: vi.fn(async (): Promise<{ model: string; keyHint: string } | null> => null),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  tripBreaker: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(options: unknown) { mocks.construct(options); }
    models = { generateContent: mocks.generateContent };
  },
  MediaResolution: { MEDIA_RESOLUTION_HIGH: "MEDIA_RESOLUTION_HIGH" },
}));
vi.mock("@/src/infra/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ info: mocks.info, warn: mocks.warn, error: mocks.error }),
}));
vi.mock("@/src/infra/circuit-breaker", () => ({
  closeExpiredBreaker: vi.fn(),
  isBreakerOpen: vi.fn().mockResolvedValue(false),
  tripBreaker: (...args: unknown[]) => mocks.tripBreaker(...args),
}));
vi.mock("@/src/infra/llm/route-cooldown", () => ({ llmRouteAvailable: vi.fn(async () => true), reportUnavailableRoute: vi.fn(async (_route: unknown, report: ((outcome: "unavailable", model: string) => void) | undefined, model: string) => report?.("unavailable", model)), deferLlmRoute: vi.fn(async () => undefined) }));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: vi.fn(async () => undefined) }));
vi.mock("@/src/infra/prisma", () => ({
  prisma: { llmStickyPreference: { findUnique: mocks.sticky, upsert: vi.fn(async () => ({})) } },
}));
vi.mock("@/src/infra/llm/models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/infra/llm/models")>(),
  cascadeModels: () => mocks.models,
}));

const { geminiGenerateJson, geminiKeyHint, geminiKeyPool, orderKeysPreferring, orderModelsPreferring } = await import("@/src/infra/llm/gemini");

/** Os mesmos modelos em toda leitura e o pool de chaves. */
const setPool = (models: string, keys: string[]) => {
  const list = models.split(",");
  mocks.models = { text: list, vision: list, precisionVision: list, ocr: [] };
  mocks.env = { GEMINI_API_KEYS: keys.join(",") };
};

beforeEach(() => {
  vi.clearAllMocks();
  setPool("model-a", ["key-a"]);
  mocks.generateContent.mockRejectedValue(new Error("503 UNAVAILABLE"));
});

it("quota de um modelo não exclui a mesma chave do próximo modelo", async () => {
  setPool("model-a,model-b", ["key-a"]);
  mocks.generateContent.mockRejectedValueOnce(new Error("429 quota exceeded"))
    .mockResolvedValueOnce({ text: '{"isBet":true}' });
  expect(await geminiGenerateJson({ parts: [{ text: "tip" }], systemInstruction: "json", responseSchema: {}, label: "quota" })).toEqual({ isBet: true });
  expect(mocks.generateContent.mock.calls.map(([input]) => input.model)).toEqual(["model-a", "model-b"]);
  expect(mocks.tripBreaker).not.toHaveBeenCalled();
});

it("quota em três projetos Gemini ainda permite o mesmo modelo na quarta chave", async () => {
  const keys = ["key-a", "key-b", "key-c", "key-d"];
  setPool("model-a,model-b", keys);
  mocks.generateContent.mockRejectedValueOnce(new Error("429 quota exceeded"))
    .mockRejectedValueOnce(new Error("429 quota exceeded"))
    .mockRejectedValueOnce(new Error("429 quota exceeded"))
    .mockResolvedValueOnce({ text: '{"isBet":true}' });
  expect(await geminiGenerateJson({ parts: [{ text: "tip" }], systemInstruction: "json", responseSchema: {}, label: "quota-projects" })).toEqual({ isBet: true });
  expect(mocks.generateContent.mock.calls.map(([input]) => input.model)).toEqual(["model-a", "model-a", "model-a", "model-a"]);
  expect(mocks.construct.mock.calls.map(([input]) => input.apiKey)).toEqual(keys);
});

it("leitor sem JSON nativo recebe o schema completo e continua sujeito ao accept", async () => {
  // Nome genérico: o caminho de prompt-JSON precisa valer para o próximo
  // gerador de imagem que a Google lançar.
  setPool("gemini-4-flash-image,gemini-3.1-flash-lite", ["key-a"]);
  mocks.generateContent.mockResolvedValueOnce({ text: '```json\n{"odds":null}\n```' })
    .mockResolvedValueOnce({ text: '{"odds":2}' });
  const schema = { type: "object", required: ["odds"], properties: { odds: { type: "number" } } };
  const result = await geminiGenerateJson({ parts: [{ inlineData: { data: "synthetic", mimeType: "image/png" } }], systemInstruction: "preserve placar", responseSchema: schema, label: "test", accept: (value) => (value as { odds: unknown }).odds === 2 });
  expect(result).toEqual({ odds: 2 });
  const first = mocks.generateContent.mock.calls[0]?.[0];
  expect(first.config.responseModalities).toEqual(["TEXT"]);
  expect(first.config.responseJsonSchema).toBeUndefined();
  expect(first.config.systemInstruction).toContain(JSON.stringify(schema));
  expect(first.config.systemInstruction).toContain("preserve placar");
  expect(mocks.generateContent).toHaveBeenCalledTimes(2);
});

it("cada leitura segue a sua lista; só a visão de precisão ignora a rota lembrada", async () => {
  mocks.env = { GEMINI_API_KEYS: "key-a" };
  mocks.models = { text: ["texto-a", "texto-b"], vision: ["visao-a", "visao-b"], precisionVision: ["precisao-a", "visao-b"], ocr: [] };
  mocks.sticky.mockResolvedValue({ model: "visao-b", keyHint: geminiKeyHint("key-a") });
  mocks.generateContent.mockResolvedValue({ text: '{"odds":null}' });
  const image = { inlineData: { data: "synthetic", mimeType: "image/png" } };
  const read = async (extra: Partial<Parameters<typeof geminiGenerateJson>[0]>) => {
    mocks.generateContent.mockClear();
    await geminiGenerateJson({ parts: [{ text: "tip" }], systemInstruction: "json", responseSchema: {}, label: "listas", accept: () => false, ...extra });
    return mocks.generateContent.mock.calls.map(([input]) => input.model);
  };
  try {
    expect(await read({})).toEqual(["texto-a", "texto-b"]);
    expect(await read({ parts: [image, { text: "legenda" }] })).toEqual(["visao-b", "visao-a"]);
    expect(await read({ parts: [image, { text: "legenda" }], precisionVision: true })).toEqual(["precisao-a", "visao-b"]);
  } finally { mocks.sticky.mockResolvedValue(null); }
});

it("para de percorrer modelos quando o chamador já tem leituras concordantes do Gemini", async () => {
  setPool("model-a,model-b,model-c", ["key-a"]);
  mocks.generateContent.mockResolvedValue({ text: '{"odds":null}' });
  let rejected = 0;
  const result = await geminiGenerateJson({
    parts: [{ text: "tip" }], systemInstruction: "json", responseSchema: {}, label: "consenso",
    accept: () => { rejected += 1; return false; },
    skipRemainingModels: (provider) => provider === "gemini" && rejected >= 1,
  });
  expect(result).toBeNull();
  expect(mocks.generateContent.mock.calls.map(([input]) => input.model)).toEqual(["model-a"]);
});

describe("severidade do handoff Gemini", () => {
  it("recusa pelo accept é fluxo esperado: sai em info, não em warn", async () => {
    mocks.generateContent.mockResolvedValue({ text: '{"odds":null}' });
    await geminiGenerateJson({ parts: [{ text: "tip" }], systemInstruction: "json", responseSchema: {}, label: "recusa", accept: () => false });
    expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ eventCode: "LLM_PARSE_REJECTED" }), expect.any(String));
    expect(mocks.warn).not.toHaveBeenCalledWith(expect.objectContaining({ eventCode: "LLM_PARSE_REJECTED" }), expect.any(String));
  });

  it("não registra como erro operacional quando a cascata ainda pode continuar", async () => {
    await expect(geminiGenerateJson({
      parts: [{ text: "tip" }],
      systemInstruction: "extraia",
      responseSchema: { type: "object" },
      label: "telegram",
    })).resolves.toBeNull();

    // Handoff para o próximo provider da cascata: info (não warn) — evita storm Ops.
    expect(mocks.info).toHaveBeenCalledWith(
      { label: "telegram", provider: "gemini", eventCode: "LLM_PROVIDER_EXHAUSTED" },
      "Gemini esgotou combinações (ou orçamento) — cascata",
    );
    expect(mocks.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: "LLM_PROVIDER_EXHAUSTED" }),
      expect.any(String),
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });
});

// Três timeouts de 20s não podem ultrapassar o orçamento total de 45s.
it("limita a última tentativa ao tempo restante da cascata", async () => {
  setPool("model-a,model-b,model-c,model-d", ["key-a"]);
  let elapsed = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => elapsed);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  mocks.generateContent.mockImplementation(async () => { elapsed += elapsed < 40_000 ? 20_000 : 5_000; throw new Error("503 UNAVAILABLE"); });
  try {
    await geminiGenerateJson({ parts: [{ text: "tip" }], systemInstruction: "extraia", responseSchema: { type: "object" }, label: "timeout" });
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([20_000, 20_000, 5_000]);
    expect(mocks.generateContent).toHaveBeenCalledTimes(3);
  } finally { clock.mockRestore(); timeout.mockRestore(); }
});

it("controla cada tentativa no aplicativo sem retries adicionais do SDK", async () => {
  mocks.generateContent.mockResolvedValue({ text: '{"isBet":false}' });
  await geminiGenerateJson({ parts: [{ text: "tip" }], systemInstruction: "json", responseSchema: {}, label: "attempt" });
  expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({ httpOptions: { retryOptions: { attempts: 1 } } }));
});

describe("geminiKeyHint", () => {
  it("gera identificador HMAC estável sem expor trechos da chave", () => {
    const key = "fixture-key-ending-BQ9Y";
    const hint = geminiKeyHint(key);
    expect(hint).toMatch(/^[a-f0-9]{16}$/);
    expect(hint).toBe(geminiKeyHint(key));
    expect(hint).not.toContain("BQ9Y");
    expect(hint).not.toContain("fixture");
  });
});

describe("orderModelsPreferring", () => {
  const models = [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
  ];

  it("sem preferência mantém ordem", () => {
    expect(orderModelsPreferring(models, null)).toEqual(models);
  });

  it("preferência inexistente mantém ordem", () => {
    expect(orderModelsPreferring(models, "gemini-fantasma")).toEqual(models);
  });

  it("move o sticky para o início e preserva o resto", () => {
    expect(orderModelsPreferring(models, "gemini-2.5-flash")).toEqual([
      "gemini-2.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
      "gemini-3-flash-preview",
      "gemini-2.5-flash-lite",
    ]);
  });

  it("já no início não reordena", () => {
    expect(orderModelsPreferring(models, "gemini-3.1-flash-lite")).toEqual(models);
  });
});

describe("orderKeysPreferring", () => {
  const keys = ["keyAAAA", "keyBBBB", "keyCCCC"];

  it("sem hint mantém ordem", () => {
    expect(orderKeysPreferring(keys, null)).toEqual(keys);
  });

  it("move a chave sticky (por HMAC) para o início", () => {
    expect(orderKeysPreferring(keys, geminiKeyHint("keyCCCC"))).toEqual([
      "keyCCCC",
      "keyAAAA",
      "keyBBBB",
    ]);
  });

  it("hint desconhecido mantém ordem", () => {
    expect(orderKeysPreferring(keys, "ZZZZ")).toEqual(keys);
  });
});

describe("geminiKeyPool", () => {
  it("não deixa GEMINI_API_KEYS vazio bloquear GEMINI_API_KEY", () => {
    mocks.env = { GEMINI_API_KEYS: "", GEMINI_API_KEY: "solo-key" };
    expect(geminiKeyPool()).toEqual(["solo-key"]);
    mocks.env = { GEMINI_API_KEYS: undefined, GEMINI_API_KEY: "solo-key" };
    expect(geminiKeyPool()).toEqual(["solo-key"]);
  });

  it("usa csv de free e acrescenta paid", () => {
    mocks.env = { GEMINI_API_KEYS: "k1,k2", GEMINI_API_KEY: "ignored", GEMINI_PAID_API_KEY: "paid" };
    expect(geminiKeyPool()).toEqual(["k1", "k2", "paid"]);
  });
});

describe("o que a cascata sabe de cada modelo", () => {
  const read = (onRouteOutcome: (outcome: string, model: string) => void, deadlineAt?: number) =>
    geminiGenerateJson({ parts: [{ text: "tip" }], systemInstruction: "json", responseSchema: {}, label: "rotas", onRouteOutcome,
      accept: () => false, ...(deadlineAt ? { deadlineAt } : {}) });

  it("modelo em 503, resposta vazia e recusa são avisados por modelo; vazio não conta como resposta", async () => {
    setPool("model-a,model-b,model-c", ["key-a"]);
    mocks.generateContent.mockRejectedValueOnce(new Error("503 UNAVAILABLE"))
      .mockResolvedValueOnce({ text: "" })
      .mockResolvedValueOnce({ text: '{"odds":null}' });
    const outcomes: string[] = [];
    await read((outcome, model) => outcomes.push(`${model}:${outcome}`));
    expect(outcomes).toEqual(["model-a:unavailable", "model-b:unavailable", "model-c:responded"]);
  });

  it("chave fora da rotação não conta como tentativa: o tempo que acaba antes da chamada deixa o modelo sem resposta", async () => {
    setPool("model-a", ["key-a", "key-b"]);
    const { llmRouteAvailable, reportUnavailableRoute } = await import("@/src/infra/llm/route-cooldown");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // key-a está fora da rotação (cota do dia) e a checagem dela consome o resto do prazo.
      vi.mocked(llmRouteAvailable).mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 60_000); return false; });
      vi.mocked(reportUnavailableRoute).mockImplementationOnce(async () => undefined);
      const outcomes: string[] = [];
      await read((outcome, model) => outcomes.push(`${model}:${outcome}`), Date.now() + 5_000);
      expect(mocks.generateContent).not.toHaveBeenCalled();
      expect(outcomes).toEqual(["model-a:unavailable"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("modelo com todas as chaves fora da rotação não é avisado como queda", async () => {
    setPool("model-a", ["key-a", "key-b"]);
    const { llmRouteAvailable, reportUnavailableRoute } = await import("@/src/infra/llm/route-cooldown");
    vi.mocked(llmRouteAvailable).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    vi.mocked(reportUnavailableRoute).mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => undefined);
    const outcomes: string[] = [];
    await read((outcome, model) => outcomes.push(`${model}:${outcome}`));
    expect(outcomes).toEqual([]);
  });

  it("chave recusada e cota do dia na primeira chamada: a rota sai da rotação sem contar como queda", async () => {
    setPool("model-a", ["key-a", "key-b"]);
    const { deferLlmRoute, reportUnavailableRoute } = await import("@/src/infra/llm/route-cooldown");
    mocks.generateContent
      .mockRejectedValueOnce(Object.assign(new Error("API key not valid. Please pass a valid API key. [API_KEY_INVALID]"), { status: 400 }))
      .mockRejectedValueOnce(Object.assign(new Error("429 RESOURCE_EXHAUSTED: GenerateRequestsPerDayPerProjectPerModel"), { status: 429 }));
    // Depois do cooldown, as duas rotas estão fora da rotação.
    vi.mocked(reportUnavailableRoute).mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => undefined);
    const outcomes: string[] = [];
    await read((outcome, model) => outcomes.push(`${model}:${outcome}`));
    expect(outcomes).toEqual([]);
    const deferred = vi.mocked(deferLlmRoute).mock.invocationCallOrder;
    const reported = vi.mocked(reportUnavailableRoute).mock.invocationCallOrder;
    expect(deferred).toHaveLength(2);
    expect(reported).toHaveLength(2);
    expect(deferred[0]).toBeLessThan(reported[0]!);
    expect(deferred[1]).toBeLessThan(reported[1]!);
  });

  it("modelo que o orçamento não alcançou conta como não ouvido", async () => {
    setPool("model-a,model-b", ["key-a"]);
    const outcomes: string[] = [];
    await read((outcome, model) => outcomes.push(`${model}:${outcome}`), Date.now() - 1);
    expect(outcomes).toEqual(["model-a:unavailable", "model-b:unavailable"]);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });
});
