import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  format: vi.fn(),
  construct: vi.fn(),
  env: {} as Record<string, string | undefined>,
}));
vi.mock("@google/genai", () => ({ GoogleGenAI: class { constructor(options: unknown) { mocks.construct(options); } models = { generateContent: mocks.generate }; } }));
vi.mock("@/src/infra/llm/cascade", () => ({ llmGenerateJson: mocks.format }));
vi.mock("@/src/infra/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/src/infra/circuit-breaker", () => ({ isBreakerOpen: vi.fn().mockResolvedValue(false), closeExpiredBreaker: vi.fn(), tripBreaker: vi.fn() }));
vi.mock("@/src/infra/llm/route-cooldown", () => ({ llmRouteAvailable: vi.fn(async () => true), reportUnavailableRoute: vi.fn(async (_route: unknown, report: ((outcome: "unavailable", model: string) => void) | undefined, model: string) => report?.("unavailable", model)), deferLlmRoute: vi.fn() }));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: vi.fn(async () => undefined) }));
vi.mock("@/src/infra/prisma", () => ({
  prisma: { llmStickyPreference: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) } },
}));

const {
  extractGroundingSources, extractGroundingSupports, geminiGenerateJsonWithSearch, geminiSearchModels,
  isGeminiSearchAvailable, resetGeminiSearchSoftGateForTests, resolveGroundingRedirectHost,
} = await import("@/src/infra/llm/gemini-search");

const params = { query: "horário do evento", label: "kickoff-web", systemInstruction: "Extraia somente evidência citada", responseSchema: { type: "object" } };

