import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifySession = vi.fn();
const endDeviceSession = vi.fn();
const sendOperationalAlert = vi.fn();
const logError = vi.fn();
const logWarn = vi.fn();
vi.mock("@/src/infra/auth", () => ({
  // Como em produção: a sessão com __Host- e o nome antigo a apagar.
  SESSION_COOKIE: "__Host-automabaca_session",
  LEGACY_SESSION_COOKIE: "automabaca_session",
  SESSION_COOKIE_OPTIONS: { httpOnly: true, sameSite: "strict", path: "/", maxAge: 28_800 },
  verifySessionValue: verifySession,
}));
vi.mock("@/src/infra/env", () => ({
  getEnv: vi.fn(() => ({ NODE_ENV: "test", AUTH_SESSION_SECRET: "x".repeat(40) })),
}));
vi.mock("@/src/services/auth/device-sessions", () => ({ endDeviceSession }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert }));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ error: logError, warn: logWarn }),
}));

const { POST } = await import("@/app/api/auth/logout/route");

beforeEach(() => {
  vi.clearAllMocks();
  endDeviceSession.mockResolvedValue(true);
  sendOperationalAlert.mockResolvedValue(true);
});

describe("POST /api/auth/logout", () => {
  it("cookie legado só é removido, sem revogar sessões modernas", async () => {
    verifySession.mockReturnValue({ username: "admin", role: "admin", epoch: 1 });
    const request = new NextRequest("https://localhost/api/auth/logout", {
      method: "POST",
      headers: { cookie: "__Host-automabaca_session=valid", origin: "https://localhost" },
    });
    const response = await POST(request);
    expect(endDeviceSession).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.cookies.get("__Host-automabaca_session")).toMatchObject({ value: "", maxAge: 0, secure: true });
    expect(response.cookies.get("automabaca_session")).toMatchObject({ value: "", maxAge: 0, path: "/", secure: true });
  });

  it("revoga somente o dispositivo em sessões modernas", async () => {
    verifySession.mockReturnValue({
      username: "admin",
      role: "admin",
      epoch: 1,
      sessionId: "session-1",
      sessionToken: "token-1",
    });
    const request = new NextRequest("https://localhost/api/auth/logout", {
      method: "POST",
      headers: { cookie: "__Host-automabaca_session=valid", origin: "https://localhost" },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(endDeviceSession).toHaveBeenCalledWith("admin", "session-1");
  });

  it("falha de forma visível e preserva o cookie quando a revogação falha", async () => {
    verifySession.mockReturnValue({
      username: "admin",
      role: "admin",
      epoch: 1,
      sessionId: "session-1",
      sessionToken: "token-1",
    });
    endDeviceSession.mockRejectedValue(new Error("banco indisponível"));
    sendOperationalAlert.mockRejectedValueOnce(new Error("canal de alerta indisponível"));
    const response = await POST(new NextRequest("https://localhost/api/auth/logout", {
      method: "POST",
      headers: { cookie: "__Host-automabaca_session=valid", origin: "https://localhost" },
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Não foi possível encerrar a sessão com segurança. Tente novamente.",
    });
    expect(response.cookies.get("__Host-automabaca_session")).toBeUndefined();
    expect(response.cookies.get("automabaca_session")).toBeUndefined();
    expect(logError).toHaveBeenCalledOnce();
    expect(sendOperationalAlert).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(logWarn).toHaveBeenCalledOnce());
  });

  it("cookie inválido continua sendo removido sem escrever estado global", async () => {
    verifySession.mockReturnValue(null);
    const response = await POST(new NextRequest("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { origin: "http://localhost" },
    }));
    expect(response.status).toBe(200);
    expect(endDeviceSession).not.toHaveBeenCalled();
    expect(response.cookies.get("__Host-automabaca_session")?.secure).toBe(false);
  });
});
