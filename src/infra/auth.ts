import { createHash, createHmac, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Autenticação do painel:
 * AUTH_USERS="user:scrypt$salt$hash,..." + sessão HMAC em cookie.
 * Sem dependência de banco neste módulo — a época e a sessão de dispositivo
 * vivem em `services/auth` e são checadas no proxy. Revogar um aparelho é em
 * Config › Segurança da conta; o corte de todas as sessões é trocar a senha em
 * AUTH_USERS (a impressão do hash no cookie deixa de bater) ou o
 * AUTH_SESSION_SECRET. Nada gira a época hoje.
 */

/**
 * Em produção o prefixo `__Host-` faz o navegador exigir Secure, Path=/ e
 * nenhum Domain: outro host ou subdomínio não consegue plantar nem sobrescrever
 * a sessão. Fora de produção (http://localhost) o nome fica sem prefixo, que
 * aceita cookie sem Secure. Quem grava o cookie põe Secure sempre que
 * NODE_ENV=production.
 */
export const PRODUCTION_SESSION_COOKIE = "__Host-automabaca_session";
export const DEVELOPMENT_SESSION_COOKIE = "automabaca_session";
export const SESSION_COOKIE = process.env.NODE_ENV === "production"
  ? PRODUCTION_SESSION_COOKIE
  : DEVELOPMENT_SESSION_COOKIE;
/**
 * O nome que a sessão de produção tinha antes do `__Host-`: o login e o logout
 * o apagam para ele não sobrar no navegador. Null fora de produção, onde é o
 * próprio nome da sessão.
 */
export const LEGACY_SESSION_COOKIE: string | null =
  SESSION_COOKIE === DEVELOPMENT_SESSION_COOKIE ? null : DEVELOPMENT_SESSION_COOKIE;
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 dias
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } as const;
// Hash scrypt válido usado somente para igualar o custo de usuário inexistente.
const DUMMY_PASSWORD_HASH =
  "scrypt$automabaca-login-timing$671be651eca3eaf15c5e2c16ec720f01253428bd48edd9a0556b7522dc16702d";

/**
 * O sistema tem UM operador: toda sessão válida é o operador pleno. A terceira
 * parte do `AUTH_USERS` (formato legado `user:hash:admin`) é tolerada para não
 * invalidar configuração existente, mas é ignorada.
 */
export type AuthUser = { username: string; passwordHash: string };

export function parseAuthUsers(raw: string | undefined): AuthUser[] {
  if (!raw) return [];
  const users: AuthUser[] = [];
  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length < 2) continue;
    const [usernamePart, passwordHashPart] = parts;
    if (usernamePart === undefined || passwordHashPart === undefined) continue;
    const username = usernamePart.trim();
    // `\$` escapado no .env → `$` real.
    const passwordHash = passwordHashPart.trim().replace(/\\\$/g, "$");
    if (username && passwordHash) users.push({ username, passwordHash });
  }
  return users;
}

/**
 * Comparação de tempo constante para segredo. Compara os DIGESTS, não os bytes
 * crus: assim o tamanho da entrada não muda o caminho percorrido nem revela o
 * comprimento do segredo.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

// Assíncrono: roda no threadpool. O scryptSync parava o processo web inteiro
// (proxy e páginas do dono) por dezenas de ms a cada tentativa de login.
function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, SCRYPT_OPTIONS, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}

/** Verifica senha contra `scrypt$salt$hashhex`. */
export async function verifyPassword(candidate: string, stored: string): Promise<boolean> {
  const [scheme, salt, expectedHex] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expectedHex) return false;
  if (!/^[0-9a-f]+$/i.test(expectedHex) || expectedHex.length % 2 !== 0) return false;
  const derived = (await scryptAsync(candidate, salt, expectedHex.length / 2)).toString("hex");
  return constantTimeEqual(derived, expectedHex.toLowerCase());
}

export async function authenticate(
  username: string,
  password: string,
  users: AuthUser[],
): Promise<AuthUser | null> {
  const user = users.find((u) => u.username === username);
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  return user && valid ? user : null;
}

// ── Sessão: payload base64url + HMAC-SHA256 ──

// `r` (papel) some do payload novo; cookies antigos que ainda o trazem são
// aceitos e o campo é simplesmente ignorado. `p` é a impressão da senha.
type SessionPayload = { u: string; exp: number; e: number; p?: string; s?: string; t?: string };

export type VerifiedSession = {
  username: string;
  epoch: number;
  passwordFingerprint?: string;
  sessionId?: string;
  sessionToken?: string;
};

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** HMAC do hash vigente: o cookie é legível por quem o tem, o hash não pode ir nele. */
function passwordFingerprint(user: AuthUser, secret: string): string {
  return createHmac("sha256", secret).update(`pw:${user.passwordHash}`).digest("base64url").slice(0, 22);
}

/**
 * @param epoch — época vigente do usuário; toda sessão também precisa de
 * id+token de dispositivo.
 */
export function createSessionValue(
  user: AuthUser,
  secret: string,
  epoch: number,
  device?: { id: string; token: string },
): string {
  const payload: SessionPayload = {
    u: user.username,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S,
    e: epoch,
    p: passwordFingerprint(user, secret),
    ...(device ? { s: device.id, t: device.token } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * O usuário de AUTH_USERS dono da sessão, se a senha dele ainda é a que o
 * cookie viu no login. Trocar a senha é o que o dono faz quando ela vaza, e
 * isso tem de derrubar o cookie de quem entrou com ela.
 */
export function sessionUser(session: VerifiedSession, users: AuthUser[], secret: string): AuthUser | null {
  const user = users.find((u) => u.username === session.username);
  if (!user || !session.passwordFingerprint) return null;
  return constantTimeEqual(session.passwordFingerprint, passwordFingerprint(user, secret)) ? user : null;
}

export function verifySessionValue(
  value: string | undefined,
  secret: string,
): VerifiedSession | null {
  if (!value) return null;
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) return null;
  if (!constantTimeEqual(sign(encoded, secret), signature)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (!payload.u || payload.exp < Math.floor(Date.now() / 1000)) return null;
    // Sem época (cookie de formato antigo) → rejeita: força re-login uma vez.
    if (typeof payload.e !== "number" || !Number.isFinite(payload.e)) return null;
    if ((payload.s && !payload.t) || (payload.t && !payload.s)) return null;
    return {
      username: payload.u,
      epoch: payload.e,
      ...(typeof payload.p === "string" ? { passwordFingerprint: payload.p } : {}),
      ...(payload.s && payload.t ? { sessionId: payload.s, sessionToken: payload.t } : {}),
    };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_MAX_AGE_S,
} as const;
