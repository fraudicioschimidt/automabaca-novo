import { execFileSync } from "node:child_process";
import { scryptSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";
import { ALLOWLIST, FIXAS, SO_NO_RUNTIME_ENV } from "@/deploy/env-allowlist.cjs";
import { authenticate, parseAuthUsers } from "@/src/infra/auth";
import { getEnv, resetEnvCacheForTests } from "@/src/infra/env";

const RAIZ = path.resolve(__dirname, "../..");
const SPLIT_ENV = path.join(RAIZ, "deploy", "split-env.cjs");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) safeRemoveTreeSync(tmpdir(), dir);
});

/** Chaves do schema de `src/infra/env.ts`, lidas do fonte (o schema não é exportado). */
function chavesDoSchema(): string[] {
  const fonte = readFileSync(path.join(RAIZ, "src", "infra", "env.ts"), "utf8");
  return [...fonte.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);
}

function executarSplitEnv(runtimeEnv: string, shell: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "automabaca-split-env-"));
  dirs.push(dir);
  const origem = path.join(dir, "runtime.env");
  writeFileSync(origem, runtimeEnv);
  execFileSync(process.execPath, [SPLIT_ENV], {
    // Ambiente limpo, como o `sudo` deixa: só o que o teste passar.
    env: { PATH: process.env.PATH ?? "", ...shell, AUTOMABACA_ENV_FILE: origem, AUTOMABACA_ENV_OUT_DIR: dir } as unknown as NodeJS.ProcessEnv,
    stdio: "pipe",
  });
  return dir;
}

/** Roda o split-env de verdade, como no servidor, e lê os arquivos no formato `raw` do compose. */
function rodarSplitEnv(runtimeEnv: string, shell: Record<string, string> = {}) {
  const dir = executarSplitEnv(runtimeEnv, shell);
  const ler = (papel: "web" | "worker") => {
    const arquivo = path.join(dir, `${papel}.env`);
    const texto = readFileSync(arquivo, "utf8");
    // `format: raw`: tudo depois do primeiro `=` é o valor, sem aspas nem escapes.
    const env = Object.fromEntries(texto.trimEnd().split("\n").map((linha) => {
      const i = linha.indexOf("=");
      return [linha.slice(0, i), linha.slice(i + 1)];
    }));
    return { env, texto, modo: statSync(arquivo).mode & 0o777 };
  };
  return { web: ler("web"), worker: ler("worker") };
}