beforeEach(() => {
  resetGeminiSearchSoftGateForTests();
  vi.clearAllMocks();
  mocks.generate.mockReset();
  mocks.format.mockReset();
  mocks.env = { GEMINI_API_KEYS: "test-key", GEMINI_SEARCH_MODELS: "search-model" };
  mocks.generate.mockResolvedValue({ text: "Evidência da partida", candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/match", title: "Partida" } }] } }] });
});

describe("busca web com formatação pela cascata", () => {
  it('mantém fontes de busca quando outro provedor formata o JSON', async () => {
    mocks.format.mockResolvedValue({ provider: 'groq', data: { kickoff: '2026-09-10T18:00:00Z' } });
    expect(await geminiGenerateJsonWithSearch(params)).toEqual({
      provider: 'groq', data: { kickoff: '2026-09-10T18:00:00Z' }, sources: [{ url: 'https://example.com/match', title: 'Partida' }],
      supports: [],
    });
    expect(mocks.format.mock.calls[0]?.[0].parts[0].text).toContain('https://example.com/match');
  });
  it.each(["MAX_TOKENS", "SAFETY", "RECITATION"])("não usa busca interrompida por %s como evidência", async (finishReason) => {
    mocks.generate.mockResolvedValue({ text: "O jogo terminou 2 a 1", candidates: [{ finishReason }] });
    mocks.format.mockResolvedValue({ provider: "groq", data: { result: "WIN" } });
    expect(await geminiGenerateJsonWithSearch(params)).toBeNull();
    expect(mocks.format).not.toHaveBeenCalled();
  });

  it("busca interrompida passa ao próximo modelo e só formata a evidência completa", async () => {
    mocks.env.GEMINI_SEARCH_MODELS = "search-a,search-b";
    mocks.generate.mockResolvedValueOnce({ text: "Parcial 2 a 1", candidates: [{ finishReason: "MAX_TOKENS" }] })
      .mockResolvedValueOnce({ text: "Final 2 a 2", candidates: [{ finishReason: "STOP" }] });
    mocks.format.mockResolvedValue({ provider: "groq", data: { result: "DRAW" } });
    expect(await geminiGenerateJsonWithSearch(params)).toMatchObject({ data: { result: "DRAW" } });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.format.mock.calls[0]?.[0].parts[0].text).toContain("Final 2 a 2");
  });

  it('não fabrica evidência se a busca falhou', async () => {
    mocks.generate.mockRejectedValue(new Error('503 UNAVAILABLE'));
    expect(await geminiGenerateJsonWithSearch(params)).toBeNull();
    expect(mocks.format).not.toHaveBeenCalled();
  });
  it('permanece indisponível se todos os formatadores falham', async () => {
    mocks.format.mockResolvedValue(null);
    expect(await geminiGenerateJsonWithSearch(params)).toBeNull();
  });

  it('quota na busca adia a rota de busca, sem abrir circuito', async () => {
    const { tripBreaker } = await import('@/src/infra/circuit-breaker');
    const { deferLlmRoute } = await import('@/src/infra/llm/route-cooldown');
    mocks.generate.mockRejectedValue(new Error('429 quota limit: 0'));
    expect(await geminiGenerateJsonWithSearch(params)).toBeNull();
    expect(deferLlmRoute).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gemini', model: 'search-model', endpoint: 'search' }), 429, '429 quota limit: 0', undefined);
    expect(tripBreaker).not.toHaveBeenCalled();
  });
  it('does not call a search route that is still cooling down', async () => {
    const { llmRouteAvailable } = await import('@/src/infra/llm/route-cooldown');
    vi.mocked(llmRouteAvailable).mockResolvedValueOnce(false);
    expect(await geminiGenerateJsonWithSearch(params)).toBeNull();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('desativa retentativas ocultas do SDK e permite outro modelo após quota', async () => {
    mocks.env.GEMINI_SEARCH_MODELS = 'search-a,search-b';
    mocks.generate.mockRejectedValueOnce(new Error('429 quota limit: 0'));
    mocks.format.mockResolvedValue({ provider: 'groq', data: { ok: true } });
    expect(await geminiGenerateJsonWithSearch(params)).not.toBeNull();
    expect(mocks.generate.mock.calls.map(([input]) => input.model)).toEqual(['search-a', 'search-b']);
    expect(mocks.construct).toHaveBeenCalledTimes(2);
    for (const [options] of mocks.construct.mock.calls) expect(options.httpOptions.retryOptions.attempts).toBe(1);
  });

  it("engaja soft-gate após exaustão e não rematela a API na janela", async () => {
    const { llmRouteAvailable } = await import("@/src/infra/llm/route-cooldown");
    vi.mocked(llmRouteAvailable).mockResolvedValue(false);
    expect(await geminiGenerateJsonWithSearch(params)).toBeNull();
    expect(isGeminiSearchAvailable()).toBe(false);
    mocks.generate.mockClear();
    expect(await geminiGenerateJsonWithSearch(params)).toBeNull();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("soft-gate: indisponibilidade ≠ ausência — segunda chamada não rematela a API", async () => {
    const { llmRouteAvailable } = await import("@/src/infra/llm/route-cooldown");
    vi.mocked(llmRouteAvailable).mockResolvedValue(false);
    await geminiGenerateJsonWithSearch(params);
    mocks.generate.mockClear();
    await geminiGenerateJsonWithSearch(params);
    // API never called while gated / cooling
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(isGeminiSearchAvailable()).toBe(false);
  });
});

describe("extractGroundingSources", () => {
  it("lê URLs/títulos dos groundingChunks", () => {
    const sources = extractGroundingSources({
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://flashscore.com/a", title: "Flashscore" } },
              { web: { uri: "https://flashscore.com/a", title: "dup" } },
              { web: { uri: "https://sofascore.com/b" } },
              { web: { uri: "not-a-url" } },
            ],
          },
        },
      ],
    });
    expect(sources).toEqual([
      { url: "https://flashscore.com/a", title: "Flashscore" },
      { url: "https://sofascore.com/b" },
    ]);
  });

  it("retorna vazio sem metadata", () => {
    expect(extractGroundingSources({})).toEqual([]);
    expect(extractGroundingSources(null)).toEqual([]);
  });
});

describe("extractGroundingSupports", () => {
  const redirect = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;

  it("traduz os índices para as citações como vieram, antes da deduplicação", () => {
    const response = { candidates: [{ groundingMetadata: {
      groundingChunks: [
        { web: { uri: redirect("A"), title: "sofascore.com" } },
        { web: { uri: redirect("A"), title: "sofascore.com" } },
        { web: { uri: redirect("B"), title: "espn.com" } },
      ],
      groundingSupports: [
        { segment: { startIndex: 0, endIndex: 30, text: "O jogo terminou 2 a 2." }, groundingChunkIndices: [2] },
        { segment: { text: "   " }, groundingChunkIndices: [0] },
        { segment: { text: "Sem citação válida." }, groundingChunkIndices: [9] },
      ],
    } }] };

    expect(extractGroundingSupports(response)).toEqual([
      { text: "O jogo terminou 2 a 2.", sources: [{ url: redirect("B"), title: "espn.com" }] },
    ]);
    expect(extractGroundingSupports({})).toEqual([]);
  });
});

describe("resolveGroundingRedirectHost", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lê o Location do HEAD sem seguir o redirecionamento", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://www.sofascore.com/x" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveGroundingRedirectHost("https://vertexaisearch.cloud.google.com/grounding-api-redirect/A"))
      .resolves.toBe("www.sofascore.com");
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "HEAD", redirect: "manual" }));
  });

  it("servidor que recusa HEAD recebe um GET, também sem seguir", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response("corpo que não é lido", { status: 302, headers: { location: "https://www.espn.com/y" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveGroundingRedirectHost("https://vertexaisearch.cloud.google.com/grounding-api-redirect/B"))
      .resolves.toBe("www.espn.com");
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ method: "GET", redirect: "manual" }));
  });

  it("sem redirecionamento, ou com falha de rede, não confirma", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(resolveGroundingRedirectHost("https://vertexaisearch.cloud.google.com/grounding-api-redirect/C")).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout"); }));
    await expect(resolveGroundingRedirectHost("https://vertexaisearch.cloud.google.com/grounding-api-redirect/C")).resolves.toBeNull();
  });
});

describe("geminiSearchModels", () => {
  afterEach(() => { mocks.env.GEMINI_SEARCH_MODELS = undefined; });

  it("não herda os modelos de leitura do catálogo: o padrão são os 2.5 com busca no plano gratuito", () => {
    mocks.env = {};
    expect(geminiSearchModels()).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
    expect(geminiSearchModels().some((m) => m.startsWith("gemini-3"))).toBe(false);
  });

  it("respeita GEMINI_SEARCH_MODELS quando definido", () => {
    mocks.env.GEMINI_SEARCH_MODELS = "gemini-2.5-flash";
    expect(geminiSearchModels()).toEqual(["gemini-2.5-flash"]);
  });
});
