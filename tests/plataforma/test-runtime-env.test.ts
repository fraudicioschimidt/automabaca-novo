import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) safeRemoveTreeSync(tmpdir(), directory); });

describe("ambiente do servidor de navegador", () => {
  it.each([false, true])("neutraliza credenciais mesmo após dotenv, com override herdado: %s", (override) => {
    const directory = mkdtempSync(join(tmpdir(), "automabaca-test-runtime-env-"));
    directories.push(directory);
    const envFile = join(directory, ".env");
    writeFileSync(envFile, [
      "GEMINI_API_KEY=synthetic-reload",
      "GROQ_API_KEY=synthetic-reload",
      "TELEGRAM_TOKEN=synthetic-reload",
      "PINNACLE17_RAPIDAPI_KEY=synthetic-reload",
      "DATABASE_URL=postgresql://test:test@database.example.invalid/production",
      "DOTENV_RELOAD_MARKER=loaded",
      "",
    ].join("\n"));
    const output = execFileSync("bash", ["-c", `
      set -euo pipefail
      source scripts/lib/test-runtime-env.sh
      ab_export_test_runtime_env
      unset DOTENV_RELOAD_MARKER
      node -r dotenv/config -e 'console.log(JSON.stringify({
        databasePreserved: process.env.DATABASE_URL === "postgresql://test:test@database.example.invalid/automabaca_e2e",
        credentials: ["GEMINI_API_KEY", "GEMINI_API_KEYS", "GEMINI_PAID_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
          "PINNACLE17_RAPIDAPI_KEY", "FLASHSCORE_API_KEY"].filter(key => Boolean(process.env[key])),
        pinnacle: process.env.PINNACLE17_MODE, flashscore: process.env.FLASHSCORE_MODE,
        bridge: process.env.BRIDGEODDS_URL, telegram: process.env.TELEGRAM_TOKEN,
        notification: process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN, reloaded: process.env.DOTENV_RELOAD_MARKER
      }))'
    `], { cwd: new URL("../..", import.meta.url), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, DATABASE_URL: "postgresql://test:test@database.example.invalid/automabaca_e2e", DOTENV_OVERRIDE: String(override), DOTENV_CONFIG_OVERRIDE: String(override),
        DOTENV_PATH: envFile, DOTENV_CONFIG_PATH: envFile, DOTENV_QUIET: "true", DOTENV_CONFIG_QUIET: "true",
        DOTENV_RELOAD_MARKER: "", GEMINI_API_KEY: "synthetic-gemini", GEMINI_API_KEYS: "synthetic-pool",
        GEMINI_PAID_API_KEY: "synthetic-paid", GROQ_API_KEY: "synthetic-groq", MISTRAL_API_KEY: "synthetic-mistral",
        PINNACLE17_RAPIDAPI_KEY: "synthetic-pinnacle", PINNACLE17_MODE: "on",
        FLASHSCORE_API_KEY: "synthetic-flashscore", FLASHSCORE_MODE: "on", TELEGRAM_TOKEN: "synthetic-main",
        TELEGRAM_NOTIFICATION_BOT_TOKEN: "synthetic-alert", BRIDGEODDS_URL: "https://provider.example.invalid" },
    });
    expect(JSON.parse(output)).toEqual({ databasePreserved: true, credentials: [], pinnacle: "off", flashscore: "off",
      bridge: "https://bridge.example.invalid", telegram: "test-main-token", notification: "test-notification-token", reloaded: "loaded" });
  });
});
