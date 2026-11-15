import { describe, expect, it } from "vitest";
import { failureAction, KeyRotation, parseGaps } from "@/scripts/lib/bench-schedule";

const now = Date.parse("2026-09-23T15:00:00Z");
const failure = (overrides: Partial<Parameters<typeof failureAction>[0]>) => failureAction({
  provider: "groq", status: 500, message: "", retryAfter: null, timedOut: false, attempt: 0, ...overrides,
}, now);

describe("failureAction", () => {
  it("espera o que o 429 pede e desiste depois de tentar de novo", () => {
    expect(failure({ status: 429, message: "Rate limit reached", retryAfter: "12" })).toEqual({ action: "retry", waitMs: 12_000, reason: "rate_limit" });
    expect(failure({ status: 429, message: "Rate limit reached", retryAfter: "12", attempt: 6 })).toEqual({ action: "record", status: "rate_limit" });
  });

  it("tira o modelo da rodada quando a cota é zero, acabou no dia ou o modelo não existe", () => {
    expect(failure({ provider: "gemini", status: 429, message: "Quota exceeded for metric: free_tier_requests, limit: 0" }))
      .toEqual({ action: "stop_model", status: "sem_cota", pending: false });
    expect(failure({ status: 429, message: "Rate limit reached on requests per day (RPD)" }))
      .toEqual({ action: "stop_model", status: "sem_cota", pending: true });
    expect(failure({ provider: "mistral", status: 429, message: "Rate limit exceeded (limit: 0 por minuto neste plano)" }))
      .toEqual({ action: "stop_model", status: "sem_cota", pending: false });
    expect(failure({ provider: "gemini", status: 400, message: "This model only supports Interactions API." }))
      .toEqual({ action: "stop_model", status: "modelo_indisponivel", pending: false });
    expect(failure({ status: 404, message: "The model does not exist" }))
      .toEqual({ action: "stop_model", status: "modelo_indisponivel", pending: false });
  });

  it("para o provedor inteiro com a credencial recusada", () => {
    expect(failure({ status: 401, message: "Invalid API Key" })).toEqual({ action: "stop_provider", status: "credencial" });
    expect(failure({ provider: "gemini", status: 403, message: "Your project has been denied access. Please contact support." }))
      .toEqual({ action: "stop_provider", status: "credencial" });
    expect(failure({ provider: "gemini", status: 400, message: "API key not valid. Please pass a valid API key. [API_KEY_INVALID]" }))
      .toEqual({ action: "stop_provider", status: "credencial" });
    expect(failure({ provider: "gemini", status: 403, message: "API key not valid." }))
      .toEqual({ action: "stop_provider", status: "credencial" });
  });

  it("tenta de novo a indisponibilidade passageira, mas não o timeout", () => {
    expect(failure({ status: 503, message: "high demand" })).toEqual({ action: "retry", waitMs: 5000, reason: "transient" });
    expect(failure({ status: 503, message: "high demand", attempt: 2 })).toEqual({ action: "record", status: "indisponivel" });
    expect(failure({ status: 0, timedOut: true })).toEqual({ action: "record", status: "timeout" });
    expect(failure({ status: 400, message: "invalid request" })).toEqual({ action: "record", status: "erro_http" });
  });
});

describe("parseGaps", () => {
  it("lê o intervalo por provedor e recusa valor inválido", () => {
    expect(parseGaps("gemini=7000, groq=0")).toEqual({ gemini: 7000, groq: 0 });
    expect(parseGaps(undefined)).toEqual({});
    expect(() => parseGaps("gemini=rápido")).toThrow(/intervalo inválido/);
  });
});

describe("KeyRotation", () => {
  it("troca de chave no mesmo item e tira a chave só do modelo que ela não atende", () => {
    const keys = new KeyRotation([{ hint: "nova", value: "k1" }, { hint: "antiga", value: "k2" }]);
    expect(keys.next("m", new Set())?.hint).toBe("nova");
    expect(keys.next("m", new Set(["nova"]))?.hint).toBe("antiga");
    expect(keys.next("m", new Set(["nova", "antiga"]))).toBeNull();
    keys.block("m", "nova", false);
    expect(keys.next("m", new Set())?.hint).toBe("antiga");
    expect(keys.next("outro", new Set())?.hint).toBe("nova");
    expect(keys.exhausted("m")).toBeNull();
    keys.block("m", "antiga", true);
    expect(keys.exhausted("m")).toEqual({ pending: true });
    keys.blockEverywhere("nova");
    expect(keys.next("outro", new Set())?.hint).toBe("antiga");
  });
});
