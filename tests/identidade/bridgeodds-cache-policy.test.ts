import { describe, expect, it } from "vitest";
import { bridgeTokenTtlMs } from "@/src/providers/bridgeodds/client";
import { bridgeMissTtlMs } from "@/src/providers/bridgeodds/match";

function jwtWithExp(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.`;
}

describe("política de cache BridgeOdds", () => {
  it("usa expires_in declarado e limita credenciais excessivamente longas", () => {
    expect(bridgeTokenTtlMs("token", 3_600, 0)).toBe(3_600_000);
    expect(bridgeTokenTtlMs("token", 7 * 86_400, 0)).toBe(86_400_000);
  });

  it("deriva o TTL do exp do JWT sem renovar a cada 15 minutos", () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    const exp = Math.floor((now + 2 * 60 * 60_000) / 1_000);
    expect(bridgeTokenTtlMs(jwtWithExp(exp), undefined, now)).toBe(2 * 60 * 60_000);
  });

  it("faz fallback seguro para token opaco e não conserva JWT expirado", () => {
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    expect(bridgeTokenTtlMs("opaco", undefined, now)).toBe(15 * 60_000);
    expect(bridgeTokenTtlMs(jwtWithExp(Math.floor(now / 1_000) - 10), undefined, now))
      .toBe(1_000);
  });

  it("debounce de miss é curto perto do jogo e maior longe dele", () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    expect(bridgeMissTtlMs(new Date("2026-08-24T11:00:00.000Z"), now)).toBe(6 * 60 * 60_000);
    expect(bridgeMissTtlMs(new Date("2026-08-24T18:00:00.000Z"), now)).toBe(30 * 60_000);
    expect(bridgeMissTtlMs(new Date("2026-08-25T18:00:00.000Z"), now)).toBe(60 * 60_000);
  });
});
