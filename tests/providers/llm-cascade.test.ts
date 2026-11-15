import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { getObservabilityContext, runWithObservabilityContext } from "@/src/infra/observability-context";
import type { LlmGenerateJsonParams } from "@/src/infra/llm/cascade";

const mocks = vi.hoisted(() => ({
  geminiAvailable: vi.fn<() => Promise<boolean>>(),
  geminiGenerateJson: vi.fn<(params: LlmGenerateJsonParams) => Promise<unknown | null>>(),
  groqAvailable: vi.fn<() => Promise<boolean>>(),
  groqGenerateJson: vi.fn<(params: LlmGenerateJsonParams) => Promise<unknown | null>>(),
  mistralAvailable: vi.fn<() => Promise<boolean>>(),
  mistralGenerateJson: vi.fn<(params: LlmGenerateJsonParams) => Promise<unknown | null>>(),
  configured: { gemini: true, groq: true, mistral: true },
  metric: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => mocks.log }));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: mocks.metric }));
vi.mock("@/src/infra/llm/gemini", () => ({
  geminiAvailable: mocks.geminiAvailable, geminiConfigured: () => mocks.configured.gemini, geminiGenerateJson: mocks.geminiGenerateJson,
}));
vi.mock("@/src/infra/llm/groq", () => ({
  groqAvailable: mocks.groqAvailable, groqConfigured: () => mocks.configured.groq, groqGenerateJson: mocks.groqGenerateJson,
}));
vi.mock("@/src/infra/llm/mistral", () => ({
  mistralAvailable: mocks.mistralAvailable, mistralConfigured: () => mocks.configured.mistral, mistralGenerateJson: mocks.mistralGenerateJson,
}));

const { llmAvailable, llmGenerateJson, llmGenerateJsonOutcome } = await import("@/src/infra/llm/cascade");

const params: LlmGenerateJsonParams = {
  parts: [{ text: "private prompt" }],
  systemInstruction: "private instruction",
  responseSchema: { type: "object" },
  label: "test",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured = { gemini: true, groq: true, mistral: true };
  for (const available of [mocks.geminiAvailable, mocks.groqAvailable, mocks.mistralAvailable]) available.mockReset().mockResolvedValue(false);
  for (const generate of [mocks.geminiGenerateJson, mocks.groqGenerateJson, mocks.mistralGenerateJson]) generate.mockReset().mockResolvedValue(null);
});

