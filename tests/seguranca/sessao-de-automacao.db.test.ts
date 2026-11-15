import { beforeAll, describe, expect, it } from "vitest";
import { parseAuthUsers, sessionUser, verifySessionValue } from "@/src/infra/auth";
import { mintBrowserSessionCookie } from "@/scripts/lib/browser-session";
import { validateDeviceSession } from "@/src/services/auth/device-sessions";
import { epochSessaoAtual } from "@/src/services/auth/session-epoch";
import { addAuthenticatedSession } from "../browser/helpers/authenticated-session";

/**
 * A sessão que a automação monta (helper do Playwright e `screenshot-ui`) tem
 * de passar nas mesmas checagens da borda real (`app/(painel)/_auth.ts`). Sem
 * isso, apertar a regra de sessão faz a automação cair em `/login` e fotografar
 * a tela de login achando que deu certo (o redirect termina em 200).
 */

describe("sessão de automação", () => {
  beforeAll(() => {
    process.env.AUTH_USERS ??= "fabricio:scrypt$00$00:admin";
    process.env.AUTH_SESSION_SECRET ??= "segredo-de-teste-para-automacao";
  });

  it("o cookie do helper compartilhado passa em TODAS as checagens da borda", async () => {
    const cookie = await mintBrowserSessionCookie({ userAgent: "portão de automação", baseURL: "http://127.0.0.1:3100" });

    // Exatamente o que app/(painel)/_auth.ts e proxy.ts exigem, em ordem.
    const sessao = verifySessionValue(cookie.value, process.env.AUTH_SESSION_SECRET!);
    expect(sessao, "cookie não passou na verificação de assinatura/validade").not.toBeNull();
    expect(sessao!.sessionId, "cookie sem id de dispositivo — a borda rejeita").toBeTruthy();
    expect(sessao!.sessionToken, "cookie sem token de dispositivo — a borda rejeita").toBeTruthy();

    const conhecido = sessionUser(sessao!, parseAuthUsers(process.env.AUTH_USERS), process.env.AUTH_SESSION_SECRET!);
    expect(conhecido, "usuário do cookie não está em AUTH_USERS com a senha vigente").not.toBeNull();

    const epoch = await epochSessaoAtual(sessao!.username);
    expect(epoch, "sem época gravada — a borda rejeita fail-closed").not.toBeNull();
    expect(sessao!.epoch, "época do cookie diferente da vigente").toBe(epoch);

    const dispositivoValido = await validateDeviceSession({
      id: sessao!.sessionId!,
      token: sessao!.sessionToken!,
      username: sessao!.username,
    });
    expect(dispositivoValido, "sessão de dispositivo não valida no banco").toBe(true);
  });

  it("manda a sessão com o nome de produção (__Host-) e o de desenvolvimento", async () => {
    const cookie = await mintBrowserSessionCookie({ userAgent: "portão de automação", baseURL: "http://127.0.0.1:3100" });
    expect(cookie.cookies).toEqual([
      { name: "__Host-automabaca_session", value: cookie.value, domain: "127.0.0.1", path: "/", secure: true },
      { name: "automabaca_session", value: cookie.value, domain: "127.0.0.1", path: "/", secure: false },
    ]);
  });

  it("cleanup do helper revoga somente o dispositivo que ele emitiu", async () => {
    const cookies: Array<{ value: string }> = [];
    const context = { addCookies: async (items: ReadonlyArray<{ value: string }>) => { cookies.push(...items); } };
    const cleanupFirst = await addAuthenticatedSession({ context, baseURL: "http://127.0.0.1:3100" });
    const cleanupSecond = await addAuthenticatedSession({ context, baseURL: "http://127.0.0.1:3100" });
    try {
      const first = verifySessionValue(cookies[0]!.value, process.env.AUTH_SESSION_SECRET!)!;
      // Cada sessão vai com os dois nomes de cookie; a segunda começa no índice 2.
      const second = verifySessionValue(cookies[2]!.value, process.env.AUTH_SESSION_SECRET!)!;
      const valid = (session: typeof first) => validateDeviceSession({
        id: session.sessionId!, token: session.sessionToken!, username: session.username,
      });
      expect(await valid(first)).toBe(true);
      expect(await valid(second)).toBe(true);
      await cleanupFirst();
      expect(await valid(first)).toBe(false);
      expect(await valid(second)).toBe(true);
    } finally {
      await cleanupFirst();
      await cleanupSecond();
    }
  });
});
