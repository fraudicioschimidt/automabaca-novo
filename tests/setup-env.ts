import { resetEnvCacheForTests } from "@/src/infra/env";
import { resolveTestDatabaseUrl } from "./helpers/db-url";

/**
 * Antes de qualquer import de prisma/serviços: aponta DATABASE_URL para o
 * banco deste worker (`<base>` ou `<base>_${VITEST_POOL_ID}`, base do TEST_DATABASE_URL).
 */
process.env.DATABASE_URL = resolveTestDatabaseUrl();
// Mesmo um shell com dotenv em modo override não reativa credenciais do .env.
process.env.DOTENV_OVERRIDE = "false";
process.env.DOTENV_CONFIG_OVERRIDE = "false";
// "fatal" = quase mudo nos testes; "silent" NÃO é opção do Zod de getEnv.
process.env.LOG_LEVEL ??= "fatal";

// O prisma valida/cacheia o ambiente durante o import. Configure o Bridge
// sintético antes dele para os testes que injetam `deps.query` nunca dependerem
// da ordem dos arquivos nem herdarem credenciais reais do shell.
process.env.BRIDGEODDS_URL = "https://bridge.test";
process.env.BRIDGEODDS_USER = "test";
process.env.BRIDGEODDS_PASS = "test";

/**
 * Blindagem do ambiente de teste: NUNCA tocar providers pagos nem Telegram
 * real, mesmo que alguém rode a suíte com `.env` exportado no shell.
 * BridgeOdds usa valores sintéticos acima — os testes de enrich injetam
 * `deps.query` mock e dependem de `bridgeConfigured()`.
 */
for (const key of [
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "GEMINI_PAID_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "TELEGRAM_TOKEN",
  "TELEGRAM_ALLOWED_CHATS",
  "BRIDGEODDS_MAX_BET_CURRENCY",
  "FLASHSCORE_API_KEY",
  "PINNACLE17_RAPIDAPI_KEY",
  "PINNACLE17_MAX_BET_CURRENCY",
  "TELEGRAM_NOTIFICATION_BOT_TOKEN",
  "TELEGRAM_NOTIFICATION_CHAT_ID",
]) {
  // O worker importa dotenv/config: ausente seria preenchido de novo pelo .env.
  process.env[key] = "";
}
process.env.TELEGRAM_WEBHOOK_URL = "https://telegram.example.invalid/webhook";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret-with-at-least-32-characters";
process.env.FLASHSCORE_MODE = "off";
process.env.PINNACLE17_MODE = "off";

resetEnvCacheForTests();
