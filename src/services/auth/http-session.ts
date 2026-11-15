import type { NextRequest, NextResponse } from "next/server";
import type { AuthUser } from "@/src/infra/auth";
import {
  createSessionValue,
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "@/src/infra/auth";
import { formatSpDateTime } from "@/src/domain/dates";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { createDeviceSession } from "@/src/services/auth/device-sessions";
import { garantirEpochSessao } from "@/src/services/auth/session-epoch";
import { clientIpFromHeaders } from "@/src/services/auth/lockout";
import { sendOperationalAlert } from "@/src/services/ops/alerts";

const log = createLogger("auth");

/** Aplica a mesma sessão durável a todos os métodos de autenticação. */
export async function attachAuthenticatedSession(
  request: NextRequest,
  response: NextResponse,
  user: AuthUser,
): Promise<void> {
  const env = getEnv();
  const secret = env.AUTH_SESSION_SECRET;
  if (!secret) throw new Error("AUTH_SESSION_SECRET não configurado.");

  // Inicialização atômica: dois primeiros logins não podem rotacionar a época
  // um do outro.
  const epoch = await garantirEpochSessao(user.username);
  const device = await createDeviceSession({
    username: user.username,
    userAgent: request.headers.get("user-agent") ?? "",
    ip: clientIpFromHeaders(request.headers),
    secret,
  });
  const isHttps =
    env.NODE_ENV === "production" ||
    request.headers.get("x-forwarded-proto") === "https" ||
    request.nextUrl.protocol === "https:";
  response.cookies.set(SESSION_COOKIE, createSessionValue(user, secret, epoch, device), {
    ...SESSION_COOKIE_OPTIONS,
    secure: isHttps,
  });
  if (LEGACY_SESSION_COOKIE) {
    response.cookies.set(LEGACY_SESSION_COOKIE, "", { ...SESSION_COOKIE_OPTIONS, secure: isHttps, maxAge: 0 });
  }
  // O painel não tem segundo fator: com a senha vazada, este aviso é o que
  // conta ao dono que alguém entrou. Não segura nem derruba o login.
  if (!device.knownDevice) {
    sendOperationalAlert(
      `🔐 Novo acesso ao painel: ${device.deviceName}, ${formatSpDateTime(new Date())}\n`
        + "Aparelho ou rede que o painel ainda não tinha visto.\n"
        + "👉 Se não foi você: revogue a sessão em Config › Segurança da conta e troque a senha.",
      {
        source: "auth-login",
        key: `new-device:${device.id}`,
        title: "Novo acesso ao painel",
        resource: "auth-session",
        resourceId: device.id,
      },
    ).catch((error) => log.warn({ err: error }, "falha ao avisar acesso novo ao painel"));
  }
}
