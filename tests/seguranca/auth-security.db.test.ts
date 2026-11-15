import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDeviceSession,
  describeDevice,
  DEVICE_SESSION_LIST_LIMIT,
  listActiveDeviceSessions,
  endDeviceSession,
  revokeDeviceSession,
  revokeOtherDeviceSessions,
  validateDeviceSession,
} from "@/src/services/auth/device-sessions";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
const SECRET = "session-secret-with-at-least-32-characters";

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

describe("sessões por dispositivo", () => {
  it("valida token por hash, lista dispositivo e revoga individualmente", async () => {
    expect(describeDevice("Mozilla Chrome/120 Windows")).toBe("Chrome em Windows");
    const createdAt = new Date();
    const session = await createDeviceSession({
      username: "fabricio",
      userAgent: "Mozilla Chrome/120 Windows",
      ip: "203.0.113.7",
      secret: SECRET,
      now: createdAt,
    });
    const stored = await db.prisma.authDeviceSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(stored.tokenHash).not.toBe(session.token);
    expect(stored.ipHash).not.toContain("203.0.113.7");
    await expect(validateDeviceSession({ id: session.id, token: "errado", username: "fabricio", now: new Date(createdAt.getTime() + 60_000) })).resolves.toBe(false);
    await expect(validateDeviceSession({ ...session, username: "fabricio", now: new Date(createdAt.getTime() + 6 * 60_000) })).resolves.toBe(true);

    const listed = await listActiveDeviceSessions("fabricio", session.id);
    expect(listed.total).toBe(1);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ id: session.id, deviceName: "Chrome em Windows", current: true });

    await expect(revokeDeviceSession("fabricio", session.id, "fabricio")).resolves.toBe(true);
    await expect(validateDeviceSession({ ...session, username: "fabricio" })).resolves.toBe(false);
    expect(await db.prisma.auditEvent.count({ where: { action: "auth.session_revoked" } })).toBe(1);

    // Revogar de novo NÃO é erro: o estado final desejado já existe. Lançar
    // prenderia o operador num logout que devolve 503 sem limpar o cookie. E
    // não audita duas vezes o que aconteceu uma.
    await expect(revokeDeviceSession("fabricio", session.id, "fabricio")).resolves.toBe(false);
    expect(await db.prisma.auditEvent.count({ where: { action: "auth.session_revoked" } })).toBe(1);
  });

  it("expira sessão após sete dias de inatividade", async () => {
    const createdAt = new Date("2026-07-01T12:00:00Z");
    const session = await createDeviceSession({
      username: "fabricio",
      userAgent: "Chrome Windows",
      ip: "1",
      secret: SECRET,
      now: createdAt,
    });
    await expect(validateDeviceSession({
      ...session,
      username: "fabricio",
      now: new Date(createdAt.getTime() + 7 * 24 * 60 * 60_000 + 1),
    })).resolves.toBe(false);
  });

  it("revoga todas as outras preservando a sessão atual", async () => {
    const current = await createDeviceSession({ username: "fabricio", userAgent: "Chrome Windows", ip: "1", secret: SECRET });
    const other = await createDeviceSession({ username: "fabricio", userAgent: "Safari iPhone", ip: "2", secret: SECRET });
    await expect(revokeOtherDeviceSessions("fabricio", current.id, "fabricio")).resolves.toBe(1);
    await expect(validateDeviceSession({ ...current, username: "fabricio" })).resolves.toBe(true);
    await expect(validateDeviceSession({ ...other, username: "fabricio" })).resolves.toBe(false);
    await expect(db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "auth.sessions_revoked_other" },
    })).resolves.toMatchObject({ actor: "fabricio", details: { count: 1 } });
  });

  it("lista N de T e não afirma o lote como universo", async () => {
    const current = await createDeviceSession({
      username: "fabricio",
      userAgent: "Chrome Windows",
      ip: "0",
      secret: SECRET,
    });
    for (let i = 1; i <= DEVICE_SESSION_LIST_LIMIT; i += 1) {
      await createDeviceSession({
        username: "fabricio",
        userAgent: `Firefox/${i} Linux`,
        ip: String(i),
        secret: SECRET,
      });
    }
    const listed = await listActiveDeviceSessions("fabricio", current.id);
    expect(listed.total).toBe(DEVICE_SESSION_LIST_LIMIT + 1);
    expect(listed.sessions).toHaveLength(DEVICE_SESSION_LIST_LIMIT);
    expect(listed.sessions.length).toBeLessThan(listed.total);
    expect(listed.sessions).toContainEqual(expect.objectContaining({ id: current.id, current: true }));
  });

  it("reconhece o aparelho só quando o mesmo navegador já entrou pela mesma rede", async () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36";
    const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1";
    const login = (userAgent: string, ip: string, username = "fabricio") =>
      createDeviceSession({ username, userAgent, ip, secret: SECRET });

    await expect(login(chrome, "203.0.113.7")).resolves.toMatchObject({ knownDevice: false, deviceName: "Chrome em Windows" });
    await expect(login(chrome, "203.0.113.7")).resolves.toMatchObject({ knownDevice: true });
    // O navegador comum é fácil de imitar: sozinho, não prova que é o dono.
    await expect(login(chrome, "198.51.100.9")).resolves.toMatchObject({ knownDevice: false });
    await expect(login(safari, "203.0.113.7")).resolves.toMatchObject({ knownDevice: false });
    await expect(login(chrome, "203.0.113.7", "outro")).resolves.toMatchObject({ knownDevice: false });

    // IPv6 troca o endereço temporário dentro do mesmo /64 da casa.
    await login(chrome, "2001:db8:1:2::a");
    await expect(login(chrome, "2001:db8:1:2:ffff::b")).resolves.toMatchObject({ knownDevice: true });
    await expect(login(chrome, "2001:db8:1:3::a")).resolves.toMatchObject({ knownDevice: false });
  });

  it("o logout mantém o aparelho conhecido; a sessão que o dono revogou não", async () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36";
    const login = (ip: string) => createDeviceSession({ username: "fabricio", userAgent: chrome, ip, secret: SECRET });

    const home = await login("203.0.113.7");
    await expect(endDeviceSession("fabricio", home.id)).resolves.toBe(true);
    await expect(validateDeviceSession({ id: home.id, token: home.token, username: "fabricio" })).resolves.toBe(false);
    await expect(endDeviceSession("fabricio", home.id)).resolves.toBe(false);
    await expect(login("203.0.113.7")).resolves.toMatchObject({ knownDevice: true });

    // O intruso entra de outra rede, o dono revoga em Config: o próximo acesso de lá avisa de novo.
    const intruder = await login("198.51.100.9");
    await revokeDeviceSession("fabricio", intruder.id, "fabricio");
    await expect(login("198.51.100.9")).resolves.toMatchObject({ knownDevice: false });
  });

  it("recusa revogar outras sem uma sessão atual identificada", async () => {
    const session = await createDeviceSession({ username: "fabricio", userAgent: "Chrome Windows", ip: "1", secret: SECRET });
    await expect(revokeOtherDeviceSessions("fabricio", "", "fabricio")).rejects.toThrow(
      "Sessão atual inválida",
    );
    await expect(validateDeviceSession({ ...session, username: "fabricio" })).resolves.toBe(true);
  });
});
