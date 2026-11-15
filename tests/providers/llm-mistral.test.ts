import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";

const mocks = vi.hoisted(() => ({
  tripBreaker: vi.fn(async (_name: string) => undefined),
  isBreakerOpen: vi.fn(async (_name: string) => false),
  closeExpiredBreaker: vi.fn(async (_name: string) => undefined),
}));
const { tripBreaker, isBreakerOpen, closeExpiredBreaker } = mocks;
vi.mock("@/src/infra/circuit-breaker", () => ({
  tripBreaker: (name: string) => mocks.tripBreaker(name),
  isBreakerOpen: (name: string) => mocks.isBreakerOpen(name),
  closeExpiredBreaker: (name: string) => mocks.closeExpiredBreaker(name),
}));
vi.mock("@/src/infra/llm/route-cooldown", () => ({ llmRouteAvailable: vi.fn(async () => true), reportUnavailableRoute: vi.fn(async (_route: unknown, report: ((outcome: "unavailable", model: string) => void) | undefined, model: string) => report?.("unavailable", model)), deferLlmRoute: vi.fn(async () => undefined) }));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
const catalog = vi.hoisted(() => ({ models: { text: [] as string[], vision: [] as string[], precisionVision: [] as string[], ocr: [] as string[] } }));
vi.mock("@/src/infra/llm/models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/infra/llm/models")>(),
  cascadeModels: () => catalog.models,
}));
/** Modelos da Mistral no catálogo de teste: os de chat (toda leitura) e os de OCR. */
const setModels = (chat: string[], ocr: string[] = []) => { catalog.models = { text: chat, vision: chat, precisionVision: chat, ocr }; };

const { deferLlmRoute } = await import("@/src/infra/llm/route-cooldown");
const { conflictsWithOcrSplitHandicap, mistralGenerateJson, mistralAvailable } = await import("@/src/infra/llm/mistral");

const chatParams = {
  parts: [{ text: "post" }],
  systemInstruction: "sys",
  responseSchema: { type: "object" },
  label: "mistral-test",
};

const visionParams = {
  parts: [
    { text: "Extraia a tip do bilhete" },
    { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } },
  ],
  systemInstruction: "sys",
  responseSchema: { type: "object" },
  label: "mistral-vision-test",
};

