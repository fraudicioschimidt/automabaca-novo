"use client";

import { browserErrorReason, sanitizeBrowserReport, telemetryAsset, type BrowserErrorKind } from "@/src/domain/browser-telemetry";

let context: { clientRelease: string; pageCorrelationId?: string } | undefined;
const pending: Array<{ kind: BrowserErrorKind; error: unknown }> = [];
const seen = new Map<string, number>();
let windowStart = 0;
let sent = 0;

export function configureBrowserTelemetry(value: typeof context): void {
  context = value;
  if (context) for (const entry of pending.splice(0)) reportBrowserError(entry.kind, entry.error);
}

function ownAsset(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin ? telemetryAsset(url.pathname) : undefined;
  } catch { return undefined; }
}

export function reportBrowserError(kind: BrowserErrorKind, error: unknown, resource?: string): void {
  if (typeof window === "undefined") return;
  if (!context) {
    if (pending.length < 5) pending.push({ kind, error });
    return;
  }
  try {
    const e = error instanceof Error ? error : undefined;
    const frames = (e?.stack ?? "").split("\n").slice(0, 12).flatMap((line) => {
      const match = line.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
      const asset = match?.[1] ? ownAsset(match[1]) : undefined;
      return asset && match ? [{ asset, line: Number(match[2]), column: Number(match[3]) }] : [];
    }).slice(0, 5);
    const report = sanitizeBrowserReport({
      version: 1, kind, reason: kind === "resource" ? "resource_load" : browserErrorReason(e?.message ?? ""),
      route: window.location.pathname, ...context,
      digest: e && "digest" in e ? e.digest : undefined,
      asset: resource ? ownAsset(resource) : undefined, frames,
    });
    if (!report) return;
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; sent = 0; }
    for (const [key, at] of seen) if (now - at >= 300_000) seen.delete(key);
    const key = JSON.stringify(report);
    if (seen.has(key) || sent >= 5 || seen.size >= 100) return;
    seen.set(key, now); sent += 1;
    // Deliberately no retry: a failed collector must not create an error loop.
    fetch("/api/telemetry/browser", {
      method: "POST", headers: { "content-type": "application/json" },
      body: key, credentials: "same-origin", keepalive: true,
    }).catch(() => undefined);
  } catch { /* Reporting must never break rendering. */ }
}
