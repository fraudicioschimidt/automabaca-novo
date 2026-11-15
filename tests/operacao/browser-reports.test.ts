import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ allow: vi.fn(() => true), log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/src/infra/browser-report-budget", () => ({ allowBrowserReport: mocks.allow }));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => mocks.log }));
vi.mock("@/src/infra/operational-metrics", () => ({ recordOperationalMetric: vi.fn(async () => undefined) }));
import { POST } from "@/app/api/telemetry/browser/route";
const body = { version: 1, kind: "runtime", reason: "unknown", route: "/", clientRelease: "release-test", privateData: "never-log" };
const request = (value = JSON.stringify(body), headers: Record<string, string> = {}) => new Request("https://app.test/api/telemetry/browser", {
  method: "POST", headers: { origin: "https://app.test", "content-type": "application/json", ...headers }, body: value,
});
beforeEach(() => { vi.clearAllMocks(); mocks.allow.mockReturnValue(true); });

it("accepts a sanitized report and distinguishes resource errors", async () => {
  const response = await POST(request(undefined, { "x-correlation-id": "proxy_browser-report" }));
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-correlation-id")).toBe("proxy_browser-report");
  expect(mocks.log.error).toHaveBeenCalledWith(expect.objectContaining({ eventCode: "BROWSER_ERROR_REPORTED" }), expect.any(String));
  expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain("never-log");
  expect((await POST(request(JSON.stringify({ ...body, kind: "resource" })))).status).toBe(202);
  expect(mocks.log.warn).toHaveBeenCalled();
});

it("rejects foreign origins, oversized bodies even without content-length, and floods", async () => {
  expect((await POST(request(undefined, { origin: "https://evil.test" }))).status).toBe(403);
  expect((await POST(request(undefined, { origin: "" }))).status).toBe(403);
  expect((await POST(request("x".repeat(9_000)))).status).toBe(413);
  expect((await POST(request("{"))).status).toBe(400);
  mocks.allow.mockReturnValue(false);
  expect((await POST(request())).status).toBe(429);
  expect(mocks.log.error).not.toHaveBeenCalled();
});

it("uses the same trusted proxy address when client-controlled prefixes rotate", async () => {
  for (const prefix of ["198.51.100.1", "198.51.100.2", "untrusted"]) {
    expect((await POST(request(undefined, {
      "x-forwarded-for": `${prefix}, 203.0.113.7`, "x-real-ip": prefix,
    }))).status).toBe(202);
  }
  expect(mocks.allow.mock.calls).toEqual([
    ["203.0.113.7"], ["203.0.113.7"], ["203.0.113.7"],
  ]);
});

it("groups missing and invalid addresses instead of accepting arbitrary budget keys", async () => {
  for (const forwarded of ["", "invalid", "203.0.113.7,"]) {
    await POST(request(undefined, { "x-forwarded-for": forwarded }));
  }
  expect(mocks.allow.mock.calls).toEqual([["unknown"], ["unknown"], ["unknown"]]);
});
