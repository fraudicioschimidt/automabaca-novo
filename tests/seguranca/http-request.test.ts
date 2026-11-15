import { describe, expect, it } from "vitest";
import { hasTrustedRequestOrigin } from "@/src/infra/http-request";

function request(headers: Record<string, string> = {}) {
  return new Request("https://v2.fraudicio.com.br/api/auth/login", {
    method: "POST",
    headers,
  });
}

describe("validação de origem de POSTs do navegador", () => {
  it("aceita mesma origem declarada pelo Origin ou Sec-Fetch-Site", () => {
    expect(hasTrustedRequestOrigin(request({ origin: "https://v2.fraudicio.com.br" }))).toBe(true);
    expect(hasTrustedRequestOrigin(request({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(hasTrustedRequestOrigin(request({ "sec-fetch-site": "same-site" }))).toBe(true);
  });

  it("falha fechada quando o cliente não fornece qualquer evidência de origem", () => {
    expect(hasTrustedRequestOrigin(request())).toBe(false);
    expect(hasTrustedRequestOrigin(request({ "sec-fetch-site": "none" }))).toBe(false);
  });

  it("considera os headers confiáveis do proxy reverso", () => {
    const proxied = new Request("http://127.0.0.1:3100/api/auth/login", {
      method: "POST",
      headers: {
        origin: "https://v2.fraudicio.com.br",
        host: "v2.fraudicio.com.br",
        "x-forwarded-proto": "https",
      },
    });
    expect(hasTrustedRequestOrigin(proxied)).toBe(true);
  });

  it("rejeita origem malformada, host diferente e navegação cross-site", () => {
    expect(hasTrustedRequestOrigin(request({ origin: "not-an-origin" }))).toBe(false);
    expect(hasTrustedRequestOrigin(request({ origin: "https://evil.example" }))).toBe(false);
    expect(hasTrustedRequestOrigin(request({ "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("não confia em X-Forwarded-Host enviado pelo cliente", () => {
    expect(hasTrustedRequestOrigin(request({
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
    }))).toBe(false);
  });
});
