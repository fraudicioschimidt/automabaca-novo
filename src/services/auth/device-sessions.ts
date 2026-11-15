import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/src/infra/prisma";
import { loginOrigin } from "@/src/services/auth/lockout";

export const DEVICE_SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
export const DEVICE_SESSION_IDLE_MAX_AGE_S = 7 * 24 * 60 * 60;
export const DEVICE_SESSION_LIST_LIMIT = 30;
const LAST_SEEN_WRITE_MS = 5 * 60_000;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// A rede, não o endereço: o IPv6 temporário muda todo dia dentro do mesmo /64.
function ipHash(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(ip ? loginOrigin(ip) : "unknown").digest("hex");
}

export function describeDevice(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? "Edge"
    : /Firefox\//.test(userAgent) ? "Firefox"
      : /Chrome\//.test(userAgent) ? "Chrome"
        : /Safari\//.test(userAgent) ? "Safari" : "Navegador";
  const os = /Windows/.test(userAgent) ? "Windows"
    : /Android/.test(userAgent) ? "Android"
      : /iPhone|iPad/.test(userAgent) ? "iOS"
        : /Mac OS/.test(userAgent) ? "macOS"
          : /Linux/.test(userAgent) ? "Linux" : "dispositivo desconhecido";
  // UA fora dos padrões conhecidos (curl, bot, script, vazio) colapsava tudo em
  // um rótulo idêntico, e a lista de dispositivos ficava com linhas
  // indistinguíveis — o operador não conseguia decidir qual sessão revogar.
  // Sufixo curto e determinístico do UA cru separa as linhas sem expor o UA.
  if (browser === "Navegador" && os === "dispositivo desconhecido") {
    const marca = createHash("sha256").update(userAgent || "vazio").digest("hex").slice(0, 6);
    return `Cliente desconhecido (${marca})`;
  }
  return `${browser} em ${os}`;
}

/**
 * `knownDevice`: o mesmo tipo de aparelho já entrou por esta rede (sessão
 * ativa, vencida ou encerrada pelo logout que a purga ainda guarda). Exige os
 * dois porque o navegador comum qualquer um imita; a rede do dono, não. A
 * sessão que o dono revogou em Config não conta: foi ele dizendo que aquele
 * acesso não era dele, e o próximo de lá avisa de novo.
 */
export async function createDeviceSession(params: {
  username: string;
  userAgent: string;
  ip: string;
  secret: string;
  now?: Date;
}): Promise<{ id: string; token: string; deviceName: string; knownDevice: boolean }> {
  const now = params.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  const deviceName = describeDevice(params.userAgent);
  const network = ipHash(params.ip, params.secret);
  const known = await prisma.authDeviceSession.findFirst({
    where: { username: params.username, deviceName, ipHash: network, revokedAt: null },
    select: { id: true },
  });
  const row = await prisma.authDeviceSession.create({
    data: {
      username: params.username,
      tokenHash: tokenHash(token),
      deviceName,
      userAgent: params.userAgent.slice(0, 500),
      ipHash: network,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + DEVICE_SESSION_MAX_AGE_S * 1000),
    },
  });
  return { id: row.id, token, deviceName, knownDevice: known !== null };
}

export async function validateDeviceSession(params: {
  id: string;
  token: string;
  username: string;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const row = await prisma.authDeviceSession.findUnique({ where: { id: params.id } });
  const idleCutoff = new Date(now.getTime() - DEVICE_SESSION_IDLE_MAX_AGE_S * 1000);
  if (
    !row
    || row.username !== params.username
    || row.revokedAt
    || row.expiresAt <= now
    || row.lastSeenAt <= idleCutoff
  ) return false;
  const expected = Buffer.from(row.tokenHash);
  const received = Buffer.from(tokenHash(params.token));
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
  if (now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_WRITE_MS) {
    await prisma.authDeviceSession.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { lastSeenAt: now },
    });
  }
  return true;
}

export async function listActiveDeviceSessions(username: string, currentSessionId?: string | null) {
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - DEVICE_SESSION_IDLE_MAX_AGE_S * 1000);
  const where = {
    username,
    revokedAt: null,
    expiresAt: { gt: now },
    lastSeenAt: { gt: idleCutoff },
  };
  const total = await prisma.authDeviceSession.count({ where });
  const recentRows = await prisma.authDeviceSession.findMany({
    where,
    orderBy: { lastSeenAt: "desc" },
    take: DEVICE_SESSION_LIST_LIMIT,
  });
  const currentRow = currentSessionId
    ? await prisma.authDeviceSession.findFirst({
        where: { ...where, id: currentSessionId },
      })
    : null;
  // A sessão atual pode ser mais antiga que as 30 recentes. Ela precisa
  // continuar visível para a tela não oferecer "revogar outras" sem deixar
  // claro qual dispositivo será preservado.
  const rows = currentRow && !recentRows.some((row) => row.id === currentRow.id)
    ? [currentRow, ...recentRows.slice(0, DEVICE_SESSION_LIST_LIMIT - 1)]
    : recentRows;
  return {
    total,
    sessions: rows.map((row) => ({
      id: row.id,
      deviceName: row.deviceName,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      current: row.id === currentSessionId,
    })),
  };
}

/**
 * Revoga uma sessão. Devolve `false` quando ela já não estava ativa — NÃO é
 * erro: revogar é idempotente, e o estado final desejado (sessão morta) já
 * existe. Lançar prenderia o operador: com a sessão revogada de outro
 * dispositivo, o logout falharia sem limpar o cookie. Quem precisa
 * distinguir "revoguei agora" de "já estava revogada" lê o retorno.
 */
export async function revokeDeviceSession(username: string, sessionId: string, actor: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.authDeviceSession.updateMany({
      where: { id: sessionId, username, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) return false;
    await tx.auditEvent.create({
      data: { actor, action: "auth.session_revoked", resource: "auth-session", resourceId: sessionId },
    });
    return true;
  });
}

/**
 * Logout: a sessão vence agora, sem a marca de revogada, para o aparelho
 * continuar conhecido no próximo login. Devolve `false` quando ela já não
 * estava ativa, como `revokeDeviceSession`.
 */
export async function endDeviceSession(username: string, sessionId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const result = await tx.authDeviceSession.updateMany({
      where: { id: sessionId, username, revokedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    if (result.count !== 1) return false;
    await tx.auditEvent.create({
      data: { actor: username, action: "auth.session_ended", resource: "auth-session", resourceId: sessionId },
    });
    return true;
  });
}

export async function revokeOtherDeviceSessions(username: string, currentSessionId: string, actor: string): Promise<number> {
  if (!currentSessionId.trim()) {
    throw new Error("Sessão atual inválida — faça login novamente.");
  }
  return prisma.$transaction(async (tx) => {
    const result = await tx.authDeviceSession.updateMany({
      where: { username, revokedAt: null, id: { not: currentSessionId } },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      await tx.auditEvent.create({
        data: { actor, action: "auth.sessions_revoked_other", resource: "auth-session", details: { count: result.count } },
      });
    }
    return result.count;
  });
}
