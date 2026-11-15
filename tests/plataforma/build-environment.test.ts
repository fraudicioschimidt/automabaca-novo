import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnv } from "../../scripts/lib/build-env.mjs";
import { safeRemoveTreeSync } from "../../scripts/lib/safe-fs.mjs";

const require = createRequire(import.meta.url);
const nextConfigModule = require.resolve("next/dist/server/config");

describe("ambiente de build independente do .env local", () => {
  it("o build não recebe credenciais ou providers ativos do shell", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { buildEnv } = await import('./scripts/lib/build-env.mjs');
      console.log(JSON.stringify({ credentials: ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GEMINI_PAID_API_KEY',
        'GROQ_API_KEY', 'MISTRAL_API_KEY', 'TELEGRAM_TOKEN', 'TELEGRAM_NOTIFICATION_BOT_TOKEN',
        'PINNACLE17_RAPIDAPI_KEY', 'FLASHSCORE_API_KEY'].filter(key => Boolean(buildEnv[key])),
        pinnacle: buildEnv.PINNACLE17_MODE, flashscore: buildEnv.FLASHSCORE_MODE }));
    `], { cwd: new URL("../..", import.meta.url), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, GEMINI_API_KEY: "synthetic-gemini", GEMINI_API_KEYS: "synthetic-pool",
        GEMINI_PAID_API_KEY: "synthetic-paid", GROQ_API_KEY: "synthetic-groq", MISTRAL_API_KEY: "synthetic-mistral",
        TELEGRAM_TOKEN: "synthetic-main", TELEGRAM_NOTIFICATION_BOT_TOKEN: "synthetic-alert",
        PINNACLE17_RAPIDAPI_KEY: "synthetic-pinnacle", PINNACLE17_MODE: "on",
        FLASHSCORE_API_KEY: "synthetic-flashscore", FLASHSCORE_MODE: "on" },
    });
    expect(JSON.parse(output)).toEqual({ credentials: [], pinnacle: "off", flashscore: "off" });
  });
  it.each([false, true])("preserva a credencial fictícia e o banco sem acesso — .env presente: %s", (withEnv) => {
    const directory = mkdtempSync(path.join(tmpdir(), "automabaca-build-env-test-"));
    try {
      if (withEnv) writeFileSync(path.join(directory, ".env"), "AUTH_USERS=local-value\nDATABASE_URL=postgresql://local:local@localhost/local\n");
      const output = execFileSync(process.execPath, ["-e", `
        const { PHASE_PRODUCTION_BUILD } = require('next/constants');
        require(${JSON.stringify(nextConfigModule)}).default(PHASE_PRODUCTION_BUILD, process.argv[1]).then(() => {
          process.stdout.write(JSON.stringify({ auth: process.env.AUTH_USERS, database: process.env.DATABASE_URL }));
        });
      `, directory], { env: { ...buildEnv }, encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({ auth: buildEnv.AUTH_USERS, database: buildEnv.DATABASE_URL });
    } finally {
      safeRemoveTreeSync(tmpdir(), directory);
    }
  });
});
