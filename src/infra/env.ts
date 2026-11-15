import { z } from "zod";
import path from "node:path";

function validAuthUsers(raw: string): boolean {
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 && entries.every((entry) => {
    const [usernameRaw, hashRaw] = entry.split(":");
    const username = usernameRaw?.trim() ?? "";
    const hash = (hashRaw?.trim() ?? "").replace(/\\\$/g, "$");
    const [scheme, salt, digest] = hash.split("$");
    return (
      /^[A-Za-z0-9._-]{1,64}$/.test(username) &&
      scheme === "scrypt" &&
      Boolean(salt) &&
      /^[0-9a-f]{64,256}$/i.test(digest ?? "") &&
      (digest?.length ?? 1) % 2 === 0
    );
  });
}

/** Liga/desliga de provider: `on` liga, `off` desliga. */
const providerMode = z.enum(["off", "on"]).default("off");

const optionalIsoCurrency = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().transform((value) => value.toUpperCase()).pipe(z.string().regex(/^[A-Z]{3}$/)).optional(),
);

/**
 * Validação fail-fast do ambiente (lei: erro de configuração derruba o boot
 * com mensagem completa, nunca falha silenciosa no meio de uma operação).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AUTOMABACA_PROCESS: z.enum(["web", "worker"]).optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
  PORT: z.coerce.number().int().positive().default(3100),
  PUBLIC_APP_URL: z.string().url().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  LOG_HASH_SECRET: z.string().min(32, "LOG_HASH_SECRET precisa de ≥32 chars").optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  PRICE_ARCHIVE_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  CLOSING_SERIES_DAILY_CAP: z.coerce.number().int().min(1).max(1000).default(500),
  PRICE_ARCHIVE_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  PRICE_ARCHIVE_MAX_COMPRESSED_MB: z.coerce.number().int().min(1).max(1024).default(256),
  /// Bot dedicado a alertas operacionais. Opcional em dev;
  /// sem ele, alertas caem só no log com warn.
  TELEGRAM_NOTIFICATION_BOT_TOKEN: z.string().optional(),
  TELEGRAM_NOTIFICATION_CHAT_ID: z.string().optional(),
  /// Bot principal (captura de canais + DM). Sem ele o worker sobe
  /// normalmente, apenas sem o módulo Telegram (warn no boot).
  TELEGRAM_TOKEN: z.string().optional(),
  /// Única entrada dos updates: o worker com token exige os dois. O processo
  /// web recebe somente o segredo, nunca o token do bot.
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(32).max(256).optional(),
  /// Pool Gemini (cascata LLM): GEMINI_API_KEYS = csv de chaves free;
  /// GEMINI_PAID_API_KEY = fallback pago. Os modelos da cascata e a ordem
  /// deles estão no catálogo em código (`src/infra/llm/models.ts`).
  /// GEMINI_SEARCH_MODELS = csv só para Google Search — no free tier só 2.5-*
  /// têm Search; 3.x devolve 429 sem billing.
  /// String vazia ≡ ausente — senão `GEMINI_API_KEYS=` bloqueia o fallback
  /// para `GEMINI_API_KEY` via `??`.
  GEMINI_API_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
  GEMINI_API_KEYS: z.string().optional().transform((value) => value?.trim() || undefined),
  GEMINI_PAID_API_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
  LLM_VISION_EVALUATION: z.enum(["0", "1"]).optional(),
  GEMINI_SEARCH_MODELS: z.string().optional().transform((value) => value?.trim() || undefined),
  LLM_OCR_CACHE: z.enum(["0", "1"]).optional(),
  /// Tira modelos do catálogo da cascata sem deploy: csv de `provedor/modelo`.
  /// Só remove; nunca acrescenta nem reordena.
  LLM_MODELS_DISABLED: z.string().optional().transform((value) => value?.trim() || undefined),
  /// Fallbacks após Gemini esgotar (parse + JSON estruturado).
  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.string().optional(),
  LLM_DISABLE_GROQ: z.enum(["0", "1"]).optional(),
  MISTRAL_API_KEY: z.string().optional(),
  /** Restrict all Mistral image routes to the qualified compact-slip profile. */
  MISTRAL_CHAT_NARROW_ONLY: z.enum(["0", "1"]).optional(),
  MISTRAL_BASE_URL: z.string().optional(),
  LLM_DISABLE_MISTRAL: z.enum(["0", "1"]).optional(),
  /// Desliga o chat da Mistral e deixa só o OCR anotado.
  LLM_DISABLE_MISTRAL_CHAT: z.enum(["0", "1"]).optional(),
  /// BridgeOdds: a abertura, a reserva do fechamento e a identidade do jogo
  /// que a Pinnacle17 não acha. String vazia equivale a ausente em dev; em
  /// produção o bloco fail-fast abaixo exige o trio completo.
  BRIDGEODDS_URL: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().url().optional(),
  ),
  BRIDGEODDS_USER: z.string().optional().transform((value) => value?.trim() || undefined),
  BRIDGEODDS_PASS: z.string().optional().transform((value) => value?.trim() || undefined),
  BRIDGEODDS_MAX_BET_CURRENCY: optionalIsoCurrency,
  /// pinnacle17 via RapidAPI: Pinnacle pré-jogo com identidade canônica,
  /// preço atual e maxRiskStake. Não expõe histórico nem resultado autorizado.
  PINNACLE17_RAPIDAPI_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
  PINNACLE17_MODE: providerMode,
  PINNACLE17_MAX_BET_CURRENCY: optionalIsoCurrency,
  /// FlashScore via RapidAPI: única fonte externa de resultado. `on` observa
  /// e liquida por placar/estatística as apostas pendentes de todas as bancas;
  /// `off` desliga o provider, que é o padrão de dev, testes e E2E.
  FLASHSCORE_API_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
  FLASHSCORE_MODE: providerMode,
  /// DMs aceitas pelo bot (csv de chat ids). Vazio = DM desabilitada.
  TELEGRAM_ALLOWED_CHATS: z.string().optional(),
  /// Diretório durável das logos (produção: repo, não o bundle standalone).
  LOGOS_DIR: z.string().optional(),
  /// Auth do painel: "user:scrypt-hash:role" separados por vírgula + segredo
  /// HMAC da sessão. Obrigatórios em produção (fail-fast no boot, não no
  /// primeiro request).
  AUTH_USERS: z.string().optional(),
  AUTH_SESSION_SECRET: z.string().min(32, "AUTH_SESSION_SECRET precisa de ≥32 chars").optional(),
  /// Treino de identidade (tunáveis SEM deploy). Score-textual
  /// (soma das similaridades home+away, 0–2) MÍNIMO para AUTO-aplicar um match
  /// sozinho; entre o piso de candidato (0.7) e este valor fica a ZONA CINZENTA
  /// que o LLM-judge decide. E a confiança mínima do veredito do juiz p/ aplicar.
  // 1.5 ≈ um lado EXATO + outro com typo moderado ("AC Connecticut" + "Vermont
  // Grenn"→"Green" = 1.548 → AUTO). Abaixo disso (um time mal casado) o juiz revisa.
  SHARP_AUTO_MATCH_MIN_SCORE: z.coerce.number().min(0.7).max(2).default(1.5),
  SHARP_JUDGE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
}).superRefine((env, ctx) => {
  if (env.PINNACLE17_MODE !== "off" && !env.PINNACLE17_RAPIDAPI_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["PINNACLE17_RAPIDAPI_KEY"],
      message: "obrigatória quando PINNACLE17_MODE não é off",
    });
  }
  if (env.FLASHSCORE_MODE !== "off" && !env.FLASHSCORE_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["FLASHSCORE_API_KEY"],
      message: "obrigatória quando FLASHSCORE_MODE não é off",
    });
  }
  const isWebProcess = env.AUTOMABACA_PROCESS === "web";
  if (!isWebProcess && Boolean(env.TELEGRAM_WEBHOOK_URL) !== Boolean(env.TELEGRAM_WEBHOOK_SECRET)) {
    ctx.addIssue({
      code: "custom",
      path: ["TELEGRAM_WEBHOOK_URL"],
      message: "TELEGRAM_WEBHOOK_URL e TELEGRAM_WEBHOOK_SECRET devem ser configurados juntos",
    });
  } else if (!isWebProcess && env.TELEGRAM_TOKEN && !env.TELEGRAM_WEBHOOK_URL) {
    // O webhook é a única entrada dos updates.
    ctx.addIssue({
      code: "custom",
      path: ["TELEGRAM_WEBHOOK_URL"],
      message: "TELEGRAM_WEBHOOK_URL e TELEGRAM_WEBHOOK_SECRET são obrigatórios com TELEGRAM_TOKEN",
    });
  } else if (isWebProcess && env.TELEGRAM_WEBHOOK_URL && !env.TELEGRAM_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["TELEGRAM_WEBHOOK_SECRET"],
      message: "TELEGRAM_WEBHOOK_SECRET é obrigatório quando TELEGRAM_WEBHOOK_URL está configurado",
    });
  }
  if (env.NODE_ENV === "production" && env.TELEGRAM_WEBHOOK_URL && !env.TELEGRAM_WEBHOOK_URL.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["TELEGRAM_WEBHOOK_URL"], message: "webhook exige HTTPS em produção" });
  }
  if (env.NODE_ENV !== "production") return;
  const isWeb = env.AUTOMABACA_PROCESS !== "worker";
  const isWorker = env.AUTOMABACA_PROCESS !== "web";
  if (isWeb && !env.AUTH_USERS) {
    ctx.addIssue({ code: "custom", path: ["AUTH_USERS"], message: "obrigatória em produção (painel sem auth nunca sobe aberto)" });
  } else if (isWeb && env.AUTH_USERS && !validAuthUsers(env.AUTH_USERS)) {
    ctx.addIssue({
      code: "custom",
      path: ["AUTH_USERS"],
      message: "formato inválido; use user:scrypt$salt$hashhex[:role]",
    });
  }
  if (isWeb && !env.AUTH_SESSION_SECRET) {
    ctx.addIssue({ code: "custom", path: ["AUTH_SESSION_SECRET"], message: "obrigatória em produção (sessões HMAC)" });
  }
  if (isWeb && !env.PUBLIC_APP_URL) {
    ctx.addIssue({ code: "custom", path: ["PUBLIC_APP_URL"], message: "obrigatória em produção (origin canônico do painel)" });
  } else if (isWeb && env.PUBLIC_APP_URL && !env.PUBLIC_APP_URL.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["PUBLIC_APP_URL"], message: "exige HTTPS em produção" });
  }
  if (isWeb && !env.LOGOS_DIR) {
    ctx.addIssue({
      code: "custom",
      path: ["LOGOS_DIR"],
      message: "obrigatória em produção (uploads precisam de storage privado durável)",
    });
  } else if (isWeb && env.LOGOS_DIR) {
    const logosDir = path.normalize(env.LOGOS_DIR);
    const publicDir = path.join(process.cwd(), "public");
    if (!path.isAbsolute(env.LOGOS_DIR) || logosDir === publicDir || logosDir.startsWith(`${publicDir}${path.sep}`)) {
      ctx.addIssue({
        code: "custom",
        path: ["LOGOS_DIR"],
        message: "precisa ser absoluto e ficar fora de public/",
      });
    }
  }
  if (!env.LOG_HASH_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["LOG_HASH_SECRET"],
      message: "obrigatória em produção (pseudonimização de logs)",
    });
  }
  // Sem token o worker sobe “ok” mas a captura de canais/DM fica morta —
  // fail-fast no boot em produção.
  if (isWorker && !env.TELEGRAM_TOKEN) {
    ctx.addIssue({
      code: "custom",
      path: ["TELEGRAM_TOKEN"],
      message: "obrigatória em produção (worker sem bot = captura morta)",
    });
  }
  // Sem bot de alerta, DLQ/drift/IA-Judge “alertam” só no log — fail-loud
  // operacional exige o canal em production.
  if (isWorker && !env.TELEGRAM_NOTIFICATION_BOT_TOKEN) {
    ctx.addIssue({
      code: "custom",
      path: ["TELEGRAM_NOTIFICATION_BOT_TOKEN"],
      message: "obrigatória em produção (alertas operacionais)",
    });
  }
  if (isWorker && !env.TELEGRAM_NOTIFICATION_CHAT_ID) {
    ctx.addIssue({
      code: "custom",
      path: ["TELEGRAM_NOTIFICATION_CHAT_ID"],
      message: "obrigatória em produção (alertas operacionais)",
    });
  }
  // O worker de produção sem FlashScore não liquida nada sozinho, e sem
  // Pinnacle17 perde identidade, kickoff e closing de reserva. A variável que
  // some do runtime.env cai no default `off` em silêncio; aqui o boot falha.
  if (isWorker) {
    for (const key of ["FLASHSCORE_MODE", "PINNACLE17_MODE"] as const) {
      if (env[key] === "off") {
        ctx.addIssue({ code: "custom", path: [key], message: "precisa ser on no worker de produção" });
      }
    }
  }
  // Só a BridgeOdds dá a abertura, e ela é a segunda tentativa de identidade
  // e fechamento quando a Pinnacle17 não acha o jogo.
  if (!env.BRIDGEODDS_URL || !env.BRIDGEODDS_USER || !env.BRIDGEODDS_PASS) {
    ctx.addIssue({
      code: "custom",
      path: ["BRIDGEODDS_URL"],
      message: "BRIDGEODDS_URL/USER/PASS obrigatórios em produção (abertura e reserva do fechamento)",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Variáveis de ambiente inválidas:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCacheForTests(): void {
  cached = null;
}

/**
 * `TELEGRAM_ALLOWED_CHATS`, lido a cada chamada (o bot é um processo longo).
 * `chats`: toda DM aceita. `users`: os ids pessoais (positivos), na ordem da
 * variável; são os autorizados a reagir e o primeiro deles é o dono, a quem
 * vale a reação anônima do canal.
 */
export function telegramAllowedChats(): { chats: Set<string>; users: string[] } {
  const chats = (getEnv().TELEGRAM_ALLOWED_CHATS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return { chats: new Set(chats), users: chats.filter((id) => /^[1-9]\d*$/.test(id)) };
}

/** O dono: o primeiro id pessoal de `TELEGRAM_ALLOWED_CHATS` (a DM dele com o bot principal). */
export function telegramOwnerId(): string | null {
  return telegramAllowedChats().users[0] ?? null;
}
