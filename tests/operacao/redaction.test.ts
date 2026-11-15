import { describe, expect, it } from "vitest";
import { isSensitiveKey, redactSensitiveValue, scrubSecrets } from "@/src/infra/redaction";

/**
 * O `redact` do pino protege CHAVES; mensagem de erro de infra carrega
 * credencial no CORPO da string.
 */
describe("scrubSecrets", () => {
  it("apaga credencial embutida em URL de conexão", () => {
    expect(scrubSecrets("ConnectETIMEDOUT postgresql://user:s3nha@host:5432/db"))
      .toBe("ConnectETIMEDOUT postgresql://[redacted]");
  });

  it("apaga chave de provider em query string", () => {
    expect(scrubSecrets("GET https://api.x.com/v4?apiKey=abc123&regions=eu"))
      .toBe("GET https://api.x.com/v4?apiKey=[redacted]&regions=eu");
  });

  it("apaga chave Gemini no parâmetro query key", () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=AIzaSy1234567890abcdef&alt=json";
    const scrubbed = scrubSecrets(url);
    expect(scrubbed).toContain("?key=[redacted]&alt=json");
    expect(scrubbed).not.toContain("AIzaSy1234567890abcdef");
    expect(scrubSecrets("cache key=local-value")).toBe("cache key=local-value");
  });

  it("apaga o token do Bearer, não só o rótulo", () => {
    const saida = scrubSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.assinatura");
    expect(saida).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("apaga cookie inteiro em header", () => {
    const saida = scrubSecrets("Cookie: session=segredo; preference=dark\nHTTP 401");
    expect(saida).toBe("Cookie: [redacted]\\nHTTP 401");
  });

  it("não mutila mensagem sem segredo", () => {
    expect(scrubSecrets("password authentication failed for user \"automabaca\""))
      .toBe("password authentication failed for user \"automabaca\"");
    expect(scrubSecrets("HTTP 502 no provider")).toBe("HTTP 502 no provider");
  });

  it("passa adiante o que não é string", () => {
    expect(scrubSecrets(undefined)).toBeUndefined();
    expect(scrubSecrets(42)).toBe(42);
  });
});

describe("isSensitiveKey", () => {
  it.each([
    "apiKey",
    "api_key",
    "geminiKey",
    "groqKey",
    "rapidApiKey",
    "privateKey",
    "private_key",
    "accessKey",
    "API_KEY",
    "GEMINI_API_KEYS",
    "PINNACLE17_RAPIDAPI_KEY",
    "secretKey",
    "secret_access_key",
    "signingKey",
    "encryptionKey",
    "authKey",
    "sessionKey",
    "mistralKey",
    "password",
    "token",
    "botToken",
    "sessionCookie",
  ])("marca %s como sensível", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "key", "keyboard", "market", "home", "status", "hostname",
    "cacheKey", "periodKey", "dayKey", "singletonKey", "resourceKey", "sourceKey", "leagueKey", "incidentKey", "lockKey",
  ])(
    "não marca %s (campo operacional ou não-segredo)",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it("o log e a auditoria guardam a chave operacional e apagam a credencial ao lado dela", () => {
    expect(redactSensitiveValue({
      cacheKey: "matches:29:2026-08-28:UTC:v2", singletonKey: "enrich:bet-1", details: { dayKey: "2026-08-28", apiKey: "segredo" },
    })).toEqual({
      cacheKey: "matches:29:2026-08-28:UTC:v2", singletonKey: "enrich:bet-1", details: { dayKey: "2026-08-28", apiKey: "[redacted]" },
    });
  });

  it("com preserveNewlines, guarda a quebra real em todo o objeto e ainda redige", () => {
    const scrubbed = redactSensitiveValue({
      description: "linha 1\nlinha 2",
      evidence: { message: "Erro: token=abc123segredo\nfim", lista: ["a\nb"], apiKey: "segredo" },
    }, { preserveNewlines: true });
    expect(scrubbed).toEqual({
      description: "linha 1\nlinha 2",
      evidence: { message: "Erro: token=[redacted]\nfim", lista: ["a\nb"], apiKey: "[redacted]" },
    });
    // O padrão continua escapando a quebra, que é o framing do log NDJSON.
    expect(redactSensitiveValue({ description: "linha 1\nlinha 2" })).toEqual({ description: "linha 1\\nlinha 2" });
  });

  it("redige valores de chaves com sufixo key em objetos", () => {
    const scrubbed = redactSensitiveValue({
      geminiKey: "AIzaSy-secret",
      groqKey: "gsk_secret",
      rapidApiKey: "rapid-secret",
      api_key: "env-secret",
      private_key: "pk-secret",
      market: "1x2",
      key: "bet-1",
    });
    expect(scrubbed).toEqual({
      geminiKey: "[redacted]",
      groqKey: "[redacted]",
      rapidApiKey: "[redacted]",
      api_key: "[redacted]",
      private_key: "[redacted]",
      market: "1x2",
      key: "bet-1",
    });
  });
});
