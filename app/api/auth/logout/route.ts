import { NextResponse, type NextRequest } from "next/server";
import {
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  verifySessionValue,
} from "@/src/infra/auth";
import { getEnv } from "@/src/infra/env";
import { endDeviceSession } from "@/src/services/auth/device-sessions";
import { createLogger } from "@/src/infra/logger";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { privacyHash } from "@/src/infra/privacy";
import { observedRoute } from "@/src/services/ops/http-telemetry";
import { hasTrustedRequestOrigin } from "@/src/infra/http-request";

const log = createLogger("auth-logout");

/**
 * Logout: encerra a sessão deste dispositivo no Postgres (cookie roubado deixa
 * de valer) e limpa o cookie com os mesmos atributos do login, junto com o do
 * nome anterior ao `__Host-`. Sessão sem dispositivo (formato antigo) só é
 * removida localmente, sem derrubar as sessões modernas do mesmo usuário pela
 * época global.
 */
async function handlePost(request: NextRequest): Promise<NextResponse> {
  if (!hasTrustedRequestOrigin(request)) {
    return NextResponse.json({ error: "Origem da requisição não permitida." }, { status: 403 });
  }
  const env = getEnv();
  const secret = env.AUTH_SESSION_SECRET;
  if (secret) {
    const raw = request.cookies.get(SESSION_COOKIE)?.value;
    const session = verifySessionValue(raw, secret);
    if (session) {
      try {
        if (session.sessionId && session.sessionToken) {
          // `false` = já estava encerrada (outro dispositivo a revogou antes).
          // É o estado final que o logout quer: segue e limpa o cookie. Tratar
          // isso como erro devolvia 503 sem limpar nada, e o operador ficava
          // preso com um cookie que o proxy recusa e o logout não apaga.
          await endDeviceSession(session.username, session.sessionId);
        }
      } catch (error) {
        log.error(
          { err: error, usernameHash: privacyHash(session.username, "username") },
          "falha ao encerrar sessão no logout",
        );
        sendOperationalAlert("🔐 Saída do painel não encerrou a sessão\nA sessão pode continuar válida no aparelho.\n👉 Saia de novo, ou revogue a sessão em Config › Segurança da conta.", {
          source: "auth-logout",
          key: "session-revocation-failed",
          title: "Falha na revogação de sessão",
          resource: "auth-session",
        }).catch((alertError) => log.warn({ err: alertError }, "falha ao emitir alerta de logout"));
        return NextResponse.json(
          { ok: false, error: "Não foi possível encerrar a sessão com segurança. Tente novamente." },
          { status: 503 },
        );
      }
    }
  }

  const isHttps =
    env.NODE_ENV === "production" ||
    request.headers.get("x-forwarded-proto") === "https" ||
    request.nextUrl.protocol === "https:";

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    ...SESSION_COOKIE_OPTIONS,
    secure: isHttps,
    maxAge: 0,
  });
  if (LEGACY_SESSION_COOKIE) {
    response.cookies.set(LEGACY_SESSION_COOKIE, "", { ...SESSION_COOKIE_OPTIONS, secure: isHttps, maxAge: 0 });
  }
  return response;
}

export const POST = observedRoute("/api/auth/logout", handlePost);
