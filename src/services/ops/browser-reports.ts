import { sanitizeBrowserReport } from "@/src/domain/browser-telemetry";
import { allowBrowserReport } from "@/src/infra/browser-report-budget";
import { clientIpFromHeaders, hasTrustedRequestOrigin, readJsonBodyWithin } from "@/src/infra/http-request";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";

const log = createLogger("browser");
const MAX_BYTES = 8_192;

export async function receiveBrowserReport(request: Request): Promise<Response> {
  // Require Origin specifically; same-site subdomains are insufficient here.
  if (!request.headers.get("origin") || !hasTrustedRequestOrigin(request)) return new Response(null, { status: 403 });
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return new Response(null, { status: 415 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return new Response(null, { status: 413 });
  const address = clientIpFromHeaders(request.headers) || "unknown";
  if (!allowBrowserReport(address)) return new Response(null, { status: 429, headers: { "retry-after": "60" } });
  const body = await readJsonBodyWithin(request, MAX_BYTES, { timeoutMs: 5_000 });
  if (!body.ok) return new Response(null, { status: body.reason === "too_large" ? 413 : 400 });
  const report = sanitizeBrowserReport(body.value);
  if (!report) return new Response(null, { status: 400 });
  const resource = report.kind === "resource";
  log[resource ? "warn" : "error"]({
    eventCode: resource ? LOG_EVENTS.BROWSER_RESOURCE_FAILED : LOG_EVENTS.BROWSER_ERROR_REPORTED,
    clientReport: report,
  }, resource ? "navegador reportou falha de recurso" : "navegador reportou falha de execução");
  return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
}
