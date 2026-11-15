import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createSessionValue, SESSION_COOKIE, type AuthUser } from "@/src/infra/auth";
import { createDeviceSession } from "@/src/services/auth/device-sessions";
import { garantirEpochSessao } from "@/src/services/auth/session-epoch";
import { proxy } from "@/proxy";
import { createTestDb, type TestDb } from "../helpers/db";
import { attachAuthenticatedSession } from "@/src/services/auth/http-session";
import * as sessionEpoch from "@/src/services/auth/session-epoch";
import { resetEnvCacheForTests } from "@/src/infra/env";

const alerts = vi.hoisted(() => ({ sendOperationalAlert: vi.fn(async () => true) }));
vi.mock("@/src/services/ops/alerts", () => alerts);

const SECRET = "proxy-session-secret-with-at-least-32-characters";
const USER: AuthUser = { username: "fabricio", passwordHash: "unused" };
let db: TestDb;
let previousUsers: string | undefined;
let previousSecret: string | undefined;

beforeAll(() => {
  db = createTestDb();
  previousUsers = process.env.AUTH_USERS;
  previousSecret = process.env.AUTH_SESSION_SECRET;
  process.env.AUTH_USERS = "fabricio:unused:admin";
  process.env.AUTH_SESSION_SECRET = SECRET;
  resetEnvCacheForTests();
});

afterAll(async () => {
  if (previousUsers === undefined) delete process.env.AUTH_USERS;
  else process.env.AUTH_USERS = previousUsers;
  if (previousSecret === undefined) delete process.env.AUTH_SESSION_SECRET;
  else process.env.AUTH_SESSION_SECRET = previousSecret;
  resetEnvCacheForTests();
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  alerts.sendOperationalAlert.mockClear();
});

function authenticatedRequest(cookie: string): NextRequest {
  return new NextRequest("https://example.test/", {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });
}

