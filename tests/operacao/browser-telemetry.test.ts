import { afterEach, expect, it, vi } from "vitest";
import { sanitizeBrowserReport } from "@/src/domain/browser-telemetry";
import { configureBrowserTelemetry, reportBrowserError } from "@/app/_components/browser-error-reporter";

afterEach(() => { configureBrowserTelemetry(undefined); vi.unstubAllGlobals(); });
const report = { version: 1, kind: "runtime", reason: "unknown", route: "/tipsters/private-person?token=secret", clientRelease: "release-1" };

it("server allowlist removes personal routes, arbitrary fields, URLs and invalid frames", () => {
  const result = sanitizeBrowserReport({ ...report, message: "private-bet", token: "secret", digest: "private person",
    frames: [{ asset: "https://private.example/user", line: 1, column: 2 }, { asset: "/_next/static/chunks/app-123.js?token=secret", line: 3, column: 4 }],
  });
  expect(result).toMatchObject({ route: "/tipsters/[slug]", frames: [{ asset: "/_next/static/chunks/app-123.js", line: 3, column: 4 }] });
  expect(JSON.stringify(result)).not.toMatch(/private|secret|token/);
  expect(sanitizeBrowserReport({ ...report, kind: "forged" })).toBeNull();
});

it("reports useful stack positions once, without transmitting the error message or query", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("collector offline"));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", { location: { href: "https://app.test/tipsters/alice?token=secret", origin: "https://app.test", pathname: "/tipsters/alice" } });
  configureBrowserTelemetry({ clientRelease: "release-test", pageCorrelationId: "http_initial" });
  const error = new Error("Cannot read properties of undefined: private bet");
  error.stack = "Error: private\n at fn (https://app.test/_next/static/chunks/app-123.js?token=secret:20:40)";
  reportBrowserError("runtime", error);
  reportBrowserError("runtime", error);
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetcher.mock.calls[0]?.[1].body);
  expect(body).toMatchObject({ reason: "undefined_access", pageCorrelationId: "http_initial", route: "/tipsters/[slug]", frames: [{ asset: "/_next/static/chunks/app-123.js", line: 20, column: 40 }] });
  expect(JSON.stringify(body)).not.toMatch(/alice|private|token|secret/);
});
