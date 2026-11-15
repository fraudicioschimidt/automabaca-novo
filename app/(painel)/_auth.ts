import { cookies, headers } from "next/headers";
import { parseAuthUsers, SESSION_COOKIE, sessionUser, verifySessionValue } from "@/src/infra/auth";
import { epochSessaoAtual } from "@/src/services/auth/session-epoch";
import { validateDeviceSession } from "@/src/services/auth/device-sessions";

/**
 * Guarda de autorização das server actions do painel (borda de mutação).
 * Em produção revalida cookie HMAC + época + AUTH_USERS (usuário e senha
 * vigente) + sessão de dispositivo — NÃO confia só em `x-auth-*`. Em Vitest,
 * aceita headers mockados (sem cookie de sessão).
 */

type Session = { username: string; sessionId?: string };

async function resolveSession(): Promise<Session | null> {
  // Só Vitest — nunca NODE_ENV=test (bypass forjável se o web subir assim).
  if (process.env.NODE_ENV !== "production" && process.env.VITEST === "true") {
    const user = (await headers()).get("x-auth-user");
    if (user) {
      return { username: user, sessionId: (await headers()).get("x-auth-session-id") ?? undefined };
    }
    return null;
  }

  const secret = process.env.AUTH_SESSION_SECRET;
  const users = parseAuthUsers(process.env.AUTH_USERS);
  if (!secret || users.length === 0) return null;

  const jar = await cookies();
  const session = verifySessionValue(jar.get(SESSION_COOKIE)?.value, secret);
  if (!session) return null;
  if (!session.sessionId || !session.sessionToken) return null;

  const known = sessionUser(session, users, secret);
  if (!known) return null;

  const [epochAtual, valid] = await Promise.all([
    epochSessaoAtual(session.username),
    validateDeviceSession({
      id: session.sessionId,
      token: session.sessionToken,
      username: session.username,
    }),
  ]);
  if (epochAtual === null || session.epoch !== epochAtual) return null;
  if (!valid) return null;

  return { username: known.username, sessionId: session.sessionId };
}

/**
 * Gate único do painel: sessão válida = operador pleno. O sistema tem um
 * operador só, então não há papéis: um gate duplo só criaria caminhos que
 * ninguém exerce.
 */
export async function requireSession(): Promise<void> {
  const s = await resolveSession();
  if (!s) {
    throw new Error("Sessão inválida — faça login novamente.");
  }
}

/**
 * Operador que disparou a ação, para o audit/ledger. Lança se a sessão faltar:
 * é a mesma guarda de `requireSession`, então a ação que grava com ator chama
 * só esta, no início, antes de validar a entrada.
 */
export async function actor(): Promise<string> {
  const s = await resolveSession();
  if (!s) throw new Error("Sessão inválida — faça login novamente.");
  return s.username;
}

export async function currentSessionId(): Promise<string | null> {
  return (await resolveSession())?.sessionId ?? null;
}

/** Há sessão válida? Alimenta o `canManage` das telas. */
export async function canManage(): Promise<boolean> {
  return (await resolveSession()) !== null;
}
