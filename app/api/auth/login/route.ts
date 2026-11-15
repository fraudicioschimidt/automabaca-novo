import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  authenticate,
  parseAuthUsers,
} from "@/src/infra/auth";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { privacyHash } from "@/src/infra/privacy";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { hasTrustedRequestOrigin, readJsonBodyWithin } from "@/src/infra/http-request";
import {
  clientIpFromHeaders,
  claimLoginAttempt,
  completeLoginAttempt,
  enterLoginAttempt,
} from "@/src/services/auth/lockout";
import { attachAuthenticatedSession } from "@/src/services/auth/http-session";
import { observedRoute } from "@/src/services/ops/http-telemetry";

const log = createLogger("auth");
const MAX_AUTH_BODY_BYTES = 64 * 1024;

const bodySchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

async function handlePost(request: NextRequest): Promise<NextResponse> {
  if (!hasTrustedRequestOrigin(request)) {
    return NextResponse.json({ error: "Origem da requisição não permitida." }, { status: 403 });
  }
  const body = await readJsonBodyWithin(request, MAX_AUTH_BODY_BYTES);
  if (!body.ok && body.reason === "too_large") {
    return NextResponse.json({ error: "Payload grande demais." }, { status: 413 });
  }
  const parsed = bodySchema.safeParse(body.ok ? body.value : null);
  if (!parsed.success) {
    return NextResponse.json({ error: "Informe usuário e senha." }, { status: 400 });
  }

  const env = getEnv();
  const users = parseAuthUsers(env.AUTH_USERS);
  const secret = env.AUTH_SESSION_SECRET;
  if (users.length === 0 || !secret) {
    return NextResponse.json({ error: "Autenticação não configurada." }, { status: 500 });
  }

  const username = parsed.data.username;
  const ip = clientIpFromHeaders(request.headers);
  if (!ip) {
    log.error(
      { eventCode: LOG_EVENTS.AUTH_LOGIN_REJECTED, usernameHash: privacyHash(username, "username") },
      "login recusado — proxy não forneceu IP confiável",
    );
    return NextResponse.json({ error: "Origem da conexão não identificada." }, { status: 503 });
  }
  const authLog = {
    eventCode: LOG_EVENTS.AUTH_LOGIN_REJECTED,
    usernameHash: privacyHash(username, "username"),
    ipHash: privacyHash(ip, "ip"),
  };
  const tooManyAttempts = () => NextResponse.json(
    { error: "Muitas tentativas de login. Tente novamente em alguns minutos." },
    { status: 429 },
  );

  const release = enterLoginAttempt(ip);
  if (!release) {
    log.warn(authLog, "login recusado — rajada barrada antes do banco");
    return tooManyAttempts();
  }
  try {
    // O claim atômico conta a tentativa ANTES do scrypt e serializa o teto entre
    // processos/IPs; o check-then-record anterior deixava bursts atravessarem.
    const claim = await claimLoginAttempt({ username, ip });
    if (!claim.allowed) {
      log.warn(authLog, "login bloqueado — muitas tentativas (lockout)");
      return tooManyAttempts();
    }

    let user: Awaited<ReturnType<typeof authenticate>>;
    try {
      user = await authenticate(username, parsed.data.password, users);
    } catch (error) {
      await completeLoginAttempt({ claimId: claim.claimId, username, success: false });
      throw error;
    }
    if (!user) {
      await completeLoginAttempt({ claimId: claim.claimId, username, success: false });
      log.warn(authLog, "login recusado");
      return NextResponse.json({ error: "Usuário ou senha inválidos." }, { status: 401 });
    }

    await completeLoginAttempt({ claimId: claim.claimId, username, success: true });
    const response = NextResponse.json({ ok: true });
    await attachAuthenticatedSession(request, response, user);
    return response;
  } finally {
    release();
  }
}

export const POST = observedRoute("/api/auth/login", handlePost);
