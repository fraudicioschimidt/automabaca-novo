import { expect, test } from "@playwright/test";

test("referências de ação malformadas recebem 400 na página pública", async ({ request }) => {
  for (const action of ["x", "0", "1", "action"]) {
    const response = await request.post("/login", {
      headers: { "next-action": action }, data: "[]",
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: "Referência de ação inválida." });
  }
  expect((await request.get("/login")).status()).toBe(200);
});

function nonceFrom(csp: string): string {
  const match = csp.match(/'nonce-([^']+)'/);
  expect(match, "CSP precisa conter nonce").toBeTruthy();
  return match![1]!;
}

test("headers de segurança e nonce correspondem ao HTML", async ({ page }) => {
  const response = await page.goto("/login", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  const headers = response!.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin");

  const csp = headers["content-security-policy"] ?? "";
  const nonce = nonceFrom(csp);
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("style-src-attr 'unsafe-inline'");
  expect(csp.match(/script-src[^;]*/)?.[0]).not.toContain("'unsafe-inline'");
  expect(csp.match(/style-src [^;]*/)?.[0]).not.toContain("'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp.match(/script-src[^;]*/)?.[0]).toContain("'wasm-unsafe-eval'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");

  const missingNonce = await page.locator("script, style").evaluateAll((elements, expected) =>
    elements.filter((element) => (element as HTMLScriptElement | HTMLStyleElement).nonce !== expected)
      .map((element) => element.outerHTML),
  nonce);
  expect(missingNonce).toEqual([]);
});

test("nonce muda a cada resposta e bloqueia injeção inline", async ({ page, request }) => {
  const first = await request.get("/login");
  const second = await request.get("/login");
  expect(nonceFrom(first.headers()["content-security-policy"] ?? ""))
    .not.toBe(nonceFrom(second.headers()["content-security-policy"] ?? ""));

  await page.goto("/login", { waitUntil: "networkidle" });
  const result = await page.evaluate(async () => {
    const image = document.createElement("img");
    image.setAttribute("onerror", "window.__automabacaInjected = true");
    image.src = "/__csp-missing-image__";
    document.body.append(image);
    const style = document.createElement("style");
    style.textContent = "body { --csp-injected: blocked; }";
    document.head.append(style);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      inlineHandlerRan: Boolean((window as Window & { __automabacaInjected?: boolean }).__automabacaInjected),
      styleApplied: getComputedStyle(document.body).getPropertyValue("--csp-injected").trim(),
    };
  });
  expect(result).toEqual({ inlineHandlerRan: false, styleApplied: "" });
});

test("assets PWA são públicos e POST cross-site é rejeitado", async ({ request }) => {
  for (const path of [
    "/icon.svg",
    "/manifest.webmanifest",
    "/sw.js",
    "/pwa-icon-192.png",
    "/pwa-icon-512.png",
    "/pwa-icon-maskable-512.png",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    if (path === "/icon.svg") {
      expect(response.headers()["content-type"]).toContain("image/svg+xml");
      expect(await response.text()).toContain("<svg");
    }
  }

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Disallow: /");

  const rejected = await request.post("/api/auth/login", {
    headers: {
      origin: "https://cross-site.invalid",
      "sec-fetch-site": "cross-site",
    },
    data: { username: "nobody", password: "irrelevant" },
  });
  expect(rejected.status()).toBe(403);
});