describe("ordem da cascata", () => {
  it("llmAvailable é false quando nenhum provedor está up", async () => {
    expect(await llmAvailable()).toBe(false);
  });

  it("usa Gemini quando disponível", async () => {
    mocks.geminiAvailable.mockResolvedValue(true);
    mocks.geminiGenerateJson.mockResolvedValue({ ok: 1 });
    expect(await llmGenerateJson(params)).toEqual({ data: { ok: 1 }, provider: "gemini" });
    expect(mocks.groqGenerateJson).not.toHaveBeenCalled();
  });

  it("cai em Groq quando Gemini falha", async () => {
    mocks.geminiAvailable.mockResolvedValue(true);
    mocks.groqAvailable.mockResolvedValue(true);
    mocks.groqGenerateJson.mockResolvedValue({ via: "groq" });
    expect(await llmGenerateJson(params)).toEqual({ data: { via: "groq" }, provider: "groq" });
    expect(mocks.mistralGenerateJson).not.toHaveBeenCalled();
  });

  it("rejeita JSON incompleto via accept e segue a cascata", async () => {
    mocks.geminiAvailable.mockResolvedValue(true);
    mocks.geminiGenerateJson.mockResolvedValue({ isBet: true, evento: "França vs Marrocos", selecao: "França -1.0" });
    mocks.groqAvailable.mockResolvedValue(true);
    mocks.groqGenerateJson.mockResolvedValue({ isBet: true, evento: "França vs Marrocos", selecao: "França -1.0", odds: 2 });
    const r = await llmGenerateJson({
      ...params,
      accept: (data) => {
        const d = data as { odds?: number };
        return typeof d.odds === "number" && d.odds > 1;
      },
    });
    expect(r?.provider).toBe("groq");
    expect(r?.data).toEqual({ isBet: true, evento: "França vs Marrocos", selecao: "França -1.0", odds: 2 });
  });

  it("cai em Mistral quando Gemini e Groq falham", async () => {
    mocks.geminiAvailable.mockResolvedValue(true);
    mocks.groqAvailable.mockResolvedValue(true);
    mocks.mistralAvailable.mockResolvedValue(true);
    mocks.mistralGenerateJson.mockResolvedValue({ via: "mistral" });
    expect(await llmGenerateJson(params)).toEqual({ data: { via: "mistral" }, provider: "mistral" });
  });

  it("pula provedor indisponível sem chamá-lo", async () => {
    mocks.groqAvailable.mockResolvedValue(true);
    mocks.groqGenerateJson.mockResolvedValue({ via: "groq" });
    expect((await llmGenerateJson(params))?.provider).toBe("groq");
    expect(mocks.geminiGenerateJson).not.toHaveBeenCalled();
  });

  it("retorna null quando a cascata esgota", async () => {
    mocks.geminiAvailable.mockResolvedValue(true);
    mocks.groqAvailable.mockResolvedValue(true);
    mocks.mistralAvailable.mockResolvedValue(true);
    expect(await llmGenerateJson(params)).toBeNull();
  });

  it("recupera e segue para o próximo provedor se um provedor lançar exceção não tratada", async () => {
    mocks.geminiAvailable.mockResolvedValue(true);
    mocks.geminiGenerateJson.mockRejectedValue(new Error("Fatal Gemini SDK panic"));
    mocks.groqAvailable.mockResolvedValue(true);
    mocks.groqGenerateJson.mockResolvedValue({ recovered: "groq" });
    expect(await llmGenerateJson(params)).toEqual({ data: { recovered: "groq" }, provider: "groq" });
  });

  it("trata exceção ao checar disponibilidade sem quebrar a cascata", async () => {
    mocks.geminiAvailable.mockRejectedValue(new Error("Breaker DB outage"));
    mocks.groqAvailable.mockResolvedValue(true);
    mocks.groqGenerateJson.mockResolvedValue({ via: "groq" });
    expect(await llmGenerateJson(params)).toEqual({ data: { via: "groq" }, provider: "groq" });
  });

  it("fallback completo com imagem: Gemini e Groq falham, Mistral resolve", async () => {
    mocks.geminiAvailable.mockResolvedValue(true);
    mocks.groqAvailable.mockResolvedValue(true);
    mocks.mistralAvailable.mockResolvedValue(true);
    mocks.mistralGenerateJson.mockResolvedValue({ isBet: true, odds: 1.95, model: "pixtral-12b-2409" });
    const r = await llmGenerateJson({
      ...params,
      parts: [{ text: "Bilhete" }, { inlineData: { mimeType: "image/jpeg", data: "base64mock" } }],
      label: "vision-test",
    });
    expect(r).toEqual({ data: { isBet: true, odds: 1.95, model: "pixtral-12b-2409" }, provider: "mistral" });
  });
});

