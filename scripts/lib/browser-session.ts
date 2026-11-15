// Ferramenta de automação, fora do runtime de produção: roda em tsx
// (`scripts/screenshot-ui.ts`) e no Vitest/Playwright, nunca no Next.
import {
  createSessionValue,
  DEVELOPMENT_SESSION_COOKIE,
  parseAuthUsers,
  PRODUCTION_SESSION_COOKIE,
  type AuthUser,
} from "@/src/infra/auth";
import { createDeviceSession } from "@/src/services/auth/device-sessions";
import { garantirEpochSessao } from "@/src/services/auth/session-epoch";

/**
 * Cookie de sessão VÁLIDO para automação (Playwright, scripts de screenshot).
 *
 * Uma implementação só para o helper do Playwright e o `scripts/screenshot-ui.ts`:
 * montado em dois lugares, um deles fica para trás quando a regra de sessão de
 * `app/(painel)/_auth.ts` muda e passa a fotografar a tela de login reportando
 * "ok". Quem muda a regra quebra os dois de uma vez, e
 * `tests/seguranca/sessao-de-automacao.db.test.ts` pega.
 */

export type BrowserSessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: "/";
  secure: boolean;
};

/**
 * Garante a época sem rotacioná-la: sob workers paralelos, uma rotação
 * invalidaria o cookie dos outros e o teste cairia no login.
 */
export async function mintBrowserSessionCookie(params: {
  userAgent: string;
  /** Origem do painel-alvo, como `http://127.0.0.1:3100`. */
  baseURL: string;
  ip?: string;
}): Promise<{ value: string; user: AuthUser; cookies: BrowserSessionCookie[] }> {
  const user = parseAuthUsers(process.env.AUTH_USERS)[0];
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!user) throw new Error("AUTH_USERS não tem usuário — sem como autenticar o navegador.");
  if (!secret) throw new Error("AUTH_SESSION_SECRET ausente — sem como assinar a sessão.");

  const epoch = await garantirEpochSessao(user.username);
  const device = await createDeviceSession({
    username: user.username,
    userAgent: params.userAgent,
    ip: params.ip ?? "127.0.0.1",
    secret,
  });
  const value = createSessionValue(user, secret, epoch, device);
  // O nome depende do NODE_ENV do servidor-alvo (standalone de produção ou
  // `next dev`), que a automação não conhece: vão os dois, e o servidor lê o
  // seu. `__Host-` exige Secure, Path=/ e cookie só do host.
  const domain = new URL(params.baseURL).hostname;
  return {
    value,
    user,
    cookies: [
      { name: PRODUCTION_SESSION_COOKIE, value, domain, path: "/", secure: true },
      { name: DEVELOPMENT_SESSION_COOKIE, value, domain, path: "/", secure: false },
    ],
  };
}
