import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { epochSessaoAtual, garantirEpochSessao } from "@/src/services/auth/session-epoch";

/** Época de sessão por usuário, em estado dedicado. */

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
});

describe("session-epoch", () => {
  it("sem login → null; garantir grava e devolve a época", async () => {
    expect(await epochSessaoAtual("fab")).toBeNull();
    const e1 = await garantirEpochSessao("fab");
    expect(await epochSessaoAtual("fab")).toBe(e1);
  });

  it("épocas de usuários diferentes não se misturam", async () => {
    await garantirEpochSessao("alice");
    expect(await epochSessaoAtual("alice")).toBe(1);
    expect(await epochSessaoAtual("bob")).toBeNull();
  });

  it("garantir cria época 1 sem revogar dispositivos", async () => {
    await db.prisma.authDeviceSession.create({
      data: {
        username: "fab",
        tokenHash: "hash",
        deviceName: "Playwright E2E",
        userAgent: "test",
        ipHash: "ip-hash",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const e1 = await garantirEpochSessao("fab");
    expect(e1).toBe(1);
    expect(await epochSessaoAtual("fab")).toBe(1);
    const session = await db.prisma.authDeviceSession.findFirstOrThrow({ where: { username: "fab" } });
    expect(session.revokedAt).toBeNull();
  });

  it("garantir paralelo sob corrida devolve a mesma época e não rotaciona", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => garantirEpochSessao("fab")),
    );
    expect(new Set(results)).toEqual(new Set([1]));
    expect(await epochSessaoAtual("fab")).toBe(1);
    // Segundo lote reutiliza sem incrementar.
    const again = await Promise.all(
      Array.from({ length: 4 }, () => garantirEpochSessao("fab")),
    );
    expect(new Set(again)).toEqual(new Set([1]));
  });
});