describe("chat Mistral", () => {
  beforeEach(() => {
    process.env.MISTRAL_API_KEY = "msk_test";
    setModels(["mistral-small-test"]);
    delete process.env.LLM_DISABLE_MISTRAL;
    resetEnvCacheForTests();
    tripBreaker.mockReset();
    isBreakerOpen.mockReset();
    isBreakerOpen.mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.MISTRAL_API_KEY;
    delete process.env.LLM_DISABLE_MISTRAL;
    resetEnvCacheForTests();
  });

  it("limita a última chamada ao orçamento restante", async () => {
    setModels(["modelo-a", "modelo-b", "modelo-c"]);
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => elapsed);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(fetch).mockImplementation(async () => { elapsed += elapsed === 0 ? 30_000 : 15_000; throw new DOMException("timeout", "TimeoutError"); });
    expect(await mistralGenerateJson(chatParams)).toBeNull();
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000, 15_000]);
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["modelo-a", "modelo-b"]);
  });

  it("não tenta o próximo modelo quando o chamador dispensa o resto da Mistral", async () => {
    setModels(["modelo-a", "modelo-b"]);
    vi.mocked(fetch).mockImplementation(async () => Response.json({ choices: [{ message: { content: '{"odds":null}' }, finish_reason: "stop" }] }));
    let read = 0;
    expect(await mistralGenerateJson({ ...chatParams, accept: () => { read += 1; return false; },
      skipRemainingModels: (provider) => provider === "mistral" && read > 0 })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  describe("mistralGenerateJson", () => {
    it("retorna null sem chave", async () => {
      delete process.env.MISTRAL_API_KEY;
      resetEnvCacheForTests();
      expect(await mistralAvailable()).toBe(false);
      expect(await mistralGenerateJson(chatParams)).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("parseia JSON válido no primeiro modelo", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      } as Response);
      expect(await mistralGenerateJson(chatParams)).toEqual({ ok: true });
    });

    it("em 429 tripBreaker do modelo e tenta próximo / retorna null", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ message: "capacity exceeded" }),
      } as Response);
      expect(await mistralGenerateJson(chatParams)).toBeNull();
      expect(deferLlmRoute).toHaveBeenCalledWith(expect.objectContaining({ model: "mistral-small-test" }), 429, "capacity exceeded", undefined);
    });

    it("rotaciona para o próximo modelo após falha", async () => {
      setModels(["modelo-a", "modelo-b"]);
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ message: "boom" }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"via":"b"}' } }] }),
        } as Response);
      expect(await mistralGenerateJson(chatParams)).toEqual({ via: "b" });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("a imagem vai à lista de imagem do catálogo, e o texto à de texto", async () => {
      catalog.models = { text: ["texto-a"], vision: ["visao-a"], precisionVision: ["precisao-a"], ocr: [] };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"isBet":true,"odds":1.95}' } }] }),
      } as Response);

      const result = await mistralGenerateJson(visionParams);
      expect(result).toEqual({ isBet: true, odds: 1.95 });
      const requestBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
      expect(requestBody.model).toBe("visao-a");
      expect(requestBody.messages[1].content[1].type).toBe("image_url");

      await mistralGenerateJson({ ...visionParams, precisionVision: true });
      await mistralGenerateJson(chatParams);
      expect(vi.mocked(fetch).mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["precisao-a", "texto-a"]);
    });

    it("rejeita JSON incompleto via accept e avança para o próximo modelo", async () => {
      setModels(["modelo-a", "modelo-b"]);

      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"isBet":true,"evento":"A vs B"}' } }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"isBet":true,"evento":"A vs B","odds":2.10}' } }] }),
        } as Response);

      const result = await mistralGenerateJson({
        ...visionParams,
        accept: (data) => {
          const d = data as { odds?: number };
          return typeof d.odds === "number" && d.odds > 1;
        },
      });

      expect(result).toEqual({ isBet: true, evento: "A vs B", odds: 2.10 });
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});

const image = { inlineData: { mimeType: "image/png", data: "opaque-test-image" } };
const ocrParams = {
  parts: [image, { text: "Legenda: odd mínima 1,92, sem stake" }],
  systemInstruction: "Contrato de extração original.",
  responseSchema: { type: "object", properties: { odds: { type: "number" } } },
  ocrSystemInstruction: "Contrato OCR específico. Legenda: odd mínima 1,92, sem stake",
  ocrSchemaName: "automabaca_narrow_core",
  ocrAccept: (raw: unknown) => raw !== null && typeof raw === "object" && !Array.isArray(raw),
  ocrResponseSchema: { type: "object", properties: { odds: { type: "number" } }, required: ["odds"] },
  label: "channel-image",
};
const annotation = (data: unknown) => new Response(JSON.stringify({ document_annotation: JSON.stringify(data), pages: [{ markdown: "bilhete" }] }), { status: 200 });
const chat = (data: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }] }), { status: 200 });
const error = (status: number, body = "error") => new Response(body, { status });