describe("observabilidade da cascata", () => {
  beforeEach(() => {
    mocks.geminiAvailable.mockResolvedValue(true);
    mocks.groqAvailable.mockResolvedValue(true);
  });

  it("identifica uma cascata de ponta a ponta e resume fallback sem conteúdo privado", async () => {
    const contexts: Array<ReturnType<typeof getObservabilityContext>> = [];
    mocks.geminiGenerateJson.mockImplementation(async () => { contexts.push(getObservabilityContext()); return null; });
    mocks.groqGenerateJson.mockImplementation(async () => { contexts.push(getObservabilityContext()); return { ok: true }; });
    await runWithObservabilityContext({ correlationId: "http_entry", jobId: "job_a" }, async () => {
      expect(await llmGenerateJson(params)).toMatchObject({ provider: "groq" });
      expect(getObservabilityContext()?.llmCallId).toBeUndefined();
    });
    expect(contexts[0]).toMatchObject({ correlationId: "http_entry", jobId: "job_a", llmCallId: expect.stringMatching(/^llm_/) });
    expect(contexts[0]?.llmCallId).toBe(contexts[1]?.llmCallId);
    expect(contexts[0]).toMatchObject({ llmCallStartedAtMs: expect.any(Number), llmEvaluationRandomized: false });
    expect(contexts[0]).toEqual(contexts[1]);
    expect(mocks.log.info).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: "LLM_CASCADE_COMPLETED", reason: "fallback_accepted", providersTried: ["gemini", "groq"], durationMs: expect.any(Number),
    }), expect.any(String));
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain("private");
    expect(mocks.metric).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "llm.cascade", outcome: "success" }));
  });

  it("distingue rejeição de conteúdo de resposta ausente sem inventar erro de rede", async () => {
    mocks.geminiGenerateJson.mockImplementation(async (input) => { input.accept?.({ incomplete: true }); return null; });
    expect(await llmGenerateJson({ ...params, accept: () => false })).toBeNull();
    expect(mocks.log.info).toHaveBeenCalledWith(expect.objectContaining({ provider: "gemini", reason: "content_rejected" }), expect.any(String));
    expect(mocks.log.info).toHaveBeenCalledWith(expect.objectContaining({ provider: "groq", reason: "no_usable_response" }), expect.any(String));
    expect(mocks.metric).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "llm.cascade", outcome: "expected_retry" }));
  });

  it("recusa num provedor com o outro fora do ar por transporte conta como falha da cascata", async () => {
    mocks.geminiGenerateJson.mockImplementation(async (input) => { input.onRouteOutcome?.("responded", "g1"); input.accept?.({ incomplete: true }); return null; });
    mocks.groqGenerateJson.mockImplementation(async (input) => { input.onRouteOutcome?.("unavailable", "q1"); input.onRouteOutcome?.("unavailable", "q2"); return null; });
    expect(await llmGenerateJson({ ...params, accept: () => false })).toBeNull();
    expect(mocks.metric).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: "llm.cascade", outcome: "error", labels: expect.objectContaining({ contentRejected: true, providersDown: "groq" }),
    }));
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.objectContaining({ providersDown: ["groq"], outcome: "error" }), expect.any(String));
  });

  it("modelo que respondeu por outra chave, ou provedor sem rota a tentar, não conta como fora do ar", async () => {
    mocks.geminiGenerateJson.mockImplementation(async (input) => {
      input.onRouteOutcome?.("unavailable", "g1"); input.onRouteOutcome?.("responded", "g1"); input.accept?.({ incomplete: true }); return null;
    });
    mocks.groqGenerateJson.mockResolvedValue(null);
    expect(await llmGenerateJson({ ...params, accept: () => false })).toBeNull();
    expect(mocks.metric).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "llm.cascade", outcome: "expected_retry" }));
  });

  it("registra falta de provedor sem fingir que houve tentativas", async () => {
    mocks.geminiAvailable.mockResolvedValue(false);
    mocks.groqAvailable.mockResolvedValue(false);
    expect(await llmGenerateJson(params)).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "no_provider_available", providersTried: [], providersSkipped: ["gemini", "groq", "mistral"] }), expect.any(String));
    expect(mocks.geminiGenerateJson).not.toHaveBeenCalled();
    expect(mocks.metric).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "llm.cascade", outcome: "error" }));
  });

  it("persiste exatamente um resultado final quando a validação lança uma exceção", async () => {
    mocks.geminiGenerateJson.mockResolvedValue({ ok: true });
    await expect(llmGenerateJson({ ...params, accept: () => { throw new Error("validation failed"); } })).rejects.toThrow("validation failed");
    expect(mocks.metric).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "llm.cascade", outcome: "error" }));
  });
});

