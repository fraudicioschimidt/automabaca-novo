/**
 * Allowlist única do ambiente de produção: quais chaves do
 * `/etc/automabaca-novo/runtime.env` chegam a cada container.
 *
 * A web nunca recebe o token do bot principal, as chaves de LLM (só as flags
 * de LLM, que o card de Operações lê; os modelos estão no catálogo em
 * `src/infra/llm/models.ts`) nem as chaves da Pinnacle17 e do FlashScore; o
 * worker nunca recebe as credenciais do painel. A BridgeOdds chega aos dois:
 * o botão "Odds fechamento" do painel consulta a Bridge dentro da web.
 * Nenhum dos dois recebe `DATABASE_URL_ADMIN`, que mora no runtime.env só para
 * o `deploy/migrar.py`.
 *
 * Quem consome: `deploy/split-env.cjs` (gera web.env e worker.env) e os testes
 * `tests/plataforma/runtime-env.test.ts` e `tests/seguranca/security-config.test.ts`, que cruzam a
 * lista com o schema de `src/infra/env.ts`. Chave nova no schema que precisa
 * chegar à produção entra aqui; uma chave fora da lista chega ao runtime.env e
 * morre no split-env, e o processo roda com o default do schema.
 *
 * Só módulos nativos: roda no servidor com `sudo node`, sem node_modules.
 */

/** Configuração que web e worker leem. Nenhum segredo de LLM aqui. */
const COMPARTILHADAS = [
  "DATABASE_URL", "DB_POOL_MAX", "LOG_LEVEL",
  "GEMINI_SEARCH_MODELS", "LLM_OCR_CACHE", "LLM_VISION_EVALUATION", "LLM_MODELS_DISABLED",
  "GROQ_BASE_URL", "LLM_DISABLE_GROQ",
  "MISTRAL_CHAT_NARROW_ONLY", "MISTRAL_BASE_URL", "LLM_DISABLE_MISTRAL", "LLM_DISABLE_MISTRAL_CHAT",
  "BRIDGEODDS_URL", "BRIDGEODDS_USER", "BRIDGEODDS_PASS", "BRIDGEODDS_MAX_BET_CURRENCY",
  "PINNACLE17_MAX_BET_CURRENCY",
  "PRICE_ARCHIVE_ENABLED", "PRICE_ARCHIVE_RETENTION_DAYS", "PRICE_ARCHIVE_MAX_COMPRESSED_MB",
  "CLOSING_SERIES_DAILY_CAP",
  "SHARP_AUTO_MATCH_MIN_SCORE", "SHARP_JUDGE_MIN_CONFIDENCE",
];

/** Só o worker chama Gemini, Groq e Mistral. */
const SEGREDOS_LLM = [
  "GEMINI_API_KEY", "GEMINI_API_KEYS", "GEMINI_PAID_API_KEY",
  "GROQ_API_KEY", "MISTRAL_API_KEY",
];

/**
 * Só o worker consulta a Pinnacle17 e o FlashScore (RapidAPI paga). O modo vai
 * junto com a chave: na web ele cai no default `off`, e `on` sem a chave
 * derrubaria o boot.
 */
const SEGREDOS_PROVEDORES_PAGOS = [
  "PINNACLE17_RAPIDAPI_KEY", "PINNACLE17_MODE",
  "FLASHSCORE_API_KEY", "FLASHSCORE_MODE",
];

const ALERTAS = ["TELEGRAM_NOTIFICATION_BOT_TOKEN", "TELEGRAM_NOTIFICATION_CHAT_ID"];

/**
 * O compose também define `AUTOMABACA_RELEASE_*` e prevalece sobre o env_file;
 * a cópia do runtime.env fica por compatibilidade com os arquivos já gerados.
 */
const OBSERVABILIDADE = ["AUTOMABACA_RELEASE_SHA", "AUTOMABACA_RELEASE_ID", "LOG_HASH_SECRET"];

const ALLOWLIST = {
  web: [
    ...COMPARTILHADAS, ...ALERTAS, ...OBSERVABILIDADE,
    "AUTH_USERS", "AUTH_SESSION_SECRET", "PUBLIC_APP_URL",
    "TELEGRAM_WEBHOOK_URL", "TELEGRAM_WEBHOOK_SECRET",
  ],
  worker: [
    ...COMPARTILHADAS, ...SEGREDOS_LLM, ...SEGREDOS_PROVEDORES_PAGOS, ...ALERTAS, ...OBSERVABILIDADE,
    "TELEGRAM_TOKEN", "TELEGRAM_ALLOWED_CHATS",
    "TELEGRAM_WEBHOOK_URL", "TELEGRAM_WEBHOOK_SECRET",
  ],
};

/**
 * Valores fixos de cada container, que não vêm do runtime.env. Os caminhos são
 * os volumes de `deploy/compose.yaml`; a porta é a interna do container.
 */
const FIXAS = {
  web: {
    NODE_ENV: "production", AUTOMABACA_PROCESS: "web",
    PORT: "3000", HOSTNAME: "0.0.0.0", LOGOS_DIR: "/data/logos",
  },
  worker: { NODE_ENV: "production", AUTOMABACA_PROCESS: "worker" },
};

/** Ficam no runtime.env para o deploy, e nunca vão para web ou worker. */
const SO_NO_RUNTIME_ENV = ["DATABASE_URL_ADMIN"];

/**
 * Ambiente de cada container a partir do runtime.env já interpretado. A ordem
 * das chaves é a da allowlist, seguida das fixas: gerar duas vezes o mesmo
 * arquivo dá o mesmo texto.
 *
 * @param {Record<string, string | undefined>} runtime
 * @returns {{ web: Record<string, string>, worker: Record<string, string> }}
 */
function ambientesDeProducao(runtime) {
  const saida = { web: {}, worker: {} };
  for (const papel of ["web", "worker"]) {
    /** @type {Record<string, string>} */
    const env = {};
    for (const chave of ALLOWLIST[papel]) {
      const valor = runtime[chave];
      if (valor !== undefined) env[chave] = valor;
    }
    Object.assign(env, FIXAS[papel]);
    env.NEXT_TELEMETRY_DISABLED = "1";
    saida[papel] = env;
  }
  return saida;
}

module.exports = { ALLOWLIST, FIXAS, SO_NO_RUNTIME_ENV, ambientesDeProducao };
