import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { claimLoginAttempt, completeLoginAttempt, JANELA_MS } from "@/src/services/auth/lockout";
import { privacyHash } from "@/src/infra/privacy";

let db: TestDb;
const IP = "203.0.113.12";
const OTHER_IP = "198.51.100.12";
const ORIGIN_LIMIT = 100;

beforeAll(() => { db = createTestDb(); });
beforeEach(async () => { await db.reset(); });
afterAll(async () => { await db.dispose(); });

async function previousAttempts(count: number, at = new Date()) {
  await db.prisma.auditEvent.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      actor: `unknown-${index}`, action: "auth.login_failed", resource: "auth",
      outcome: "failure", details: { ipHash: privacyHash(IP, "ip") }, createdAt: at,
    })),
  });
}

describe("orçamento de login por origem", () => {
  it("rotação de usernames não permite ultrapassar 100 tentativas por origem", async () => {
    await previousAttempts(ORIGIN_LIMIT);
    expect(await claimLoginAttempt({ username: "new-name", ip: IP })).toEqual({ allowed: false });
    expect(await claimLoginAttempt({ username: "another-name", ip: IP })).toEqual({ allowed: false });
    expect(await claimLoginAttempt({ username: "new-name", ip: OTHER_IP })).toMatchObject({ allowed: true });
  });

  it("reserva atomicamente o saldo da origem entre usernames concorrentes", async () => {
    await previousAttempts(ORIGIN_LIMIT - 3);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      claimLoginAttempt({ username: `rotating-${index}`, ip: IP })));
    expect(claims.filter((claim) => claim.allowed)).toHaveLength(3);
    expect(claims.filter((claim) => !claim.allowed)).toHaveLength(5);
  });

  it("sucesso classifica o claim sem liberar trabalho já consumido pela origem", async () => {
    await previousAttempts(ORIGIN_LIMIT - 1);
    const claim = await claimLoginAttempt({ username: "operator", ip: IP });
    expect(claim.allowed).toBe(true);
    if (!claim.allowed) throw new Error("Era esperada uma última tentativa.");
    await completeLoginAttempt({ claimId: claim.claimId, username: "operator", success: true });
    expect(await claimLoginAttempt({ username: "next-name", ip: IP })).toEqual({ allowed: false });
  });

  it("a janela expirada libera a origem e preserva somente IP pseudonimizado", async () => {
    const now = new Date();
    await previousAttempts(ORIGIN_LIMIT, new Date(now.getTime() - JANELA_MS - 1));
    const claim = await claimLoginAttempt({ username: "after-window", ip: IP, now });
    expect(claim.allowed).toBe(true);
    if (!claim.allowed) throw new Error("Janela anterior não pode bloquear.");
    const row = await db.prisma.auditEvent.findUniqueOrThrow({ where: { id: claim.claimId } });
    expect(row.details).toEqual({ ipHash: privacyHash(IP, "ip") });
    expect(JSON.stringify(row.details)).not.toContain(IP);
  });
});
