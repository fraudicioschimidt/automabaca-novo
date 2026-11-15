"use client";

import { useEffect } from "react";
import { configureBrowserTelemetry, reportBrowserError } from "./browser-error-reporter";

export function BrowserTelemetry(props: { clientRelease: string; pageCorrelationId?: string }) {
  useEffect(() => {
    configureBrowserTelemetry(props);
    const onError = (event: Event) => {
      if (event instanceof ErrorEvent) reportBrowserError("runtime", event.error ?? new Error(event.message));
      else if (event.target instanceof HTMLScriptElement) reportBrowserError("resource", undefined, event.target.src);
      else if (event.target instanceof HTMLLinkElement) reportBrowserError("resource", undefined, event.target.href);
      else if (event.target instanceof HTMLImageElement) reportBrowserError("resource", undefined, event.target.src);
    };
    const onRejection = (event: PromiseRejectionEvent) => reportBrowserError("unhandled_rejection", event.reason);
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
      configureBrowserTelemetry(undefined);
    };
  }, [props]);
  return null;
}
