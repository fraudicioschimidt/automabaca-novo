"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

const REFRESH_INTERVAL_MS = 5_000;
const ERROR_BACKOFF_MS = 30_000;

/** Consulta só a versão; os dados e agregados são recarregados juntos quando mudam. */
export function usePendingBetsRefresh(enabled: boolean, slug?: string, version?: string | null): void {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const nextCheckAt = useRef(0);
  const refreshStarted = useRef<{ version: string | null | undefined; at: number; slug: string } | null>(null);

  useEffect(() => {
    const started = refreshStarted.current;
    if (!started || !slug || started.slug !== slug || started.version === version) return;
    refreshStarted.current = null;
    const durationMs = Math.max(0, Math.round(performance.now() - started.at));
    if (durationMs > 60_000) return;
    fetch(`/api/bankrolls/${encodeURIComponent(slug)}/version`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ durationMs }),
      signal: AbortSignal.timeout(4_000) }).catch(() => {});
  }, [slug, version]);

  useEffect(() => {
    if (!enabled || !slug || pending) return;
    let stopped = false;
    let inFlight = false;
    const controller = new AbortController();
    const check = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      if (document.activeElement?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[aria-modal='true']")) return;
      if (Date.now() < nextCheckAt.current) return;
      nextCheckAt.current = Date.now() + REFRESH_INTERVAL_MS;
      inFlight = true;
      try {
        const response = await fetch(`/api/bankrolls/${encodeURIComponent(slug)}/version`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4_000)]),
        });
        if (!response.ok) throw new Error("version_unavailable");
        const data: unknown = await response.json();
        if (!stopped && data && typeof data === "object" && "version" in data &&
          typeof data.version === "string" && data.version !== version) {
          // Só a versão que chegou nos props confirma o refresh; falha permite nova tentativa.
          refreshStarted.current ??= { version, at: performance.now(), slug };
          startTransition(() => router.refresh());
        }
      } catch {
        if (!stopped) nextCheckAt.current = Date.now() + ERROR_BACKOFF_MS;
      } finally { inFlight = false; }
    };
    const refresh = () => { check().catch(() => {}); };
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, pending, router, slug, version]);
}