describe("desfecho da cascata sem leitura aceita", () => {
  const rejects = async (input: LlmGenerateJsonParams) => { input.onRouteOutcome?.("responded", "m1"); input.accept?.({ incomplete: true }); return null; };
  const down = async (input: LlmGenerateJsonParams) => { input.onRouteOutcome?.("unavailable", "m1"); return null; };
  const refusing = { ...params, accept: () => false };

  beforeEach(() => {
    for (const available of [mocks.geminiAvailable, mocks.groqAvailable, mocks.mistralAvailable]) available.mockResolvedValue(true);
  });

  it("todos os provedores fora: indisponível, para a captura relançar", async () => {
    for (const generate of [mocks.geminiGenerateJson, mocks.groqGenerateJson, mocks.mistralGenerateJson]) generate.mockImplementation(down);
    // Ninguém leu: nem na última tentativa há recusa a registrar.
    expect(await llmGenerateJsonOutcome(refusing)).toEqual({ kind: "unavailable", responded: false });
  });

  it("todos responderam e recusaram: recusa, sem relançar", async () => {
    for (const generate of [mocks.geminiGenerateJson, mocks.groqGenerateJson, mocks.mistralGenerateJson]) generate.mockImplementation(rejects);
    expect(await llmGenerateJsonOutcome(refusing)).toEqual({ kind: "refused" });
    expect(mocks.metric).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: "llm.cascade", labels: expect.objectContaining({ exhaustion: "refused" }),
    }));
  });

  it("um recusou e os outros caíram: indisponível", async () => {
    mocks.geminiGenerateJson.mockImplementation(rejects);
    mocks.groqGenerateJson.mockImplementation(down);
    mocks.mistralGenerateJson.mockImplementation(down);
    // Relança, mas diz que alguém leu: a recusa vale se as tentativas acabarem.
    expect(await llmGenerateJsonOutcome(refusing)).toEqual({ kind: "unavailable", responded: true });
  });

  it("um recusou e outro está com o circuito aberto: indisponível", async () => {
    mocks.geminiGenerateJson.mockImplementation(rejects);
    mocks.groqGenerateJson.mockImplementation(rejects);
    mocks.mistralAvailable.mockResolvedValue(false);
    expect(await llmGenerateJsonOutcome(refusing)).toEqual({ kind: "unavailable", responded: true });
  });

  it("provedor sem chave não impede a recusa dos que leram", async () => {
    mocks.configured.mistral = false;
    mocks.mistralAvailable.mockResolvedValue(false);
    mocks.geminiGenerateJson.mockImplementation(rejects);
    mocks.groqGenerateJson.mockImplementation(rejects);
    expect(await llmGenerateJsonOutcome(refusing)).toEqual({ kind: "refused" });
  });

  it("exceção no adaptador não vira recusa", async () => {
    mocks.geminiGenerateJson.mockImplementation(rejects);
    mocks.groqGenerateJson.mockRejectedValue(new Error("SDK panic"));
    mocks.mistralGenerateJson.mockImplementation(rejects);
    expect(await llmGenerateJsonOutcome(refusing)).toEqual({ kind: "unavailable", responded: true });
  });

  it("prazo esgotado antes da vez de um provedor: indisponível", async () => {
    mocks.geminiGenerateJson.mockImplementation(rejects);
    expect(await llmGenerateJsonOutcome({ ...refusing, deadlineAt: Date.now() - 1 })).toEqual({ kind: "unavailable", responded: false });
  });

  it("um modelo recusou e outros do mesmo provedor caíram: indisponível", async () => {
    // Padrão real: dois modelos do Gemini em timeout ou 503 e um rejeitando.
    mocks.geminiGenerateJson.mockImplementation(async (input) => {
      input.onRouteOutcome?.("unavailable", "gemini-a");
      input.onRouteOutcome?.("unavailable", "gemini-b");
      input.onRouteOutcome?.("responded", "gemini-c"); input.accept?.({ incomplete: true });
      return null;
    });
    mocks.groqGenerateJson.mockImplementation(rejects);
    mocks.mistralGenerateJson.mockImplementation(rejects);
    expect(await llmGenerateJsonOutcome(refusing)).toEqual({ kind: "unavailable", responded: true });
  });

  it("cota numa chave não conta quando outra chave do mesmo modelo respondeu", async () => {
    mocks.geminiGenerateJson.mockImplementation(async (input) => {
      input.onRouteOutcome?.("unavailable", "gemini-a"); input.onRouteOutcome?.("responded", "gemini-a");
      input.accept?.({ incomplete: true });
      return null;
    });
    mocks.groqGenerateJson.mockImplementation(rejects);
    mocks.mistralGenerateJson.mockImplementation(rejects);
    expect(await llmGenerateJsonOutcome(refusing)).toEqual({ kind: "refused" });
  });

  it("leitura aceita devolve o provedor", async () => {
    mocks.geminiGenerateJson.mockResolvedValue({ ok: true });
    expect(await llmGenerateJsonOutcome(params)).toEqual({ kind: "accepted", data: { ok: true }, provider: "gemini" });
  });
});


it("grava o regime de sorteio da imagem na origem da cascata", async () => {
  vi.stubEnv("LLM_VISION_EVALUATION", "1");
  resetEnvCacheForTests();
  const contexts: Array<ReturnType<typeof getObservabilityContext>> = [];
  for (const available of [mocks.geminiAvailable, mocks.groqAvailable, mocks.mistralAvailable]) available.mockResolvedValue(true);
  for (const generate of [mocks.geminiGenerateJson, mocks.groqGenerateJson, mocks.mistralGenerateJson]) {
    generate.mockImplementation(async () => { contexts.push(getObservabilityContext()); return { ok: true }; });
  }
  const before = Date.now();
  try {
    await llmGenerateJson({ ...params, parts: [{ inlineData: { mimeType: "image/png", data: "private" } }] });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ llmEvaluationRandomized: true });
    expect(contexts[0]?.llmCallStartedAtMs).toBeGreaterThanOrEqual(before);
    expect(contexts[0]?.llmCallStartedAtMs).toBeLessThanOrEqual(Date.now());
    expect(getObservabilityContext()?.llmCallStartedAtMs).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
  }
});
