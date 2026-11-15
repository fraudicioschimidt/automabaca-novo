import { isIP } from "node:net";
import type { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { privacyHash } from "@/src/infra/privacy";

/**
 * Lockout de login por usuário+IP, usuário e origem.
 * Estado no Postgres reaproveitando o `AuditEvent` — sem tabela nova. O freio
 * em memória (`enterLoginAttempt`) só recusa antes do banco; nunca libera o
 * que a contagem daqui bloqueia.
 *
 * Janela deslizante: ≥ MAX_TENTATIVAS falhas em JANELA_MS para o par
 * (username, IP). Sem IP confiável, cai para só-por-usuário. Um login OK
 * zera a contagem daquele par, mas não o orçamento total da origem.
 * Não é OR username|IP: isso deixaria qualquer IP bloquear uma conta de
 * username conhecido.
 */

export const MAX_TENTATIVAS = 10;
export const JANELA_MS = 15 * 60_000;
/**
 * Teto GLOBAL por username, independente do IP: o escopo por par (username,
 * IP) deixa brute-force distribuído ilimitado — 10 tentativas × N proxies.
 * O teto é alto para não reabrir o DoS barato de conta (10 falhas de qualquer
 * lugar); 100/15min não bloqueia uso legítimo e limita a taxa agregada de
 * adivinhação.
 */
export const MAX_TENTATIVAS_USERNAME = 100;
// Limita o custo total do scrypt mesmo quando a origem troca de username.
// O teto do par continua menor; outra origem não bloqueia a conta inteira.
export const MAX_TENTATIVAS_IP = 100;

const ACAO_FALHA = "auth.login_failed";
const ACAO_OK = "auth.login_ok";
const ACAO_CLAIM = "auth.login_claimed";

type AuditClient = Pick<Prisma.TransactionClient, "auditEvent">;

/**
 * O username vem do formulário, antes de qualquer autenticação: pode ser a
 * senha digitada no campo errado ou texto de um anônimo. Na trilha fica só o
 * hash (o mesmo `usernameHash` dos logs do login), e é por ele que o lockout
 * conta as tentativas.
 */
export function loginAuditActor(username: string): string {
  return `login:${privacyHash(username, "username")}`;
}

/** Os 64 bits de rede de um IPv6, expandidos; `null` se o texto não for IPv6. */
function ipv6NetworkGroups(ip: string): string[] | null {
  const address = ip.split("%")[0]!.toLowerCase();
  if (isIP(address) !== 6) return null;
  let text = address;
  const embeddedIpv4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (embeddedIpv4) {
    const [a, b, c, d] = embeddedIpv4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, embeddedIpv4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array<string>(8 - headGroups.length - tailGroups.length).fill("0");
  return [...headGroups, ...fill, ...tailGroups].map((group) => parseInt(group, 16).toString(16));
}

/**
 * Origem do login, em texto. Um cliente IPv6 comum controla o /64 inteiro e
 * troca de endereço a cada tentativa: sem agrupar, cada endereço teria
 * orçamento próprio e bastaria para esgotar o teto global do username do dono.
 * IPv4 mapeado em IPv6 conta como o próprio IPv4.
 */
export function loginOrigin(ip: string): string {
  const groups = ipv6NetworkGroups(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff") {
    const [high, low] = [parseInt(groups[6]!, 16), parseInt(groups[7]!, 16)];
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

export function loginOriginHash(ip: string): string {
  return privacyHash(loginOrigin(ip), "ip");
}

/** Escopo do lockout: par (username, ip) quando há IP; só username se IP vazio. */
function alvo(actor: string, ip: string): Prisma.AuditEventWhereInput {
  if (!ip) return { actor };
  return {
    AND: [
      { actor },
      { details: { path: ["ipHash"], equals: loginOriginHash(ip) } },
    ],
  };
}

async function escopoBloqueado(params: {
  client: AuditClient;
  where: Prisma.AuditEventWhereInput;
  teto: number;
  piso: Date;
}): Promise<boolean> {
  const ultimoOk = await params.client.auditEvent.findFirst({
    where: { action: ACAO_OK, ...params.where },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const desde = ultimoOk && ultimoOk.createdAt > params.piso
    ? ultimoOk.createdAt
    : params.piso;
  const tentativas = await params.client.auditEvent.count({
    where: {
      action: { in: [ACAO_FALHA, ACAO_CLAIM] },
      createdAt: { gte: desde },
      ...params.where,
    },
  });
  return tentativas >= params.teto;
}

/** Logins ao mesmo tempo no processo: cada um segura uma conexão do pool e um scrypt. */
export const LOGIN_IN_FLIGHT_MAX = 2;
/** Tentativas por origem por minuto antes de chegar ao banco (o teto de 15 min continua lá). */
export const LOGIN_ORIGIN_MAX_PER_MINUTE = 10;
const LOGIN_ORIGIN_WINDOW_MS = 60_000;
const LOGIN_ORIGINS_TRACKED_MAX = 1_000;

type LoginGate = { inFlight: number; origins: Map<string, { startedAt: number; count: number }> };
const shared = globalThis as typeof globalThis & { __automabacaLoginGate?: LoginGate };

/**
 * Freio do processo web antes do claim. O claim segura uma conexão do pool
 * esperando os advisory locks, e só depois recusa a origem bloqueada: uma
 * rajada anônima enchia o pool, e as páginas do dono (que leem a sessão no
 * mesmo pool) paravam. Devolve a liberação da vaga, ou null para responder 429.
 */
export function enterLoginAttempt(ip: string, now = Date.now()): (() => void) | null {
  const gate = shared.__automabacaLoginGate ??= { inFlight: 0, origins: new Map() };
  for (const [key, window] of gate.origins) {
    if (now - window.startedAt >= LOGIN_ORIGIN_WINDOW_MS) gate.origins.delete(key);
  }
  const key = loginOriginHash(ip);
  const window = gate.origins.get(key) ?? { startedAt: now, count: 0 };
  if (
    gate.inFlight >= LOGIN_IN_FLIGHT_MAX
    || window.count >= LOGIN_ORIGIN_MAX_PER_MINUTE
    || (!gate.origins.has(key) && gate.origins.size >= LOGIN_ORIGINS_TRACKED_MAX)
  ) return null;
  window.count += 1;
  gate.origins.set(key, window);
  gate.inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate.inFlight -= 1;
  };
}

export type LoginAttemptClaim =
  | { allowed: true; claimId: string }
  | { allowed: false };

async function origemBloqueada(client: AuditClient, ip: string, piso: Date): Promise<boolean> {
  if (!ip) return false;
  const tentativas = await client.auditEvent.count({
    where: {
      resource: "auth",
      action: { in: [ACAO_FALHA, ACAO_CLAIM, ACAO_OK] },
      createdAt: { gte: piso },
      details: { path: ["ipHash"], equals: loginOriginHash(ip) },
    },
  });
  // Sucesso também consumiu trabalho: não pode zerar o orçamento da origem.
  return tentativas >= MAX_TENTATIVAS_IP;
}

/**
 * Reserva atomicamente uma tentativa ANTES do scrypt. O lock por username
 * serializa IPs diferentes; o lock por origem serializa usernames diferentes.
 * Claim órfão continua contando na janela: crash não pode liberar força-bruta.
 */
export async function claimLoginAttempt(params: {
  username: string;
  ip: string;
  now?: Date;
}): Promise<LoginAttemptClaim> {
  const now = params.now ?? new Date();
  const piso = new Date(now.getTime() - JANELA_MS);
  const actor = loginAuditActor(params.username);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-${actor}`}, 0))`;
    if (params.ip) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-login-ip:${loginOriginHash(params.ip)}`}, 0))`;
      if (await origemBloqueada(tx, params.ip, piso)) return { allowed: false };
    }
    if (await escopoBloqueado({
      client: tx,
      where: alvo(actor, params.ip),
      teto: MAX_TENTATIVAS,
      piso,
    })) return { allowed: false };
    if (params.ip && await escopoBloqueado({
      client: tx,
      where: { actor },
      teto: MAX_TENTATIVAS_USERNAME,
      piso,
    })) return { allowed: false };
    const claim = await tx.auditEvent.create({
      data: {
        actor,
        action: ACAO_CLAIM,
        resource: "auth",
        outcome: "pending",
        details: {
          ipHash: params.ip ? loginOriginHash(params.ip) : null,
        } satisfies Prisma.InputJsonValue,
        createdAt: now,
      },
      select: { id: true },
    });
    return { allowed: true, claimId: claim.id };
  }, { timeout: 15_000 });
}

/** Classifica exatamente o claim reservado; não cria uma segunda contagem. */
export async function completeLoginAttempt(params: {
  claimId: string;
  username: string;
  success: boolean;
}): Promise<void> {
  const updated = await prisma.auditEvent.updateMany({
    where: {
      id: params.claimId,
      actor: loginAuditActor(params.username),
      action: ACAO_CLAIM,
      outcome: "pending",
    },
    data: {
      action: params.success ? ACAO_OK : ACAO_FALHA,
      outcome: params.success ? "success" : "failure",
    },
  });
  if (updated.count !== 1) {
    throw new Error("Claim de login ausente ou já classificado.");
  }
}

/**
 * O web recebe conexões somente do proxy confiável, pela porta local Docker.
 * Caddy escreve X-Forwarded-For e repassa X-Real-IP sem sanitizar; este último
 * não identifica o cliente. Em cadeias appendadas, usamos o último elemento.
 * Sem IP válido a rota de login recusa a requisição.
 */
export { clientIpFromHeaders } from "@/src/infra/http-request";
