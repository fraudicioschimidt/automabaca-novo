import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { DB_TEST_MAX_WORKERS } from "./tests/helpers/db-workers";
import { DB_TEST_TIMEOUT } from "./tests/helpers/db-timeout";
import { resolveTestDatabaseUrl } from "./tests/helpers/db-url";

const alias = {
  "@": fileURLToPath(new URL(".", import.meta.url)),
  // Permite testar services do painel (import "server-only") no Node.
  "server-only": fileURLToPath(new URL("./tests/helpers/server-only-stub.ts", import.meta.url)),
  // A ponte Rust DESTE checkout: numa worktree o node_modules é o da árvore
  // principal, e o link do npm levaria ao binário compilado lá. Com
  // DOMINIO_PONTE=wasm, os testes rodam contra o lado do navegador
  // (`npm run test:ponte-wasm`).
  "@automabaca/dominio": fileURLToPath(new URL(
    process.env.DOMINIO_PONTE === "wasm" ? "./rust/crates/ponte/browser.mjs" : "./rust/crates/ponte/index.cjs",
    import.meta.url,
  )),
};

const sharedEnv = {
  NODE_ENV: "test" as const,
  DATABASE_URL: resolveTestDatabaseUrl(),
  // Sempre UTC, como a VPS. A máquina e os runners estão em São Paulo: com o
  // fuso deles, um formatador que usasse o fuso local em vez do de São Paulo
  // passaria em todos os testes. `fuso-do-operador.test.ts` guarda a escolha.
  TZ: "UTC",
};

/**
 * Dois projetos: unit em paralelo (CPU) e db com N bancos isolados
 * (`<base>_1`…`_N`, base do TEST_DATABASE_URL) — fileParallelism sem TRUNCATE cruzado.
 */
export default defineConfig({
  test: {
    // Na raiz, não por projeto: um override por projeto mascara `--maxWorkers` da CLI.
    maxWorkers: DB_TEST_MAX_WORKERS,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "app/**/*.{ts,tsx}"],
      exclude: ["src/generated/**", "app/**/loading.tsx", "app/**/error.tsx"],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["tests/**/*.db.test.ts"],
          setupFiles: ["./tests/setup-env.ts"],
          fileParallelism: true,
          // Casos que fazem `await import` de service pesado medem o transform
          // sob a suíte cheia; 5s (default) vira flake.
          testTimeout: 15_000,
          env: sharedEnv,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "db",
          environment: "node",
          include: ["tests/**/*.db.test.ts"],
          globalSetup: ["./tests/global-setup.ts"],
          setupFiles: ["./tests/setup-env.ts"],
          fileParallelism: true,
          testTimeout: DB_TEST_TIMEOUT,
          // Mesmo teto para hooks: `boss.start()` não cabe nos 10s default sob carga.
          hookTimeout: DB_TEST_TIMEOUT,
          env: {
            ...sharedEnv,
            // Liga bancos por worker em db-url (unitários não setam isto).
            VITEST_DB_PARALLEL: "1",
          },
        },
      },
    ],
  },
});
