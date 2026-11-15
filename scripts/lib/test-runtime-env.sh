#!/usr/bin/env bash
# Ambiente determinístico e sem credenciais reais para builds/testes que rodam
# com NODE_ENV=production. Deve ser carregado depois do .env local: preserva
# autenticação/storage locais, mas neutraliza integrações externas.

ab_export_test_runtime_env() {
  local fallback_auth='fabricio:scrypt\$salt\$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:admin'
  export AUTH_USERS="${AUTH_USERS:-$fallback_auth}"
  export AUTH_SESSION_SECRET="${AUTH_SESSION_SECRET:-test-session-secret-with-at-least-32-characters}"
  export LOG_HASH_SECRET="${LOG_HASH_SECRET:-test-log-hash-secret-with-at-least-32-characters}"
  export LOGOS_DIR="${LOGOS_DIR:-/tmp/automabaca-logos}"
  # A suíte sobe o web, e o web de produção também declara isso.
  export AUTOMABACA_PROCESS="${AUTOMABACA_PROCESS:-web}"

  # Sempre sobrescritas: mesmo que o shell do operador possua credenciais
  # reais, uma suíte de teste nunca pode alcançar providers ou bots reais.
  export DOTENV_OVERRIDE="false" DOTENV_CONFIG_OVERRIDE="false"
  # Vazios exportados impedem que o loader do servidor os reponha pelo .env.
  export GEMINI_API_KEY="" GEMINI_API_KEYS="" GEMINI_PAID_API_KEY="" GROQ_API_KEY="" MISTRAL_API_KEY=""
  export PINNACLE17_RAPIDAPI_KEY="" FLASHSCORE_API_KEY=""
  export BRIDGEODDS_MAX_BET_CURRENCY="" PINNACLE17_MAX_BET_CURRENCY="" TELEGRAM_ALLOWED_CHATS=""
  export PINNACLE17_MODE="off" FLASHSCORE_MODE="off"
  export PUBLIC_APP_URL="https://automabaca.example.invalid"
  export TELEGRAM_NOTIFICATION_BOT_TOKEN="test-notification-token"
  export TELEGRAM_NOTIFICATION_CHAT_ID="1"
  export TELEGRAM_TOKEN="test-main-token"
  export TELEGRAM_WEBHOOK_URL="https://automabaca.example.invalid/api/telegram/webhook"
  export TELEGRAM_WEBHOOK_SECRET="test-webhook-secret-with-at-least-32-characters"
  export BRIDGEODDS_URL="https://bridge.example.invalid"
  export BRIDGEODDS_USER="test"
  export BRIDGEODDS_PASS="test"
  export VISUAL_TEST_MODE=1
}
