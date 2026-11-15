/** Shared allowlist: browser reports never carry free text, query strings or DOM content. */
export const BROWSER_ERROR_KINDS = ["runtime", "unhandled_rejection", "boundary", "resource"] as const;
export type BrowserErrorKind = typeof BROWSER_ERROR_KINDS[number];
export const BROWSER_ERROR_REASONS = ["chunk_load", "hydration", "network", "undefined_access", "syntax", "resource_load", "unknown"] as const;
export type BrowserErrorReason = typeof BROWSER_ERROR_REASONS[number];

export function telemetryRoute(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  if (/^\/tipsters\/[^/]+\/analyzer\/?$/.test(pathname)) return "/tipsters/[slug]/analyzer";
  if (/^\/tipsters\/[^/]+\/?$/.test(pathname)) return "/tipsters/[slug]";
  if (/^\/api\/logos\/[^/]+$/.test(pathname)) return "/api/logos/[file]";
  if (/^\/(login|tipsters|aposta|contas|players|config|operacoes|analyzer|historico|relatorios)?\/?$/.test(pathname)) return pathname.replace(/\/$/, "") || "/";
  return "/other";
}

export function browserErrorReason(message: string): BrowserErrorReason {
  if (/chunk|loading.*module|dynamically imported module/i.test(message)) return "chunk_load";
  if (/hydration|hydrating|minified react error #(418|423|425)/i.test(message)) return "hydration";
  if (/failed to fetch|networkerror|network request|load failed/i.test(message)) return "network";
  if (/undefined|null|cannot read propert/i.test(message)) return "undefined_access";
  if (/syntax|unexpected token/i.test(message)) return "syntax";
  return "unknown";
}

export function telemetryAsset(path: string): string | undefined {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  if (/^\/_next\/static\/(?:chunks|[^/]+)\/[a-zA-Z0-9_.-]{1,160}\.(?:js|css)$/.test(pathname)) return pathname;
  if (pathname.startsWith("/fonts/")) return "/fonts/[font]";
  if (pathname.startsWith("/api/logos/")) return "/api/logos/[file]";
  return undefined;
}

export type BrowserErrorReport = {
  version: 1;
  kind: BrowserErrorKind;
  reason: BrowserErrorReason;
  route: string;
  clientRelease: string;
  pageCorrelationId?: string;
  digest?: string;
  asset?: string;
  frames: Array<{ asset: string; line: number; column: number }>;
};

export function sanitizeBrowserReport(value: unknown): BrowserErrorReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !BROWSER_ERROR_KINDS.includes(v.kind as BrowserErrorKind)
    || !BROWSER_ERROR_REASONS.includes(v.reason as BrowserErrorReason) || typeof v.route !== "string"
    || v.route.length > 1_024 || typeof v.clientRelease !== "string"
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(v.clientRelease)) return null;
  const frames = (Array.isArray(v.frames) ? v.frames : []).slice(0, 5).flatMap((frame: unknown) => {
    if (!frame || typeof frame !== "object") return [];
    const f = frame as Record<string, unknown>;
    const asset = typeof f.asset === "string" ? telemetryAsset(f.asset) : undefined;
    if (!asset || !Number.isSafeInteger(f.line) || !Number.isSafeInteger(f.column)
      || Number(f.line) < 0 || Number(f.line) > 10_000_000 || Number(f.column) < 0 || Number(f.column) > 10_000_000) return [];
    return [{ asset, line: Number(f.line), column: Number(f.column) }];
  });
  return {
    version: 1, kind: v.kind as BrowserErrorKind, reason: v.reason as BrowserErrorReason,
    route: telemetryRoute(v.route), clientRelease: v.clientRelease, frames,
    ...(typeof v.pageCorrelationId === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(v.pageCorrelationId) ? { pageCorrelationId: v.pageCorrelationId } : {}),
    ...(typeof v.digest === "string" && /^[0-9a-f]{1,64}$/i.test(v.digest) ? { digest: v.digest } : {}),
    ...(typeof v.asset === "string" && telemetryAsset(v.asset) ? { asset: telemetryAsset(v.asset) } : {}),
  };
}
