import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  claimLoginAttempt: vi.fn(),
  completeLoginAttempt: vi.fn(),
  enterLoginAttempt: vi.fn(),
  releaseLoginAttempt: vi.fn(),
  garantirEpoch: vi.fn(),
  createDeviceSession: vi.fn(),
  clientIp: vi.fn(),
  getEnv: vi.fn(),
  sendOperationalAlert: vi.fn(),
}));

vi.mock("@/src/infra/auth", () => ({
  authenticate: mocks.authenticate,
  createSessionValue: vi.fn(() => "signed-session"),
  parseAuthUsers: vi.fn((raw?: string) => raw ? [{ username: "admin", passwordHash: "hash", role: "admin" }] : []),
  // Como em produção: a sessão com __Host- e o nome antigo a apagar.
  SESSION_COOKIE: "__Host-automabaca_session",
  LEGACY_SESSION_COOKIE: "automabaca_session",
  SESSION_COOKIE_OPTIONS: { httpOnly: true, sameSite: "strict", path: "/", maxAge: 28_800 },
}));
vi.mock("@/src/infra/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/src/services/auth/lockout", () => ({
  clientIpFromHeaders: mocks.clientIp,
  claimLoginAttempt: mocks.claimLoginAttempt,
  completeLoginAttempt: mocks.completeLoginAttempt,
  enterLoginAttempt: mocks.enterLoginAttempt,
}));
vi.mock("@/src/services/auth/session-epoch", () => ({ garantirEpochSessao: mocks.garantirEpoch }));
vi.mock("@/src/services/auth/device-sessions", () => ({ createDeviceSession: mocks.createDeviceSession }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: mocks.sendOperationalAlert }));

const { POST } = await import("@/app/api/auth/login/route");

function request(body: unknown, headers?: HeadersInit): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEnv.mockReturnValue({
    NODE_ENV: "test",
    AUTH_USERS: "configured",
    AUTH_SESSION_SECRET: "x".repeat(40),
  });
  mocks.claimLoginAttempt.mockResolvedValue({ allowed: true, claimId: "claim-1" });
  mocks.completeLoginAttempt.mockResolvedValue(undefined);
  mocks.garantirEpoch.mockResolvedValue(123);
  mocks.createDeviceSession.mockResolvedValue({ id: "device-1", token: "token-1", deviceName: "Chrome em Windows", knownDevice: true });
  mocks.sendOperationalAlert.mockResolvedValue(true);
  mocks.clientIp.mockReturnValue("127.0.0.1");
  mocks.enterLoginAttempt.mockReturnValue(mocks.releaseLoginAttempt);
});

describe("POST /api/auth/login", () => {
  it("rejeita JSON inválido e campos ausentes antes de consultar lockout", async () => {
    for (const req of [request("{"), request({ username: "", password: "" })]) {
      const response = await POST(req);
      expect(response.status).toBe(400);
    }
    expect(mocks.claimLoginAttempt).not.toHaveBeenCalled();
  });

  it("rejeita corpo acima do limite antes de consultar autenticação", async () => {
    const response = await POST(request(
      { username: "admin", password: "x".repeat(70 * 1024) },
      { "content-length": String(70 * 1024) },
    ));
    expect(response.status).toBe(413);
    expect(mocks.claimLoginAttempt).not.toHaveBeenCalled();
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("falha fechada quando autenticação não está configurada", async () => {
    mocks.getEnv.mockReturnValue({ NODE_ENV: "test", AUTH_USERS: "", AUTH_SESSION_SECRET: "" });
    const response = await POST(request({ username: "admin", password: "secret" }));
    expect(response.status).toBe(500);
  });

  it("rajada barrada no processo leva 429 sem tocar o banco nem o scrypt", async () => {
    mocks.enterLoginAttempt.mockReturnValue(null);
    const response = await POST(request({ username: "admin", password: "secret" }));
    expect(response.status).toBe(429);
    expect(mocks.enterLoginAttempt).toHaveBeenCalledWith("127.0.0.1");
    expect(mocks.claimLoginAttempt).not.toHaveBeenCalled();
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("libera a vaga do processo quando o login termina, em qualquer desfecho", async () => {
    mocks.authenticate.mockResolvedValue(null);
    expect((await POST(request({ username: "admin", password: "wrong" }))).status).toBe(401);
    expect(mocks.releaseLoginAttempt).toHaveBeenCalledTimes(1);

    mocks.claimLoginAttempt.mockRejectedValueOnce(new Error("banco fora"));
    await expect(POST(request({ username: "admin", password: "secret" }))).rejects.toThrow("banco fora");
    expect(mocks.releaseLoginAttempt).toHaveBeenCalledTimes(2);
  });

  it("aplica lockout antes de autenticar", async () => {
    mocks.claimLoginAttempt.mockResolvedValue({ allowed: false });
    const response = await POST(request({ username: "admin", password: "secret" }));
    expect(response.status).toBe(429);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("falha fechado quando o proxy não fornece IP confiável", async () => {
    mocks.clientIp.mockReturnValue("");
    const response = await POST(request({ username: "admin", password: "secret" }));
    expect(response.status).toBe(503);
    expect(mocks.claimLoginAttempt).not.toHaveBeenCalled();
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("classifica o claim como falha e retorna 401 para credencial inválida", async () => {
    mocks.authenticate.mockResolvedValue(null);
    const response = await POST(request({ username: "admin", password: "wrong" }));
    expect(response.status).toBe(401);
    expect(mocks.completeLoginAttempt).toHaveBeenCalledWith({
      claimId: "claim-1",
      username: "admin",
      success: false,
    });
  });

  it("emite sessão individual e cookie seguro atrás do proxy HTTPS", async () => {
    mocks.authenticate.mockResolvedValue({ username: "admin", passwordHash: "hash", role: "admin" });
    const response = await POST(request(
      { username: "admin", password: "secret" },
      { origin: "https://localhost", "x-forwarded-proto": "https" },
    ));
    expect(response.status).toBe(200);
    expect(mocks.completeLoginAttempt).toHaveBeenCalledWith({
      claimId: "claim-1",
      username: "admin",
      success: true,
    });
    expect(mocks.garantirEpoch).toHaveBeenCalledWith("admin");
    expect(mocks.createDeviceSession).toHaveBeenCalledWith(expect.objectContaining({
      username: "admin",
      ip: "127.0.0.1",
    }));
    expect(response.cookies.get("__Host-automabaca_session")).toMatchObject({
      value: "signed-session",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    // O cookie com o nome anterior ao __Host- sai no mesmo login.
    expect(response.cookies.get("automabaca_session")).toMatchObject({ value: "", maxAge: 0, path: "/", secure: true });
  });

});
