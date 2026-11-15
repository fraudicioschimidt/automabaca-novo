import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { getEnv, resetEnvCacheForTests } from "@/src/infra/env";

const env = process.env as Record<string, string | undefined>;
const ORIGINAL_DATABASE_URL = env.DATABASE_URL;
const ORIGINAL_NODE_ENV = env.NODE_ENV;
const ORIGINAL_AUTH_USERS = env.AUTH_USERS;
const ORIGINAL_AUTH_SESSION_SECRET = env.AUTH_SESSION_SECRET;
const ORIGINAL_PUBLIC_APP_URL = env.PUBLIC_APP_URL;
const ORIGINAL_LOG_HASH_SECRET = env.LOG_HASH_SECRET;
const ORIGINAL_TELEGRAM_TOKEN = env.TELEGRAM_TOKEN;
const ORIGINAL_NOTIFY_TOKEN = env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
const ORIGINAL_NOTIFY_CHAT = env.TELEGRAM_NOTIFICATION_CHAT_ID;
const ORIGINAL_BRIDGE_URL = env.BRIDGEODDS_URL;
const ORIGINAL_BRIDGE_USER = env.BRIDGEODDS_USER;
const ORIGINAL_BRIDGE_PASS = env.BRIDGEODDS_PASS;
const ORIGINAL_BRIDGE_MAX_BET_CURRENCY = env.BRIDGEODDS_MAX_BET_CURRENCY;
const ORIGINAL_PINNACLE17_KEY = env.PINNACLE17_RAPIDAPI_KEY;
const ORIGINAL_PINNACLE17_MODE = env.PINNACLE17_MODE;
const ORIGINAL_PINNACLE17_MAX_BET_CURRENCY = env.PINNACLE17_MAX_BET_CURRENCY;
const ORIGINAL_WEBHOOK_URL = env.TELEGRAM_WEBHOOK_URL;
const ORIGINAL_WEBHOOK_SECRET = env.TELEGRAM_WEBHOOK_SECRET;
const ORIGINAL_FLASHSCORE_KEY = env.FLASHSCORE_API_KEY;
const ORIGINAL_FLASHSCORE_MODE = env.FLASHSCORE_MODE;
const ORIGINAL_LOGOS_DIR = env.LOGOS_DIR;
const ORIGINAL_PROCESS = env.AUTOMABACA_PROCESS;

function restore(key: string, original: string | undefined) {
  if (original === undefined) delete env[key];
  else env[key] = original;
}

afterEach(() => {
  env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  env.NODE_ENV = ORIGINAL_NODE_ENV;
  restore("AUTH_USERS", ORIGINAL_AUTH_USERS);
  restore("AUTH_SESSION_SECRET", ORIGINAL_AUTH_SESSION_SECRET);
  restore("PUBLIC_APP_URL", ORIGINAL_PUBLIC_APP_URL);
  restore("LOG_HASH_SECRET", ORIGINAL_LOG_HASH_SECRET);
  restore("TELEGRAM_TOKEN", ORIGINAL_TELEGRAM_TOKEN);
  restore("TELEGRAM_NOTIFICATION_BOT_TOKEN", ORIGINAL_NOTIFY_TOKEN);
  restore("TELEGRAM_NOTIFICATION_CHAT_ID", ORIGINAL_NOTIFY_CHAT);
  restore("BRIDGEODDS_URL", ORIGINAL_BRIDGE_URL);
  restore("BRIDGEODDS_USER", ORIGINAL_BRIDGE_USER);
  restore("BRIDGEODDS_PASS", ORIGINAL_BRIDGE_PASS);
  restore("BRIDGEODDS_MAX_BET_CURRENCY", ORIGINAL_BRIDGE_MAX_BET_CURRENCY);
  restore("PINNACLE17_RAPIDAPI_KEY", ORIGINAL_PINNACLE17_KEY);
  restore("PINNACLE17_MODE", ORIGINAL_PINNACLE17_MODE);
  restore("PINNACLE17_MAX_BET_CURRENCY", ORIGINAL_PINNACLE17_MAX_BET_CURRENCY);
  restore("TELEGRAM_WEBHOOK_URL", ORIGINAL_WEBHOOK_URL);
  restore("TELEGRAM_WEBHOOK_SECRET", ORIGINAL_WEBHOOK_SECRET);
  restore("FLASHSCORE_API_KEY", ORIGINAL_FLASHSCORE_KEY);
  restore("FLASHSCORE_MODE", ORIGINAL_FLASHSCORE_MODE);
  delete env.RETIRED_MODE_FOR_TEST;
  restore("LOGOS_DIR", ORIGINAL_LOGOS_DIR);
  restore("AUTOMABACA_PROCESS", ORIGINAL_PROCESS);
  resetEnvCacheForTests();
});

