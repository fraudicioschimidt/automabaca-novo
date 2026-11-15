import { describe, expect, it } from "vitest";
import {
  clientIpFromHeaders,
  enterLoginAttempt,
  LOGIN_IN_FLIGHT_MAX,
  LOGIN_ORIGIN_MAX_PER_MINUTE,
} from "@/src/services/auth/lockout";

/**
 * IP do cliente para o lockout — NÃO pode ser forjável.
 * O Caddy escreve X-Forwarded-For, mas repassa X-Real-IP do cliente.
 * Em uma cadeia appendada, só o último elemento vem do proxy imediato.
 */
const h = (obj: Record<string, string>): Headers => new Headers(obj);

describe("clientIpFromHeaders", () => {
  it("aceita headers concordantes usando o último IP encaminhado", () => {
    expect(
      clientIpFromHeaders(h({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4, 9.9.9.9" })),
    ).toBe("9.9.9.9");
  });

  it("ignora X-Real-IP forjado quando o Caddy encaminha o IP real", () => {
    expect(clientIpFromHeaders(h({
      "x-real-ip": "198.51.100.99",
      "x-forwarded-for": "203.0.113.7",
    }))).toBe("203.0.113.7");
  });

  it("recusa origem sem XFF válido, mesmo com X-Real-IP preenchido", () => {
    for (const forwarded of [undefined, "", "invalid", "203.0.113.7, "]) {
      expect(clientIpFromHeaders(h({
        "x-real-ip": "198.51.100.99",
        ...(forwarded === undefined ? {} : { "x-forwarded-for": forwarded }),
      })), String(forwarded)).toBe("");
    }
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "2001:db8::7" }))).toBe("2001:db8::7");
  });

  it("sem X-Real-IP, ignora o XFF forjado (1º elem) e usa o último (anexado pelo proxy)", () => {
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "1.2.3.4, 200.0.0.1" }))).toBe("200.0.0.1");
  });

  it("XFF com um IP só", () => {
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("sem headers → vazio (lockout cai para só-por-usuário)", () => {
    expect(clientIpFromHeaders(h({}))).toBe("");
  });
});

/**
 * Freio do processo antes do banco: rajada anônima não pode ocupar o pool de
 * conexões que as páginas do dono usam, nem enfileirar scrypt.
 */
describe("enterLoginAttempt", () => {
  it("limita os logins em andamento no processo, de qualquer origem", () => {
    const now = Date.now();
    const slots = Array.from({ length: LOGIN_IN_FLIGHT_MAX }, (_, i) => enterLoginAttempt(`192.0.2.${i + 1}`, now));
    expect(slots.every((release) => typeof release === "function")).toBe(true);
    expect(enterLoginAttempt("192.0.2.200", now)).toBeNull();

    slots[0]!();
    slots[0]!(); // liberar duas vezes não abre vaga a mais
    const next = enterLoginAttempt("192.0.2.200", now);
    expect(next).not.toBeNull();
    expect(enterLoginAttempt("192.0.2.201", now)).toBeNull();
    for (const release of [...slots.slice(1), next]) release!();
  });

  it("uma origem passa poucas vezes por minuto, e o /64 do IPv6 é uma origem só", () => {
    const now = Date.now();
    for (let i = 1; i <= LOGIN_ORIGIN_MAX_PER_MINUTE; i++) {
      const release = enterLoginAttempt(`2001:db8:9:9::${i}`, now);
      expect(release, `tentativa ${i}`).not.toBeNull();
      release!();
    }
    expect(enterLoginAttempt("2001:db8:9:9:abcd::1", now)).toBeNull();

    const otherOrigin = enterLoginAttempt("2001:db8:9:a::1", now);
    expect(otherOrigin).not.toBeNull();
    otherOrigin!();
    const nextMinute = enterLoginAttempt("2001:db8:9:9::1", now + 60_000);
    expect(nextMinute).not.toBeNull();
    nextMinute!();
  });
});