describe("ambiente de produção (deploy/env-allowlist.cjs + split-env)", () => {
  /**
   * Chave do schema fora da allowlist chega ao runtime.env e morre no
   * split-env: o processo roda com o default do schema (o modo do resolvedor,
   * por exemplo, nunca sairia de `shadow` em produção). O inverso também é
   * defeito: chave na allowlist que nenhum código lê é configuração morta.
   */
  it("a allowlist e o schema de env.ts listam as mesmas chaves", () => {
    const schema = chavesDoSchema();
    const entregues = new Set([
      ...ALLOWLIST.web, ...ALLOWLIST.worker,
      ...Object.keys(FIXAS.web), ...Object.keys(FIXAS.worker),
    ]);
    // Lidas fora do schema (logger e /api/health), preenchidas pelo compose.
    const foraDoSchema = new Set(["AUTOMABACA_RELEASE_ID", "AUTOMABACA_RELEASE_SHA"]);

    expect(schema.length).toBeGreaterThan(40);
    expect(schema.filter((k) => !entregues.has(k)), "no schema, mas nenhum container recebe").toEqual([]);
    expect(
      [...new Set([...ALLOWLIST.web, ...ALLOWLIST.worker])]
        .filter((k) => !schema.includes(k) && !foraDoSchema.has(k)),
      "na allowlist, mas fora do schema",
    ).toEqual([]);
  });

  it("entrega cada chave da allowlist ao seu container, e nada além", () => {
    const todas = new Set([...ALLOWLIST.web, ...ALLOWLIST.worker, ...SO_NO_RUNTIME_ENV]);
    const runtime = [...todas, "BACKUP_DRIVE_TOKEN", "NODE_ENV", "LOGOS_DIR"]
      .map((k) => `${k}="valor-${k.toLowerCase()}"`).join("\n");
    const { web, worker } = rodarSplitEnv(runtime);

    for (const [papel, gerado] of [["web", web], ["worker", worker]] as const) {
      for (const k of ALLOWLIST[papel]) {
        expect(gerado.env[k], `${papel}.${k}`).toBe(`valor-${k.toLowerCase()}`);
      }
      const esperado = new Set([...ALLOWLIST[papel], ...Object.keys(FIXAS[papel]), "NEXT_TELEMETRY_DISABLED"]);
      expect(Object.keys(gerado.env).filter((k) => !esperado.has(k)), `${papel}: chaves fora da allowlist`).toEqual([]);
      for (const k of SO_NO_RUNTIME_ENV) expect(gerado.env[k], `${k} não pode ir para ${papel}`).toBeUndefined();
      expect(gerado.env.BACKUP_DRIVE_TOKEN).toBeUndefined();
      expect(gerado.env.NODE_ENV).toBe("production");
      expect(gerado.env.AUTOMABACA_PROCESS).toBe(papel);
      expect(gerado.modo).toBe(0o600);
    }
    expect(web.env.LOGOS_DIR).toBe("/data/logos");
    expect(web.env.PORT).toBe("3000");
  });

  /**
   * O schema de produção cobra de cada container o que ele usa. A chave de um
   * provedor que só o worker recebe leva o modo junto: a web com o modo `on` e
   * sem a chave não sobe.
   */
  it("cada container sobe com o que recebe de um runtime.env de produção completo", () => {
    const runtime = {
      DATABASE_URL: "postgresql://u:p@db/app",
      AUTH_USERS: `ops:scrypt$salt$${"a".repeat(64)}:admin`,
      AUTH_SESSION_SECRET: "s".repeat(32),
      PUBLIC_APP_URL: "https://painel.example.test",
      LOG_HASH_SECRET: "l".repeat(32),
      TELEGRAM_TOKEN: "123:ABC",
      TELEGRAM_WEBHOOK_URL: "https://painel.example.test/api/telegram/webhook",
      TELEGRAM_WEBHOOK_SECRET: "w".repeat(32),
      TELEGRAM_NOTIFICATION_BOT_TOKEN: "456:DEF",
      TELEGRAM_NOTIFICATION_CHAT_ID: "99",
      BRIDGEODDS_URL: "https://bridge.example.test",
      BRIDGEODDS_USER: "usuario-bridge",
      BRIDGEODDS_PASS: "senha-bridge",
      PINNACLE17_MODE: "on",
      PINNACLE17_RAPIDAPI_KEY: "chave-pinnacle17",
      FLASHSCORE_MODE: "on",
      FLASHSCORE_API_KEY: "chave-flashscore",
    };
    const gerados = rodarSplitEnv(Object.entries(runtime).map(([k, v]) => `${k}="${v}"`).join("\n"));
    const original = process.env;
    const bootar = (papel: "web" | "worker") => {
      process.env = { ...gerados[papel].env } as unknown as NodeJS.ProcessEnv;
      resetEnvCacheForTests();
      return getEnv();
    };
    try {
      const worker = bootar("worker");
      expect(worker).toMatchObject({ PINNACLE17_MODE: "on", FLASHSCORE_MODE: "on",
        PINNACLE17_RAPIDAPI_KEY: "chave-pinnacle17", FLASHSCORE_API_KEY: "chave-flashscore" });
      const web = bootar("web");
      expect(web).toMatchObject({ PINNACLE17_MODE: "off", FLASHSCORE_MODE: "off", BRIDGEODDS_PASS: "senha-bridge" });
      expect(web.PINNACLE17_RAPIDAPI_KEY).toBeUndefined();
      expect(web.FLASHSCORE_API_KEY).toBeUndefined();
    } finally {
      process.env = original;
      resetEnvCacheForTests();
    }
  });

  it("as listas de modelo saíram do env: nenhum container as recebe, mesmo com as chaves antigas no runtime.env", () => {
    const antigas = ["GEMINI_MODELS", "GEMINI_VISION_MODELS", "GROQ_VISION_MODEL", "MISTRAL_VISION_MODELS", "MISTRAL_OCR_MODELS"];
    const { web, worker } = rodarSplitEnv(['DATABASE_URL="postgresql://u:p@db/app"', ...antigas.map((k) => `${k}="modelo-antigo"`)].join("\n"));
    for (const gerado of [web, worker]) {
      for (const k of antigas) expect(gerado.env, k).not.toHaveProperty(k);
      expect(gerado.env.DATABASE_URL).toBe("postgresql://u:p@db/app");
    }
  });

  it("o worker não recebe o spool em disco, mesmo com a chave antiga no runtime.env", () => {
    const { worker } = rodarSplitEnv('DATABASE_URL="postgresql://u:p@db/app"\nTELEGRAM_SPOOL_DIR="/data/spool"\n');
    expect(worker.env).not.toHaveProperty("TELEGRAM_SPOOL_DIR");
    expect(worker.env.DATABASE_URL).toBe("postgresql://u:p@db/app");
  });

  /**
   * Config que NÃO está no arquivo auditado não pode entrar no container só
   * porque estava no shell de quem gerou os arquivos: um `export` numa sessão
   * de debug viraria configuração permanente e invisível. A release
   * (`AUTOMABACA_RELEASE_*`) vem do compose.
   */
  it("não deixa o shell de quem chamou injetar config fora do arquivo", () => {
    const { web, worker } = rodarSplitEnv('DATABASE_URL="postgresql://u:p@db/app"\n', {
      GEMINI_API_KEY: "chave-de-sessao-de-debug",
      TELEGRAM_TOKEN: "token-do-shell",
      AUTOMABACA_RELEASE_SHA: "sha-do-shell",
    });
    for (const gerado of [web, worker]) {
      expect(gerado.env.GEMINI_API_KEY).toBeUndefined();
      expect(gerado.env.TELEGRAM_TOKEN).toBeUndefined();
      expect(gerado.env.AUTOMABACA_RELEASE_SHA).toBeUndefined();
      expect(gerado.env.DATABASE_URL).toBe("postgresql://u:p@db/app");
    }
  });

  it("preserva um hash scrypt do runtime.env até o login do painel", async () => {
    const password = "senha-de-teste";
    const salt = "00112233445566778899aabbccddeeff";
    const hash = scryptSync(password, salt, 64).toString("hex");
    const stored = `scrypt$${salt}$${hash}`;
    const { web } = rodarSplitEnv(`AUTH_USERS="fabricio:${stored}:admin"\n`);

    const users = parseAuthUsers(web.env.AUTH_USERS);
    expect(users).toHaveLength(1);
    expect(users[0]?.passwordHash).toBe(stored);
    expect((await authenticate("fabricio", password, users))?.username).toBe("fabricio");
  });

  it("recusa valor multilinha sem gravar nenhum dos dois arquivos", () => {
    // TELEGRAM_TOKEN vai só ao worker, gravado depois da web: a web não pode sair antes da recusa.
    expect(() => executarSplitEnv('DATABASE_URL="a"\nTELEGRAM_TOKEN="x\ny"\n')).toThrow(/multiline/);
    const dir = dirs.at(-1)!;
    expect(existsSync(path.join(dir, "web.env"))).toBe(false);
    expect(existsSync(path.join(dir, "worker.env"))).toBe(false);
  });
});
