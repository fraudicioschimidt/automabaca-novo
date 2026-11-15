import "dotenv/config";
import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL
  ?? process.env.E2E_BASE_URL
  ?? process.env.SMOKE_BASE_URL
  ?? "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/browser",
  // Recusa banco fora de `*_e2e*` — ver o arquivo para o porquê de morar lá.
  globalSetup: "./tests/browser/global-setup.ts",
  outputDir: "test-results/playwright",
  // Cada shard tem banco próprio. A granularidade por teste equilibra os casos;
  // o CI usa 2 workers e a execução local usa 5 por padrão.
  fullyParallel: true,
  // Acima de 5 workers, `critical` (mutação real) e o teste de gráficos
  // estouram o timeout por disputa de CPU.
  workers: Number(process.env.PLAYWRIGHT_WORKERS) || (process.env.CI ? 2 : 5),
  retries: process.env.CI ? 2 : 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testMatch: /.*\.spec\.ts/,
      testIgnore: /tablet\.spec\.ts/,
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: /(smoke|accessibility|config)\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: "tablet",
      testMatch: /tablet\.spec\.ts/,
      use: { viewport: { width: 820, height: 1180 } },
    },
  ],
});
