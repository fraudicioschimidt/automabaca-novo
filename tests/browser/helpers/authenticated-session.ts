import { type BrowserContext } from "@playwright/test";
import { mintBrowserSessionCookie } from "@/scripts/lib/browser-session";
import { verifySessionValue } from "@/src/infra/auth";
import { revokeDeviceSession } from "@/src/services/auth/device-sessions";

/**
 * Sessão autenticada no contexto do navegador. A montagem do cookie vive em
 * `scripts/lib/browser-session` — o mesmo caminho que
 * `scripts/screenshot-ui.ts` usa, para os dois nunca mais divergirem.
 */
export async function addAuthenticatedSession(params: {
  context: Pick<BrowserContext, "addCookies">;
  baseURL: string;
}): Promise<() => Promise<void>> {
  const cookie = await mintBrowserSessionCookie({ userAgent: "Playwright E2E", baseURL: params.baseURL });
  await params.context.addCookies(cookie.cookies);
  const session = verifySessionValue(cookie.value, process.env.AUTH_SESSION_SECRET ?? "");
  if (!session?.sessionId) throw new Error("Sessão de automação emitida sem dispositivo válido.");
  const sessionId = session.sessionId;
  return async () => { await revokeDeviceSession(cookie.user.username, sessionId, "playwright-test-completed"); };
}
