import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) safeRemoveTreeSync(tmpdir(), directory); });

describe("isolamento do bootstrap dos testes", () => {
  it.each([
    { primeCache: false, reloadDotenv: false, override: false },
    { primeCache: true, reloadDotenv: false, override: false },
    { primeCache: true, reloadDotenv: true, override: false },
    { primeCache: true, reloadDotenv: true, override: true },
  ])("remove credenciais herdadas antes dos serviços: %j", ({ primeCache, reloadDotenv, override }) => {
    const directory = mkdtempSync(join(tmpdir(), "automabaca-setup-env-"));
    directories.push(directory);
    const envFile = join(directory, ".env");
    writeFileSync(envFile, [
      "GEMINI_API_KEY=synthetic-reload",
      "GROQ_API_KEY=synthetic-reload",
      "TELEGRAM_TOKEN=synthetic-reload",
      "PINNACLE17_RAPIDAPI_KEY=synthetic-reload",
      "TELEGRAM_WEBHOOK_URL=https://reloaded.example.invalid/webhook",
      "TELEGRAM_WEBHOOK_SECRET=synthetic-reloaded-webhook-secret-with-32-characters",
      "DATABASE_URL=postgresql://test:test@database.example.invalid/production",
      "DOTENV_RELOAD_MARKER=loaded",
      "",
    ].join("\n"));
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      const { getEnv } = await import('./src/infra/env.ts');
      if (process.argv[1] === 'true') getEnv();
      await import('./tests/setup-env.ts');
      const testDatabase = process.env.DATABASE_URL;
      if (process.argv[2] === 'true') {
        delete process.env.DOTENV_RELOAD_MARKER;
        await import('dotenv/config');
        if (process.env.DOTENV_RELOAD_MARKER !== 'loaded') throw new Error('Fixture dotenv não foi carregada');
      }
      const env = getEnv();
      const keys = ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GEMINI_PAID_API_KEY', 'GROQ_API_KEY',
        'MISTRAL_API_KEY', 'TELEGRAM_TOKEN', 'TELEGRAM_NOTIFICATION_BOT_TOKEN',
        'TELEGRAM_ALLOWED_CHATS',
        'PINNACLE17_RAPIDAPI_KEY', 'FLASHSCORE_API_KEY'];
      console.log(JSON.stringify({ databasePreserved: env.DATABASE_URL === testDatabase, webhook: [env.TELEGRAM_WEBHOOK_URL, env.TELEGRAM_WEBHOOK_SECRET], credentials: keys.filter(key => Boolean(env[key])),
        pinnacle: env.PINNACLE17_MODE, flashscore: env.FLASHSCORE_MODE,
        bridge: [env.BRIDGEODDS_URL, env.BRIDGEODDS_USER, env.BRIDGEODDS_PASS] }));
    `, String(primeCache), String(reloadDotenv)], {
      cwd: new URL("../..", import.meta.url), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, DOTENV_OVERRIDE: String(override), DOTENV_CONFIG_OVERRIDE: String(override),
        DOTENV_PATH: envFile, DOTENV_CONFIG_PATH: envFile, DOTENV_QUIET: "true", DOTENV_CONFIG_QUIET: "true",
        DOTENV_RELOAD_MARKER: "", NODE_ENV: "test", AUTOMABACA_PROCESS: "worker",
        GEMINI_API_KEY: "synthetic-gemini", GEMINI_API_KEYS: "synthetic-pool",
        GEMINI_PAID_API_KEY: "synthetic-paid", GROQ_API_KEY: "synthetic-groq", MISTRAL_API_KEY: "synthetic-mistral",
        TELEGRAM_TOKEN: "synthetic-main", TELEGRAM_NOTIFICATION_BOT_TOKEN: "synthetic-alert",
        TELEGRAM_WEBHOOK_URL: "https://telegram.example.invalid/webhook",
        TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook-secret-with-at-least-32-characters", TELEGRAM_ALLOWED_CHATS: "1",
        PINNACLE17_RAPIDAPI_KEY: "synthetic-pinnacle", PINNACLE17_MODE: "on",
        FLASHSCORE_API_KEY: "synthetic-flashscore", FLASHSCORE_MODE: "on" },
    });
    expect(JSON.parse(output)).toEqual({
      databasePreserved: true,
      webhook: ["https://telegram.example.invalid/webhook", "test-webhook-secret-with-at-least-32-characters"], credentials: [], pinnacle: "off", flashscore: "off",
      bridge: ["https://bridge.test", "test", "test"] });
  });
});
