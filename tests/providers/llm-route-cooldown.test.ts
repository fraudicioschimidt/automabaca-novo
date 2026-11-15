import { expect, it, vi } from "vitest";
vi.mock("@/src/infra/prisma", () => ({ prisma: {} }));
import { llmHttpCooldown, nextGeminiDailyReset } from "@/src/infra/llm/route-cooldown";
const now = Date.parse("2026-09-12T12:00:00Z");
it("respeita Retry-After em segundos e em data sem confundir quota com qualidade", () => {
  expect(llmHttpCooldown(429, "Rate limit exceeded", "90", now)).toEqual({ reason: "rate_limit", scope: "route", until: new Date(now + 90_000) });
  expect(llmHttpCooldown(503, "", "Sat, 12 Sep 2026 12:02:00 GMT", now)?.until).toEqual(new Date(now + 120_000));
  expect(llmHttpCooldown(200, "invalid JSON", null, now)).toBeNull();
});
it("isola acesso negado ao modelo e bloqueia autenticação da credencial", () => {
  expect(llmHttpCooldown(403, "Labs not available", null, now)?.scope).toBe("route");
  expect(llmHttpCooldown(401, "", null, now)?.scope).toBe("credential");
  expect(llmHttpCooldown(429, "daily quota", null, now)?.until).toEqual(new Date(now + 86_400_000));
  expect(llmHttpCooldown(429, "limit: 0", null, now)?.reason).toBe("quota_zero");
});
it("does not retry a zero allowance every minute or billing on every model", () => {
  expect(llmHttpCooldown(429, 'quota limit: 0', '60', now)?.until).toEqual(new Date(now + 6 * 60 * 60_000));
  expect(llmHttpCooldown(429, 'Prepaid credits exhausted', '5', now)).toEqual({ reason: 'billing', scope: 'credential', until: new Date(now + 60 * 60_000) });
});
it("daily quota ignores a short retry hint and follows Gemini Pacific midnight", () => {
  expect(llmHttpCooldown(429, 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', '48', now, 'gemini')?.until)
    .toEqual(new Date('2026-09-13T07:00:00Z'));
  const winter = Date.parse('2026-01-12T12:00:00Z');
  expect(llmHttpCooldown(429, 'daily quota', '48', winter, 'gemini')?.until)
    .toEqual(new Date('2026-01-13T08:00:00Z'));
});
it("a cota diária fora do Gemini segue o Retry-After, que a Groq manda porque repõe TPD e RPD aos poucos", () => {
  const groqTpd = "Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199404, Requested 6700. Please try again in 46m51.2s.";
  expect(llmHttpCooldown(429, groqTpd, "2812", now, "Groq"))
    .toEqual({ reason: "daily_quota", scope: "route", until: new Date(now + 2_812_000) });
  expect(llmHttpCooldown(429, "Rate limit reached on requests per day (RPD). Please try again in 1m27s.", "87", now, "Groq")?.until)
    .toEqual(new Date(now + 87_000));
  expect(llmHttpCooldown(429, "daily quota", "48", now, "unknown")?.until).toEqual(new Date(now + 48_000));
  // Sem o Retry-After não há reset informado: espera-se um dia.
  expect(llmHttpCooldown(429, groqTpd, null, now, "Groq")?.until).toEqual(new Date(now + 86_400_000));
});
it("a generic mention of prepaid credits does not disable the whole credential", () => {
  expect(llmHttpCooldown(429, 'Rate limit reached; prepaid credits apply to billing', '90', now)?.scope).toBe('route');
  expect(llmHttpCooldown(429, 'Insufficient prepaid credits', null, now)?.scope).toBe('credential');
});
it("reset diário do Gemini respeita dias de 23 e 25 horas", () => {
  expect(nextGeminiDailyReset(Date.parse("2026-03-08T08:00:00Z"))).toBe(Date.parse("2026-03-09T07:00:00Z"));
  expect(nextGeminiDailyReset(Date.parse("2026-11-01T07:00:00Z"))).toBe(Date.parse("2026-11-02T08:00:00Z"));
});
it("modelo inexistente ou não liberado sai da rotação por uma semana, não por 6 h", () => {
  const week = new Date(now + 7 * 86_400_000);
  expect(llmHttpCooldown(403, "Model labs-leanstral-1-5-1 is a Labs model. To use Labs models, an admin must enable them", null, now))
    .toEqual({ reason: "model_permanently_unavailable", scope: "route", until: week });
  expect(llmHttpCooldown(404, "models/gemini-9 is not found for API version v1beta", null, now)?.until).toEqual(week);
  // O Retry-After do provedor manda, para mais ou para menos.
  expect(llmHttpCooldown(404, "not found", "30", now)?.until).toEqual(new Date(now + 30_000));
  expect(llmHttpCooldown(404, "not found", String(10 * 86_400), now)?.until).toEqual(new Date(now + 10 * 86_400_000));
  expect(llmHttpCooldown(400, "Invalid model: pixtral-99", null, now)?.until).toEqual(week);
  expect(llmHttpCooldown(400, "The model `qwen/qwen3.6-27b` has been decommissioned and is no longer supported.", null, now)?.until).toEqual(week);
  // Negação sem sinal de permanência e 400 de conteúdo continuam como antes.
  expect(llmHttpCooldown(403, "Permission denied", null, now)?.until).toEqual(new Date(now + 6 * 60 * 60_000));
  expect(llmHttpCooldown(400, "Failed to generate JSON. Please adjust your prompt.", null, now)).toBeNull();
});
it("chave recusada pelo Gemini (400 API_KEY_INVALID, não 401) bloqueia a credencial", () => {
  const googleError = (code: number, status: string, message: string, reason: string) => JSON.stringify({ error: { code, message, status,
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }] } });
  const blocked = { reason: "authentication", scope: "credential", until: new Date(now + 60 * 60_000) };
  expect(llmHttpCooldown(400, googleError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", "API_KEY_INVALID"), null, now, "gemini")).toEqual(blocked);
  expect(llmHttpCooldown(400, googleError(400, "INVALID_ARGUMENT", "API key expired. Please renew the API key.", "API_KEY_INVALID"), null, now, "gemini")).toEqual(blocked);
  expect(llmHttpCooldown(403, googleError(403, "PERMISSION_DENIED", "Requests to this API method are blocked.", "API_KEY_SERVICE_BLOCKED"), null, now, "gemini")).toEqual(blocked);
});