function setProdAuthTelegram() {
  env.NODE_ENV = "production";
  env.AUTH_USERS = `ops:scrypt$salt$${"a".repeat(64)}:admin`;
  env.AUTH_SESSION_SECRET = "x".repeat(32);
  env.PUBLIC_APP_URL = "https://v2.example.test";
  env.LOG_HASH_SECRET = "l".repeat(32);
  env.TELEGRAM_TOKEN = "123:ABC";
  env.TELEGRAM_WEBHOOK_URL = "https://v2.example.test/api/telegram/webhook";
  env.TELEGRAM_WEBHOOK_SECRET = "w".repeat(32);
  env.TELEGRAM_NOTIFICATION_BOT_TOKEN = "n:tok";
  env.TELEGRAM_NOTIFICATION_CHAT_ID = "99";
  env.BRIDGEODDS_URL = "https://bridge.test";
  env.BRIDGEODDS_USER = "u";
  env.BRIDGEODDS_PASS = "p";
  env.LOGOS_DIR = "/var/lib/automabaca/logos";
  env.FLASHSCORE_MODE = "on";
  env.FLASHSCORE_API_KEY = "rapidapi-test";
  env.PINNACLE17_MODE = "on";
  env.PINNACLE17_RAPIDAPI_KEY = "pinnacle17-test-key";
}

