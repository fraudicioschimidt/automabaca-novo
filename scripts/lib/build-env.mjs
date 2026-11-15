import { tmpdir } from "node:os";
import path from "node:path";

// A compilação só precisa validar o formato das configurações. Valores do
// processo filho não são gravados no .env nem usados pelo servidor em runtime.
// As páginas do painel são dinâmicas; qualquer consulta no build deve falhar.
/** @type {NodeJS.ProcessEnv} */
export const buildEnv = {
  ...process.env,
  // Um build não deve alcançar integrações nem herdar chaves do operador.
  GEMINI_API_KEY: "",
  GEMINI_API_KEYS: "",
  GEMINI_PAID_API_KEY: "",
  GROQ_API_KEY: "",
  MISTRAL_API_KEY: "",
  TELEGRAM_TOKEN: "",
  TELEGRAM_ALLOWED_CHATS: "",
  TELEGRAM_NOTIFICATION_BOT_TOKEN: "",
  TELEGRAM_NOTIFICATION_CHAT_ID: "",
  PINNACLE17_RAPIDAPI_KEY: "",
  PINNACLE17_MODE: "off",
  FLASHSCORE_API_KEY: "",
  FLASHSCORE_MODE: "off",
  BRIDGEODDS_MAX_BET_CURRENCY: "",
  PINNACLE17_MAX_BET_CURRENCY: "",
  NODE_ENV: "production",
  AUTOMABACA_PROCESS: "web",
  NEXT_TELEMETRY_DISABLED: "1",
  // Marcador do loader @next/env: o ambiente deste processo já está pronto.
  // Reprocessar .env expande os $ do hash fictício e corrompe AUTH_USERS.
  // Vale só para o filho de build; o runtime continua lendo sua configuração.
  __NEXT_PROCESSED_ENV: "true",
  DATABASE_URL: "postgresql://build:build@127.0.0.1:1/automabaca_build?connect_timeout=1",
  AUTH_USERS: `build:scrypt$build-only-salt$${"0".repeat(128)}:admin`,
  AUTH_SESSION_SECRET: "build-only-session-secret-with-no-runtime-access",
  LOG_HASH_SECRET: "build-only-log-secret-with-no-runtime-access",
  PUBLIC_APP_URL: "https://build.invalid",
  LOGOS_DIR: path.join(tmpdir(), "automabaca-build-logos"),
  BRIDGEODDS_URL: "https://bridge.build.invalid",
  BRIDGEODDS_USER: "build",
  BRIDGEODDS_PASS: "build",
  TELEGRAM_WEBHOOK_URL: "https://telegram.build.invalid/webhook",
  TELEGRAM_WEBHOOK_SECRET: "build-only-webhook-secret-with-no-runtime-access",
};
