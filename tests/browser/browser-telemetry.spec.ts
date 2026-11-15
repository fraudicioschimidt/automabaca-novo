import { test, expect } from "@playwright/test";

test("client errors are correlated, sanitized and deduplicated on the login page", async ({ page }) => {
  const reports: Record<string, unknown>[] = [];
  await page.route("**/api/telemetry/browser", async (route) => {
    reports.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 202, body: "" });
  });
  await page.goto("/login?private=PRIVATE_SENTINEL");
  await page.locator('input[type="password"]').waitFor();
  // Wait for hydration before dispatching a synthetic, non-business failure.
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const error = new TypeError("Cannot read properties of undefined PRIVATE_SENTINEL");
    error.stack = `TypeError: PRIVATE_SENTINEL\n at test (${location.origin}/_next/static/chunks/test-abc123.js?secret=PRIVATE_SENTINEL:12:3)`;
    for (let n = 0; n < 2; n++) window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
  });
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({ kind: "runtime", route: "/login", reason: "undefined_access" });
  expect(reports[0]?.pageCorrelationId).toBeTruthy();
  expect(reports[0]?.clientRelease).toBeTruthy();
  expect(JSON.stringify(reports)).not.toContain("PRIVATE_SENTINEL");
});

test("browser endpoint accepts a safe same-origin report and refuses a foreign origin", async ({ page }) => {
  await page.goto("/login");
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/telemetry/browser", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, kind: "resource", route: "/login", reason: "resource_load", clientRelease: "browser-test", message: "PRIVATE_SENTINEL" }) });
    return { status: response.status, correlation: response.headers.get("x-correlation-id") };
  });
  expect(result.status).toBe(202);
  expect(result.correlation).toBeTruthy();
  const rejected = await page.request.post("/api/telemetry/browser", { headers: { origin: "https://foreign.invalid" }, data: { version: 1 } });
  expect(rejected.status()).toBe(403);
});
