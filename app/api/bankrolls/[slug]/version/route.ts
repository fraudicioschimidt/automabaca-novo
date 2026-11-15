import { MAX_BANKROLL_SLUG_INPUT_LENGTH } from "@/src/domain/bankroll-identity";
import { canManage } from "@/app/(painel)/_auth";
import { getBankrollVersion } from "@/src/services/painel/queries/bankrolls";
import { hasTrustedRequestOrigin, readJsonBodyWithin } from "@/src/infra/http-request";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { observedRoute } from "@/src/services/ops/http-telemetry";

export const dynamic = "force-dynamic";
async function handleGet(_request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store" };
  if (!await canManage()) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  const { slug } = await context.params;
  if (slug.length > MAX_BANKROLL_SLUG_INPUT_LENGTH || !/^[a-zA-Z0-9_-]+$/.test(slug)) return Response.json({ error: "invalid_slug" }, { status: 400, headers });
  const version = await getBankrollVersion(slug);
  return Response.json({ version }, { status: version ? 200 : 404, headers });
}

/** Uma amostra por atualização efetivamente recebida, sem conteúdo da aposta. */
async function handlePost(request: Request): Promise<Response> {
  if (!hasTrustedRequestOrigin(request) || !await canManage()) return new Response(null, { status: 403 });
  // Lê o stream com teto: sem Content-Length, request.text() consumiria tudo.
  const read = await readJsonBodyWithin(request, 512);
  if (!read.ok) return new Response(null, { status: read.reason === "too_large" ? 413 : 400 });
  const body = read.value;
  if (!body || typeof body !== "object" || !("durationMs" in body) || typeof body.durationMs !== "number" ||
    !Number.isFinite(body.durationMs) || body.durationMs < 0 || body.durationMs > 60_000) return new Response(null, { status: 400 });
  await recordOperationalMetric({ kind: "action", name: "sharp.browser.refresh", outcome: "success", durationMs: body.durationMs,
    labels: { measurement: "change_detected_to_props", pollIntervalMs: 5000 } });
  return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
}

// Polling a cada 5s: sucesso fica no acesso Caddy; falhas continuam no logger
// e nas métricas. O POST já registra a duração funcional da atualização.
export const GET = observedRoute("/api/bankrolls/[slug]/version", handleGet, { metric: "errors" });
export const POST = observedRoute("/api/bankrolls/[slug]/version", handlePost, { metric: "errors" });