describe("proxy de autenticação", () => {
  it("primeiros logins simultâneos mantêm ambos os dispositivos autenticados", async () => {
    const originalRead = sessionEpoch.epochSessaoAtual;
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    // Coordena apenas a corrida de leitura; época, dispositivos e proxy usam Postgres real.
    const read = vi.spyOn(sessionEpoch, "epochSessaoAtual").mockImplementation(async (username) => {
      const epoch = await originalRead(username);
      if (epoch === null) {
        if (++reads === 2) release();
        await bothRead;
      }
      return epoch;
    });
    const responses = [NextResponse.json({ ok: true }), NextResponse.json({ ok: true })];
    try {
      await Promise.all(responses.map((response, i) => attachAuthenticatedSession(
        new NextRequest("https://example.test/api/auth/login", {
          method: "POST",
          headers: { "user-agent": `Device/${i}`, "x-forwarded-for": "203.0.113.7" },
        }),
        response,
        USER,
      )));
    } finally {
      read.mockRestore();
    }
    for (const response of responses) {
      const cookie = response.cookies.get(SESSION_COOKIE)?.value;
      expect(cookie).toBeTruthy();
      expect((await proxy(authenticatedRequest(cookie!))).headers.get("x-middleware-next")).toBe("1");
    }
    expect(await db.prisma.authDeviceSession.count({ where: { username: USER.username, revokedAt: null } })).toBe(2);
  });

  it("encaminha logout com cookie inválido para o handler que limpa a sessão", async () => {
    const response = await proxy(new NextRequest("https://example.test/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=invalido`,
        origin: "https://example.test",
      },
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("server action com a sessão vencida recebe a mensagem, não o HTML do login", async () => {
    const response = await proxy(new NextRequest("https://example.test/tipsters/canal", {
      method: "POST",
      headers: { "next-action": "a".repeat(42), cookie: `${SESSION_COOKIE}=vencido` },
    }));
    expect(response.status).toBe(401);
    // O cliente do Next só usa o corpo como mensagem com este tipo exato.
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("Sessão expirada — faça login novamente.");
    // A navegação comum continua indo para o login.
    const page = await proxy(new NextRequest("https://example.test/tipsters/canal"));
    expect(page.status).toBe(307);
  });

  it("rejeita cookie legado sem sessão de dispositivo", async () => {
    const epoch = await garantirEpochSessao(USER.username);
    const response = await proxy(authenticatedRequest(createSessionValue(USER, SECRET, epoch)));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("aceita cookie HMAC vinculado a dispositivo válido", async () => {
    const epoch = await garantirEpochSessao(USER.username);
    const device = await createDeviceSession({
      username: USER.username,
      userAgent: "Chrome Windows",
      ip: "127.0.0.1",
      secret: SECRET,
    });
    const response = await proxy(authenticatedRequest(
      createSessionValue(USER, SECRET, epoch, device),
    ));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("trocar a senha em AUTH_USERS derruba a sessão já aberta", async () => {
    const epoch = await garantirEpochSessao(USER.username);
    const device = await createDeviceSession({
      username: USER.username,
      userAgent: "Chrome Windows",
      ip: "127.0.0.1",
      secret: SECRET,
    });
    const cookie = createSessionValue(USER, SECRET, epoch, device);
    expect((await proxy(authenticatedRequest(cookie))).headers.get("x-middleware-next")).toBe("1");
    process.env.AUTH_USERS = "fabricio:hash-da-senha-nova";
    try {
      const response = await proxy(authenticatedRequest(cookie));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/login");
    } finally {
      process.env.AUTH_USERS = "fabricio:unused:admin";
    }
  });

  // A liberação de `/fonts/` existe para a página de login não cair no fallback
  // Segoe UI. Como PREFIXO cru, qualquer arquivo que caísse na pasta seria
  // servido sem sessão. O par prefixo+sufixo mantém a fonte pública e devolve
  // todo o resto ao guard.
  it("serve fonte .woff2 sem auth e protege qualquer outro arquivo em /fonts/", async () => {
    const semAuth = async (path: string) =>
      proxy(new NextRequest(`https://example.test${path}`));

    const fonte = await semAuth("/fonts/geist-400-latin.woff2");
    expect(fonte.headers.get("x-middleware-next")).toBe("1");

    for (const path of ["/fonts/segredo.env", "/fonts/backup.sql", "/fonts/sub/dir/x.woff2.txt"]) {
      const bloqueado = await semAuth(path);
      expect(bloqueado.status, path).toBe(307);
      expect(bloqueado.headers.get("location"), path).toContain("/login");
    }
  });
});

describe("aviso de acesso novo", () => {
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36";
  const login = (userAgent: string, ip: string) => attachAuthenticatedSession(
    new NextRequest("https://example.test/api/auth/login", {
      method: "POST",
      headers: { "user-agent": userAgent, "x-forwarded-for": ip },
    }),
    NextResponse.json({ ok: true }),
    USER,
  );

  it("avisa o dono no login de aparelho ou rede nova, e não repete no mesmo aparelho", async () => {
    await login(CHROME, "203.0.113.7");
    expect(alerts.sendOperationalAlert).toHaveBeenCalledTimes(1);
    const [message, context] = alerts.sendOperationalAlert.mock.calls[0] as unknown as [string, { key: string }];
    expect(message).toContain("Novo acesso ao painel: Chrome em Windows");
    expect(message).toContain("Config › Segurança da conta");
    expect(message).not.toContain("203.0.113.7");
    const device = await db.prisma.authDeviceSession.findFirstOrThrow({ where: { username: USER.username } });
    // Uma chave por sessão: dois acessos novos não se fundem no throttle.
    expect(context).toMatchObject({ source: "auth-login", key: `new-device:${device.id}`, resourceId: device.id });

    await login(CHROME, "203.0.113.7");
    expect(alerts.sendOperationalAlert).toHaveBeenCalledTimes(1);

    await login(CHROME, "198.51.100.9");
    expect(alerts.sendOperationalAlert).toHaveBeenCalledTimes(2);
  });

  it("o login segue quando o aviso falha", async () => {
    alerts.sendOperationalAlert.mockRejectedValueOnce(new Error("telegram fora"));
    const response = NextResponse.json({ ok: true });
    await attachAuthenticatedSession(new NextRequest("https://example.test/api/auth/login", {
      method: "POST",
      headers: { "user-agent": CHROME, "x-forwarded-for": "203.0.113.7" },
    }), response, USER);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBeTruthy();
  });
});

describe("cookie de sessão em produção", () => {
  it("usa __Host- com Secure, Path=/ e sem Domain; o nome antigo não autentica", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_HASH_SECRET", "segredo-de-hash-so-deste-teste-com-32-caracteres");
    vi.resetModules();
    // O resto do env de produção (tokens, diretórios) não participa da sessão.
    vi.doMock("@/src/infra/env", async (original) => ({
      ...await original<typeof import("@/src/infra/env")>(),
      getEnv: () => ({ NODE_ENV: "production", AUTH_SESSION_SECRET: SECRET, AUTH_USERS: process.env.AUTH_USERS }),
    }));
    try {
      const auth = await import("@/src/infra/auth");
      const { attachAuthenticatedSession: attach } = await import("@/src/services/auth/http-session");
      const { proxy: productionProxy } = await import("@/proxy");
      expect(auth.SESSION_COOKIE).toBe("__Host-automabaca_session");

      const response = NextResponse.json({ ok: true });
      // Mesmo atrás do proxy em http, produção grava Secure.
      await attach(new NextRequest("http://127.0.0.1:3100/api/auth/login", {
        method: "POST",
        headers: { "user-agent": "Prod/1", "x-forwarded-for": "203.0.113.7" },
      }), response, USER);
      const header = response.headers.get("set-cookie") ?? "";
      expect(header).toMatch(/^__Host-automabaca_session=/);
      expect(header).toMatch(/;\s*Secure/i);
      expect(header).toMatch(/;\s*Path=\//i);
      expect(header).not.toMatch(/Domain=/i);

      const value = response.cookies.get("__Host-automabaca_session")!.value;
      const withCookie = (cookie: string) => productionProxy(new NextRequest("https://example.test/", { headers: { cookie } }));
      expect((await withCookie(`__Host-automabaca_session=${value}`)).headers.get("x-middleware-next")).toBe("1");
      // Depois do deploy, o cookie antigo é ignorado: o dono entra de novo uma vez.
      const legacy = await withCookie(`automabaca_session=${value}`);
      expect(legacy.status).toBe(307);
      expect(legacy.headers.get("location")).toContain("/login");
    } finally {
      vi.doUnmock("@/src/infra/env");
      vi.unstubAllEnvs();
      vi.resetModules();
      resetEnvCacheForTests();
    }
  });
});