describe("OCR anotado opt-in na cascata Mistral", () => {
  beforeEach(() => {
    process.env.MISTRAL_API_KEY = "isolated-fake-key";
    setModels(["ministral-14b-test"], ["mistral-ocr-test-a"]);
    delete process.env.LLM_DISABLE_MISTRAL;
    delete process.env.LLM_DISABLE_MISTRAL_CHAT;
    resetEnvCacheForTests();
    tripBreaker.mockClear(); closeExpiredBreaker.mockClear(); isBreakerOpen.mockReset(); isBreakerOpen.mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const key of ["MISTRAL_API_KEY", "MISTRAL_CHAT_NARROW_ONLY", "LLM_DISABLE_MISTRAL", "LLM_DISABLE_MISTRAL_CHAT"]) delete process.env[key];
    resetEnvCacheForTests();
  });

  it("OCR recusa corpo acima do teto e tenta o próximo modelo sem armazenar anotação parcial", async () => {
    setModels([], ["mistral-ocr-test-a", "mistral-ocr-test-b"]);
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ document_annotation: { odds: 999 } }))); controller.close(); },
      cancel,
    }), { headers: { "content-length": String(25 * 1024 * 1024 + 1) } }))
      .mockResolvedValueOnce(annotation({ odds: 2 }));
    expect(await mistralGenerateJson(ocrParams)).toEqual({ odds: 2 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("qualificação exige o perfil medido na imagem e não permite autoaprovação pelo modelo", async () => {
    process.env.MISTRAL_CHAT_NARROW_ONLY = "1"; resetEnvCacheForTests();
    vi.mocked(fetch).mockResolvedValue(annotation({ odds: 2 }));
    expect(await mistralGenerateJson(ocrParams)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await mistralGenerateJson({ ...ocrParams, ocrImageProfile: "compact-bet365-slip-v1" })).toEqual({ odds: 2 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserva o veto de handicap e entrega evidência ao chamador para revisão", async () => {
    process.env.LLM_DISABLE_MISTRAL_CHAT = "1"; resetEnvCacheForTests();
    const data = { isBet: true, selecao: "Chippenham Town +0.5" };
    const onOcrConflict = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      document_annotation: data,
      pages: [{ markdown: "Chippenham Town 0.0,+0.5\nHandicap Asiático" }],
    })));
    expect(await mistralGenerateJson({ ...ocrParams, onOcrConflict })).toBeNull();
    expect(onOcrConflict).toHaveBeenCalledExactlyOnceWith(data);
    expect(closeExpiredBreaker).not.toHaveBeenCalled();
  });
  it("sem OCR no catálogo, o bilhete vai direto ao chat", async () => {
    setModels(["ministral-14b-test"]);
    vi.mocked(fetch).mockResolvedValue(chat({ odds: 2 }));
    expect(await mistralGenerateJson(ocrParams)).toEqual({ odds: 2 });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://api.mistral.ai/v1/chat/completions");
  });

  it("envia imagem e todo contexto com schema original; retorna sem modificar números", async () => {
    vi.mocked(fetch).mockResolvedValue(annotation({ odds: 2, stake: 0, dataTexto: "12/09" }));
    expect(await mistralGenerateJson(ocrParams)).toEqual({ odds: 2, stake: 0, dataTexto: "12/09" });
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://api.mistral.ai/v1/ocr");
    const sent = JSON.parse(String(init?.body));
    expect(sent.document).toEqual({ type: "image_url", image_url: "data:image/png;base64,opaque-test-image" });
    expect(sent.document_annotation_format.json_schema.schema).toEqual(ocrParams.ocrResponseSchema);
    expect(sent.document_annotation_prompt).toContain(ocrParams.ocrSystemInstruction);
    expect(sent.document_annotation_prompt).toBe(ocrParams.ocrSystemInstruction);
    expect(sent.document_annotation_prompt).not.toContain(ocrParams.systemInstruction);
    expect(sent.document_annotation_prompt).toContain("odd mínima 1,92");
    expect(sent.include_image_base64).toBe(false);
    expect(closeExpiredBreaker).toHaveBeenCalledWith("llm:mistral:ocr:mistral-ocr-test-a");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("usa o accept real para rejeitar uma anotação e tentar a próxima família", async () => {
    setModels(["ministral-14b-test"], ["mistral-ocr-test-a", "mistral-ocr-test-b"]);
    vi.mocked(fetch).mockResolvedValueOnce(annotation({ mercado: "inventado" })).mockResolvedValueOnce(annotation({ mercado: "Asian Handicap" }));
    const accept = vi.fn((raw: unknown) => (raw as { mercado?: string }).mercado === "Asian Handicap");
    expect(await mistralGenerateJson({ ...ocrParams, accept })).toEqual({ mercado: "Asian Handicap" });
    expect(accept).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(["mistral-ocr-test-a", "mistral-ocr-test-b"]);
  });

  it("falha de OCR recai no chat explicitamente configurado quando permitido", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(error(500)).mockResolvedValueOnce(chat({ via: "chat" }));
    expect(await mistralGenerateJson(ocrParams)).toEqual({ via: "chat" });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(["https://api.mistral.ai/v1/ocr", "https://api.mistral.ai/v1/chat/completions"]);
  });

  it("fallback de chat usa o mesmo contrato estreito e completa só com evidência da legenda", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(error(500)).mockResolvedValueOnce(chat({ odds: 2, stake: 0 }));
    const normalize = vi.fn((data: unknown) => ({ ...(data as object), stake: 0.5 }));
    expect(await mistralGenerateJson({ ...ocrParams, ocrNormalize: normalize })).toEqual({ odds: 2, stake: 0.5 });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body));
    expect(body.messages[0].content).toContain(ocrParams.ocrSystemInstruction);
    expect(body.messages[1].content).toHaveLength(1);
    expect(normalize).toHaveBeenCalledOnce();
  });

  it("com o chat desligado só o OCR tenta; sem OCR no catálogo, a Mistral fica indisponível", async () => {
    process.env.LLM_DISABLE_MISTRAL_CHAT = "1"; resetEnvCacheForTests();
    vi.mocked(fetch).mockResolvedValue(error(500));
    expect(await mistralGenerateJson(ocrParams)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    setModels(["ministral-14b-test"]);
    expect(await mistralAvailable()).toBe(false);
    expect(await mistralGenerateJson(ocrParams)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "texto", input: { ...ocrParams, parts: [{ text: "post" }] } },
    { name: "álbum", input: { ...ocrParams, parts: [image, image, { text: "legenda" }] } },
    { name: "player precisionVision", input: { ...ocrParams, precisionVision: true } },
  ])("$name preserva chat e não chama OCR", async ({ input }) => {
    vi.mocked(fetch).mockResolvedValue(chat({ ok: true }));
    expect(await mistralGenerateJson(input)).toEqual({ ok: true });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain("/chat/completions");
    process.env.LLM_DISABLE_MISTRAL_CHAT = "1"; resetEnvCacheForTests();
    expect(await mistralGenerateJson(input)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("429 sem corpo JSON abre breaker OCR e não martela o mesmo modelo", async () => {
    process.env.LLM_DISABLE_MISTRAL_CHAT = "1"; resetEnvCacheForTests();
    vi.mocked(fetch).mockResolvedValue(error(429, "temporarily unavailable"));
    expect(await mistralGenerateJson(ocrParams)).toBeNull();
    expect(deferLlmRoute).toHaveBeenCalledWith(expect.objectContaining({ model: "mistral-ocr-test-a" }), 429, expect.any(String), null);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("circuito OCR aberto não impede outra família nem faz request no modelo bloqueado", async () => {
    setModels(["ministral-14b-test"], ["mistral-ocr-test-a", "mistral-ocr-test-b"]);
    isBreakerOpen.mockImplementation(async (name) => name === "llm:mistral:ocr:mistral-ocr-test-a");
    vi.mocked(fetch).mockResolvedValue(annotation({ ok: true }));
    expect(await mistralGenerateJson(ocrParams)).toEqual({ ok: true });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).model).toBe("mistral-ocr-test-b");
  });

  it("com todos os circuitos do OCR abertos, cada modelo de OCR é avisado como não ouvido", async () => {
    setModels(["ministral-14b-test"], ["mistral-ocr-test-a", "mistral-ocr-test-b"]);
    isBreakerOpen.mockImplementation(async (name) => name.startsWith("llm:mistral:ocr:"));
    vi.mocked(fetch).mockResolvedValue(chat({ ok: true }));
    const outcomes: string[] = [];
    expect(await mistralGenerateJson({ ...ocrParams, onRouteOutcome: (outcome, model) => { outcomes.push(`${model}:${outcome}`); } }))
      .toEqual({ ok: true });
    expect(outcomes).toEqual(["mistral-ocr-test-a:unavailable", "mistral-ocr-test-b:unavailable", "ministral-14b-test:responded"]);
  });

  it("anotação malformada ou ausente não vira sucesso por HTTP 200", async () => {
    process.env.LLM_DISABLE_MISTRAL_CHAT = "1"; resetEnvCacheForTests();
    setModels(["ministral-14b-test"], ["mistral-ocr-test-a", "mistral-ocr-test-b"]);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ document_annotation: "invalid json" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pages: [{ markdown: "texto OCR apenas" }] })));
    expect(await mistralGenerateJson(ocrParams)).toBeNull();
    expect(closeExpiredBreaker).not.toHaveBeenCalled();
  });

  it("aceita envelope de anotação objeto sujeito às mesmas validações", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ document_annotation: { odds: 2 } })));
    expect(await mistralGenerateJson(ocrParams)).toEqual({ odds: 2 });
  });

  it("timeout de modelo é 15s e orçamento de 30s interrompe a rotação", async () => {
    process.env.LLM_DISABLE_MISTRAL_CHAT = "1"; resetEnvCacheForTests();
    setModels(["ministral-14b-test"], ["mistral-ocr-test-a", "mistral-ocr-test-b"]);
    let elapsed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => 1000 + elapsed);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(fetch).mockImplementation(async () => { elapsed += 31_000; throw new DOMException("timeout", "TimeoutError"); });
    expect(await mistralGenerateJson(ocrParams)).toBeNull();
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("tenta cada OCR do catálogo uma vez e respeita o desligamento global", async () => {
    process.env.LLM_DISABLE_MISTRAL_CHAT = "1"; resetEnvCacheForTests();
    setModels(["ministral-14b-test"], ["mistral-ocr-test-a", "mistral-ocr-test-b", "mistral-ocr-test-c"]);
    vi.mocked(fetch).mockImplementation(async () => error(500));
    expect(await mistralGenerateJson(ocrParams)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    process.env.LLM_DISABLE_MISTRAL = "1"; resetEnvCacheForTests();
    expect(await mistralGenerateJson(ocrParams)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

const splitAnnotation = { isBet: true, evento: "Bath City x Chippenham Town", mercado: "Handicap Asiático", selecao: "Chippenham Town +0.5", odds: 1.925, stake: 0, dataTexto: "12/09" };
const splitResponse = { pages: [{ markdown: "| Chippenham Town 0.0,+0.5 | 1.925 |\n| --- | --- |\n| Handicap Asiático | |\n| Bath City x Chippenham Town | |" }] };

describe("veto de handicap dividido do OCR", () => {
  it("rejects the recorded OCR4 half-line error without rewriting financial values", () => {
    const before = structuredClone(splitAnnotation);
    expect(conflictsWithOcrSplitHandicap(splitAnnotation, splitResponse)).toBe(true);
    expect(splitAnnotation).toEqual(before);
  });
  it.each(["Chippenham Town +0.25", "Chippenham Town 0.0,+0.5"])("accepts numerically equivalent splitAnnotation %s", (selecao) => {
    expect(conflictsWithOcrSplitHandicap({ ...splitAnnotation, selecao }, splitResponse)).toBe(false);
  });
  it.each(["Chippenham Town -0.25", "Bath City +0.25"])("rejects opposite line or different team %s", (selecao) => {
    expect(conflictsWithOcrSplitHandicap({ ...splitAnnotation, selecao }, splitResponse)).toBe(true);
  });
  it("recognizes signed decimal-comma pairs and preserves ordinary dates and decimals", () => {
    expect(conflictsWithOcrSplitHandicap({ ...splitAnnotation, selecao: "Chippenham Town -0.75" }, { pages: [{ markdown: "Chippenham Town -0,5 / -1,0\nHandicap Asiático" }] })).toBe(false);
    expect(conflictsWithOcrSplitHandicap(splitAnnotation, { pages: [{ markdown: "Data 12/09\nOdd mínima 1,92\nHandicap Asiático\nChippenham Town +0.5" }] })).toBe(false);
  });
  it("does not infer a unique selection when the image transcribes multiple pairs", () => {
    expect(conflictsWithOcrSplitHandicap(splitAnnotation, { pages: [{ markdown: "Chippenham Town 0.0,+0.5\nBath City -0.5,0.0\nHandicap Asiático" }] })).toBe(true);
  });
  it("preserves negative classification and ordinary zero-handicap qualifications", () => {
    expect(conflictsWithOcrSplitHandicap({ isBet: false }, splitResponse)).toBe(false);
    for (const selecao of ["B36 Torshavn II 0.0", "Zwickau -0.0"]) {
      expect(conflictsWithOcrSplitHandicap({ ...splitAnnotation, selecao }, { pages: [{ markdown: `${selecao}\n1.750\nHandicap Asiático` }] })).toBe(false);
    }
  });
});
