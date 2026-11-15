import { NextResponse, type NextRequest } from "next/server";
import { safeReturnPath } from "@/src/domain/safe-return-path";
import { parseAuthUsers, SESSION_COOKIE, sessionUser, verifySessionValue } from "@/src/infra/auth";
import { epochSessaoAtual } from "@/src/services/auth/session-epoch";
import { validateDeviceSession } from "@/src/services/auth/device-sessions";

/**
 * Guarda de autenticação do painel: sessão por cookie (HMAC). Tudo é protegido
 * exceto login, health, webhook autenticado pelo Telegram e estáticos. Sem
 * AUTH_USERS configurado em produção → 500 explícito (nunca aberto por omissão).
 * Basic Auth foi removido (auditoria 2026-06-14):
 * burlava o lockout de força-bruta do /login.
 *
 * Após HMAC válido, confere a época e a sessão de dispositivo no Postgres.
 * Cookies legados sem id+token de dispositivo são rejeitados.
 */

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  // Logout precisa alcançar o handler mesmo com cookie inválido/revogado: a
  // própria rota valida a origem, tolera sessão ausente e expira o cookie.
  "/api/auth/logout",
  "/api/health",
  // Public so login/rendering failures can be reported; the endpoint applies
  // strict origin, payload and rate limits independently of session storage.
  "/api/telemetry/browser",
  "/api/health/observability",
  "/robots.txt",
  // A rota aplica timingSafeEqual ao segredo enviado pelo Telegram. O proxy não
  // pode exigir cookie de painel de um serviço externo sem sessão.
  "/api/telegram/webhook",
]);
const PWA_PUBLIC_ASSETS = new Set([
  "/icon.svg",
  "/manifest.webmanifest",
  "/sw.js",
  "/pwa-icon-192.png",
  "/pwa-icon-512.png",
  "/pwa-icon-maskable-512.png",
]);

/**
 * CSP estrita por requisição. O Next reconhece o nonce no header recebido e o
 * propaga automaticamente para scripts e estilos que ele próprio renderiza.
 */
