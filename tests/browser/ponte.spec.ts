import path from "node:path";
import { expect, test } from "@playwright/test";

// O WebAssembly da ponte num navegador de verdade, e não só no Node: o regex
// do domínio usa o RegExp do host por um helper JS embutido na cola, e a
// leitura de data passa por ele. A página e os arquivos vêm por rota, sem o
// app: o que se testa aqui é o binário.
const PONTE = path.resolve("rust/crates/ponte/wasm");

test("a ponte WebAssembly roda no navegador, com o regex pelo RegExp do host", async ({ page }) => {
  await page.route("**/__ponte__/**", async (route) => {
    const nome = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    if (nome === "index.html") {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>ponte</title>" });
      return;
    }
    const contentType = nome.endsWith(".wasm") ? "application/wasm" : "text/javascript";
    await route.fulfill({ path: path.join(PONTE, nome), contentType });
  });
  await page.goto("/__ponte__/index.html");
  await page.addScriptTag({
    type: "module",
    content: `
      import init, * as cola from "/__ponte__/dominio_ponte.mjs";
      await init({ module_or_path: "/__ponte__/dominio_ponte_bg.wasm" });
      window.__ponte = {
        kickoff: cola.parseBrKickoff("📅 27/09 ⏰ 21h30", Date.UTC(2026, 8, 23, 12)),
        turco: cola.regexExec("kasimpasa", "i", "Kasımpaşa", 0),
        troca: cola.regexReplace("(\\\\d+)/(\\\\d+)", "g", "27/09 e 1/2", "$2-$1"),
        divisao: cola.regexSplit("\\\\s+", "", " a  b ", undefined),
      };
    `,
  });
  await page.waitForFunction(() => "__ponte" in window);
  const resultado = await page.evaluate(() => (window as unknown as { __ponte: unknown }).__ponte);
  expect(resultado).toEqual({
    kickoff: [Date.UTC(2026, 8, 28, 0, 30), false],
    turco: null,
    troca: "09-27 e 2-1",
    divisao: ["", "a", "b", ""],
  });
});