describe("getEnv", () => {
  it("valida e aplica defaults", () => {
    resetEnvCacheForTests();
    const e = getEnv();
    expect(e.DATABASE_URL).toBeTruthy();
    expect(e.PORT).toBeGreaterThan(0);
    expect(e.DB_POOL_MAX).toBeGreaterThan(0);
    expect(e.PINNACLE17_MODE).toBe("off");
  });

  it("exige chave Pinnacle17 quando o modo está ligado", () => {
    env.PINNACLE17_MODE = "on";
    delete env.PINNACLE17_RAPIDAPI_KEY;
    resetEnvCacheForTests();
    expect(() => getEnv()).toThrow(/PINNACLE17_RAPIDAPI_KEY/);
    env.PINNACLE17_RAPIDAPI_KEY = "pinnacle17-test-key";
    resetEnvCacheForTests();
    expect(getEnv().PINNACLE17_MODE).toBe("on");
  });

  it("recusa fallback, o nome antigo de on", () => {
    for (const key of ["PINNACLE17_MODE", "FLASHSCORE_MODE"] as const) {
      resetEnvCacheForTests();
      env.PINNACLE17_RAPIDAPI_KEY = "pinnacle17-test-key";
      env.FLASHSCORE_API_KEY = "rapidapi-test";
      env[key] = "fallback";
      expect(() => getEnv()).toThrow(new RegExp(key));
      delete env[key];
    }
  });

  it("worker de produção não sobe com FlashScore ou Pinnacle17 desligados", () => {
    setProdAuthTelegram();
    env.AUTOMABACA_PROCESS = "worker";
    env.FLASHSCORE_API_KEY = "rapidapi-test";
    env.PINNACLE17_RAPIDAPI_KEY = "pinnacle17-test-key";
    for (const [flashscore, pinnacle] of [[undefined, "on"], ["on", "off"]] as const) {
      resetEnvCacheForTests();
      restore("FLASHSCORE_MODE", flashscore);
      env.PINNACLE17_MODE = pinnacle;
      expect(() => getEnv()).toThrow(flashscore ? /PINNACLE17_MODE/ : /FLASHSCORE_MODE/);
    }

    // Os runtime.env de produção: on nos dois.
    resetEnvCacheForTests();
    env.FLASHSCORE_MODE = "on";
    env.PINNACLE17_MODE = "on";
    expect(getEnv()).toMatchObject({ FLASHSCORE_MODE: "on", PINNACLE17_MODE: "on" });

    // Sem chave, ligado continua recusado.
    resetEnvCacheForTests();
    delete env.FLASHSCORE_API_KEY;
    expect(() => getEnv()).toThrow(/FLASHSCORE_API_KEY/);

    // A web de produção não consulta resultados: pode ficar sem os dois.
    resetEnvCacheForTests();
    env.AUTOMABACA_PROCESS = "web";
    env.FLASHSCORE_MODE = "off";
    env.PINNACLE17_MODE = "off";
    expect(() => getEnv()).not.toThrow();

    // Sem AUTOMABACA_PROCESS o processo é web e worker ao mesmo tempo.
    resetEnvCacheForTests();
    delete env.AUTOMABACA_PROCESS;
    expect(() => getEnv()).toThrow(/FLASHSCORE_MODE/);
  });

  it("falha alto com mensagem agregada quando DATABASE_URL falta", () => {
    resetEnvCacheForTests();
    delete env.DATABASE_URL;
    expect(() => getEnv()).toThrow(/DATABASE_URL/);
  });

  it("cacheia após a primeira validação", () => {
    resetEnvCacheForTests();
    const first = getEnv();
    const second = getEnv();
    expect(first).toBe(second);
  });

  it("em production exige TELEGRAM_TOKEN e bot de alerta", () => {
    resetEnvCacheForTests();
    setProdAuthTelegram();
    delete env.TELEGRAM_TOKEN;
    expect(() => getEnv()).toThrow(/TELEGRAM_TOKEN/);
  });

  it("em production exige TELEGRAM_NOTIFICATION_*", () => {
    resetEnvCacheForTests();
    setProdAuthTelegram();
    delete env.TELEGRAM_NOTIFICATION_BOT_TOKEN;
    delete env.TELEGRAM_NOTIFICATION_CHAT_ID;
    expect(() => getEnv()).toThrow(/TELEGRAM_NOTIFICATION/);
  });

  it("em production exige BridgeOdds", () => {
    resetEnvCacheForTests();
    setProdAuthTelegram();
    delete env.BRIDGEODDS_URL;
    delete env.BRIDGEODDS_USER;
    delete env.BRIDGEODDS_PASS;
    expect(() => getEnv()).toThrow(/BRIDGEODDS/);
  });

  it("em production exige segredo dedicado para pseudonimizar logs", () => {
    resetEnvCacheForTests();
    setProdAuthTelegram();
    delete env.LOG_HASH_SECRET;
    expect(() => getEnv()).toThrow(/LOG_HASH_SECRET/);
  });

  it("em production web valida AUTH_USERS e storage privado das logos no boot", () => {
    resetEnvCacheForTests();
    setProdAuthTelegram();
    env.AUTOMABACA_PROCESS = "web";
    env.AUTH_USERS = "ops:hash:admin";
    env.LOGOS_DIR = path.join(process.cwd(), "public", "logos");
    expect(() => getEnv()).toThrow(/AUTH_USERS|LOGOS_DIR/);
    delete env.AUTOMABACA_PROCESS;
  });

  it("em production web exige URL pública HTTPS", () => {
    resetEnvCacheForTests();
    setProdAuthTelegram();
    delete env.PUBLIC_APP_URL;
    expect(() => getEnv()).toThrow(/PUBLIC_APP_URL/);
    resetEnvCacheForTests();
    env.PUBLIC_APP_URL = "http://v2.example.test";
      expect(() => getEnv()).toThrow(/HTTPS/);
  });

  it("em production aceita quando AUTH + Telegram + alertas + Bridge estão ok", () => {
    resetEnvCacheForTests();
    setProdAuthTelegram();
    const parsed = getEnv();
    expect(parsed.TELEGRAM_TOKEN).toBe("123:ABC");
    expect(parsed.TELEGRAM_NOTIFICATION_CHAT_ID).toBe("99");
    expect(parsed.BRIDGEODDS_URL).toBe("https://bridge.test");
    expect(parsed.BRIDGEODDS_USER).toBe("u");
  });

  it("valida a URL do BridgeOdds antes do primeiro request", () => {
    resetEnvCacheForTests();
    env.BRIDGEODDS_URL = "bridge-sem-protocolo";
    expect(() => getEnv()).toThrow(/BRIDGEODDS_URL/);
  });

  it("normaliza moeda de maxBet e rejeita unidade que não seja ISO 4217", () => {
    resetEnvCacheForTests();
    env.BRIDGEODDS_MAX_BET_CURRENCY = " usd ";
    expect(getEnv().BRIDGEODDS_MAX_BET_CURRENCY).toBe("USD");

    resetEnvCacheForTests();
    env.BRIDGEODDS_MAX_BET_CURRENCY = "dolar";
    expect(() => getEnv()).toThrow(/BRIDGEODDS_MAX_BET_CURRENCY/);
  });

  it("exige URL e segredo do webhook juntos", () => {
    resetEnvCacheForTests();
    env.TELEGRAM_WEBHOOK_URL = "https://example.test/api/telegram/webhook";
    delete env.TELEGRAM_WEBHOOK_SECRET;
    expect(() => getEnv()).toThrow(/devem ser configurados juntos/);
  });

  it("worker com o bot exige o webhook: não há outra entrada de updates", () => {
    resetEnvCacheForTests();
    env.TELEGRAM_TOKEN = "123:ABC";
    delete env.TELEGRAM_WEBHOOK_URL;
    delete env.TELEGRAM_WEBHOOK_SECRET;
    expect(() => getEnv()).toThrow(/obrigatórios com TELEGRAM_TOKEN/);

    resetEnvCacheForTests();
    env.AUTOMABACA_PROCESS = "web";
    expect(() => getEnv()).not.toThrow();
    delete env.AUTOMABACA_PROCESS;
  });

  it("exige chave FlashScore somente quando o modo está ativo", () => {
    resetEnvCacheForTests();
    env.NODE_ENV = "test";
    env.FLASHSCORE_MODE = "on";
    delete env.FLASHSCORE_API_KEY;
    expect(() => getEnv()).toThrow(/FLASHSCORE_API_KEY/);

    resetEnvCacheForTests();
    env.FLASHSCORE_API_KEY = "rapidapi-test";
    expect(getEnv().FLASHSCORE_MODE).toBe("on");

    resetEnvCacheForTests();
    env.FLASHSCORE_MODE = "off";
    delete env.FLASHSCORE_API_KEY;
    expect(getEnv().FLASHSCORE_MODE).toBe("off");
  });

  it("recusa o modo shadow do FlashScore", () => {
    resetEnvCacheForTests();
    env.FLASHSCORE_MODE = "shadow";
    expect(() => getEnv()).toThrow(/FLASHSCORE_MODE/);
  });

  it("descarta variáveis que o schema não conhece", () => {
    // Um runtime.env que ainda traz uma variável retirada precisa continuar
    // subindo: o schema não é estrito.
    resetEnvCacheForTests();
    setProdAuthTelegram();
    env.RETIRED_MODE_FOR_TEST = "shadow";
    env.FLASHSCORE_MODE = "on";
    env.FLASHSCORE_API_KEY = "rapidapi-test";
    const parsed = getEnv();
    expect(parsed).not.toHaveProperty("RETIRED_MODE_FOR_TEST");
    expect(parsed.FLASHSCORE_MODE).toBe("on");
  });
});

describe("telegramAllowedChats", () => {
  it("todo chat aceita DM; os ids pessoais, na ordem, são os autorizados e o primeiro é o dono", async () => {
    const { telegramAllowedChats } = await import("@/src/infra/env");
    const original = env.TELEGRAM_ALLOWED_CHATS;
    try {
      env.TELEGRAM_ALLOWED_CHATS = " -100500, 222 ,111,, abc ";
      resetEnvCacheForTests();
      const allowed = telegramAllowedChats();
      expect([...allowed.chats]).toEqual(["-100500", "222", "111", "abc"]);
      expect(allowed.users).toEqual(["222", "111"]);
    } finally {
      restore("TELEGRAM_ALLOWED_CHATS", original);
      resetEnvCacheForTests();
    }
  });
});