export function buildContentSecurityPolicy(nonce: string, isDev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // O front Refino calcula layout por React style props. CSP não aceita nonce
    // em atributos style; isolamos a exceção só neles, sem abrir scripts nem
    // blocos <style> arbitrários.
    "style-src-attr 'unsafe-inline'",
    // `data:` fora: nenhum componente do projeto usa data-URI em <img> (grep
    // limpo), e `data:` em img-src é o vetor padrão para exfiltrar/exibir
    // conteúdo de uma injeção sem precisar de origem de rede (auditoria 008 #15).
    // `blob:` fica — é o preview de upload de logo.
    "img-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

function requestHeaders(request: NextRequest, nonce: string): Headers {
  const headers = new Headers(request.headers);
  // `x-auth-*` é produzido AQUI e em nenhum outro lugar. Sem esta limpeza a
  // cópia acima carregava o valor que o cliente mandou: o nginx repassa headers
  // do cliente e só o ramo autenticado fazia `set()` por cima. Os ramos que
  // encaminham sem autenticar (estático, rota pública) entregavam ao handler um
  // `x-auth-user` escolhido por quem chamou. Hoje nenhum deles lê o header, o
  // que torna isto contenção por acaso — e um handler novo transformaria em
  // bypass. Apagar na entrada faz o header ser inforjável por construção.
  headers.delete("x-auth-user");
  headers.delete("x-auth-session-id");
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", buildContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  ));
  return headers;
}

function withCsp(response: NextResponse, csp: string, correlationId: string): NextResponse {
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-correlation-id", correlationId);
  return response;
}

function isStatic(pathname: string): boolean {
  // Só assets do framework (o matcher já exclui /_next/static e a favicon) +
  // /fonts/ (Geist auto-hospedada): precisa carregar SEM auth, senão a página de
  // login cai no fallback Segoe UI.
  // O prefixo `/fonts/` era descrito como "inócuo (só .woff2)" por INSPEÇÃO da
  // pasta, não por regra: qualquer arquivo que caísse ali depois passaria a ser
  // servido sem sessão. Prefixo E sufixo juntos fazem a promessa virar código.
  // NÃO liberar por sufixo de extensão SOZINHO (.js/.css/.png…): o matcher cobre
  // rotas dinâmicas (/tipsters/[slug]), então um sufixo solto pulava a auth.
  return (
    pathname.startsWith("/_next/") ||
    (pathname.startsWith("/fonts/") && pathname.endsWith(".woff2")) ||
    pathname === "/favicon.ico" ||
    PWA_PUBLIC_ASSETS.has(pathname)
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const correlationId = crypto.randomUUID();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const forwardedHeaders = requestHeaders(request, nonce);
  forwardedHeaders.set("x-correlation-id", correlationId);
  const csp = forwardedHeaders.get("Content-Security-Policy")
    ?? buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  // Next 16 server references contain 42 characters. Reject malformed action
  // headers at the boundary, including on public pages such as /login.
  const actionId = request.headers.get("next-action");
  if (request.method === "POST" && actionId !== null && actionId.length !== 42) {
    return withCsp(NextResponse.json(
      { error: "Referência de ação inválida." }, { status: 400 },
    ), csp, correlationId);
  }
  if (isStatic(pathname) || PUBLIC_PATHS.has(pathname)) {
    return withCsp(
      NextResponse.next({ request: { headers: forwardedHeaders } }),
      csp,
      correlationId,
    );
  }

  const users = parseAuthUsers(process.env.AUTH_USERS);
  const secret = process.env.AUTH_SESSION_SECRET;
  if (users.length === 0 || !secret) {
    return withCsp(new NextResponse(
      "Configure AUTH_USERS e AUTH_SESSION_SECRET para habilitar o painel.",
      { status: 500 },
    ), csp, correlationId);
  }

  const session = verifySessionValue(request.cookies.get(SESSION_COOKIE)?.value, secret);
  if (session) {
    // Fail-closed: usuário do cookie precisa existir em AUTH_USERS com a mesma senha.
    const known = sessionUser(session, users, secret);
    if (!known) {
      // cookie órfão — cai no redirect/401 abaixo
    } else {
      // As duas leituras são independentes. Mantêm a revogação fail-closed,
      // mas pagam um único RTT lógico no caminho de toda request autenticada.
      const [epochAtual, deviceValid] = await Promise.all([
        epochSessaoAtual(session.username),
        session.sessionId && session.sessionToken
          ? validateDeviceSession({
              id: session.sessionId,
              token: session.sessionToken,
              username: session.username,
            })
          : Promise.resolve(false),
      ]);
      // Fail-closed: sem época no banco → rejeita (força re-login). Login sempre
      // emite época; cookie com época antiga também é rejeitado.
      if (epochAtual !== null && session.epoch === epochAtual && deviceValid) {
        forwardedHeaders.set("x-auth-user", known.username);
        if (session.sessionId) forwardedHeaders.set("x-auth-session-id", session.sessionId);
        return withCsp(
          NextResponse.next({ request: { headers: forwardedHeaders } }),
          csp,
          correlationId,
        );
      }
    }
  }

  if (pathname.startsWith("/api/")) {
    return withCsp(
      NextResponse.json({ error: "Autenticação necessária." }, { status: 401 }),
      csp,
      correlationId,
    );
  }
  // Server action sem sessão: o cliente do Next só mostra o texto de uma
  // resposta 4xx `text/plain` (exatamente esse tipo); o redirect para o login
  // chegaria à tela como "An unexpected response was received from the server".
  if (request.method === "POST" && actionId !== null) {
    return withCsp(
      new NextResponse("Sessão expirada — faça login novamente.", { status: 401, headers: { "content-type": "text/plain" } }),
      csp,
      correlationId,
    );
  }
  const loginUrl = new URL("/login", request.url);
  const next = `${pathname}${request.nextUrl.search}`;
  const returnPath = safeReturnPath(next);
  if (returnPath) loginUrl.searchParams.set("next", returnPath);
  return withCsp(NextResponse.redirect(loginUrl), csp, correlationId);
}

// Proxy roda sempre em Node.js no Next 16 — declarar runtime é proibido aqui.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
