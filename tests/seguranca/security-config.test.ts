import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import { buildContentSecurityPolicy, proxy } from "@/proxy";
import { ALLOWLIST, ambientesDeProducao } from "@/deploy/env-allowlist.cjs";

describe("headers de segurança", () => {
  it("aplica headers estáticos de defesa em profundidade", async () => {
    const entries = await nextConfig.headers?.();
    const headers = entries?.[0]?.headers ?? [];
    expect(headers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "X-Content-Type-Options", value: "nosniff" }),
      expect.objectContaining({ key: "X-Frame-Options", value: "DENY" }),
      expect.objectContaining({ key: "Permissions-Policy" }),
      expect.objectContaining({ key: "Cross-Origin-Opener-Policy", value: "same-origin" }),
      expect.objectContaining({ key: "Cross-Origin-Embedder-Policy", value: "require-corp" }),
      expect.objectContaining({ key: "Cross-Origin-Resource-Policy", value: "same-origin" }),
    ]));
  });

  it("acomoda logo de 2 MiB sem abrir body ilimitado nas Server Actions", () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe("3mb");
  });

  it("gera CSP estrita com nonce e exceção limitada a atributos de estilo", () => {
    const csp = buildContentSecurityPolicy("nonce-de-teste");
    expect(csp).toContain("script-src 'self' 'nonce-nonce-de-teste' 'strict-dynamic'");
    expect(csp).toContain("style-src 'self' 'nonce-nonce-de-teste'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp.match(/unsafe-inline/g)).toHaveLength(1);
    expect(csp.match(/script-src[^;]*/)?.[0]).not.toContain("unsafe-inline");
    expect(csp.match(/style-src [^;]*/)?.[0]).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("libera unsafe-eval somente no desenvolvimento", () => {
    expect(buildContentSecurityPolicy("dev", true)).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy("prod", false)).not.toContain("'unsafe-eval'");
  });

  it("deixa o webhook exato chegar à autenticação própria, sem liberar prefixos", async () => {
    const webhook = await proxy(new NextRequest("https://example.test/api/telegram/webhook", {
      method: "POST",
    }));
    const lookalike = await proxy(new NextRequest("https://example.test/api/telegram/webhook/debug", {
      method: "POST",
    }));

    expect(webhook.headers.get("x-middleware-next")).toBe("1");
    expect(webhook.headers.get("x-correlation-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(lookalike.headers.get("x-middleware-next")).not.toBe("1");
  });

  it("libera somente os assets PWA exatos antes do login", async () => {
    for (const path of [
      "/icon.svg",
      "/manifest.webmanifest",
      "/sw.js",
      "/pwa-icon-192.png",
      "/pwa-icon-512.png",
      "/pwa-icon-maskable-512.png",
    ]) {
      const response = await proxy(new NextRequest(`https://example.test${path}`));
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
    const lookalike = await proxy(new NextRequest("https://example.test/sw.js/debug"));
    expect(lookalike.headers.get("x-middleware-next")).not.toBe("1");
  });

  it("publica apenas o robots.txt entre os metadados de crawler", async () => {
    const robots = await proxy(new NextRequest("https://example.test/robots.txt"));
    const sitemap = await proxy(new NextRequest("https://example.test/sitemap.xml"));
    expect(robots.headers.get("x-middleware-next")).toBe("1");
    expect(sitemap.headers.get("x-middleware-next")).not.toBe("1");
  });

  it.each(["", "x", "0", "1", "action"])("rejeita referência de ação malformada %j antes do Next", async (actionId) => {
    const response = await proxy(new NextRequest("https://example.test/login", {
      method: "POST", headers: { "next-action": actionId },
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src");
    expect(response.headers.get("x-correlation-id")).toBeTruthy();
  });

  it("deixa o Next validar referências com o formato esperado", async () => {
    const response = await proxy(new NextRequest("https://example.test/login", {
      method: "POST", headers: { "next-action": "a".repeat(42) },
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("isolamento do runtime", () => {
  it("web/worker recebem allowlists distintas na configuração consumida pelo Docker", () => {
    // O que este teste guarda é a SEPARAÇÃO dos papéis; a leitura do arquivo e
    // a recusa do shell estão em tests/plataforma/runtime-env.test.ts.
    const { web, worker } = ambientesDeProducao({
      AUTH_USERS: "test-user:test-hash:admin",
      TELEGRAM_TOKEN: "test-telegram-token",
      TELEGRAM_WEBHOOK_URL: "https://example.test/api/telegram/webhook",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
      GEMINI_API_KEYS: "must-not-reach-web",
      GROQ_API_KEY: "must-not-reach-web",
      MISTRAL_API_KEY: "must-not-reach-web",
      PINNACLE17_RAPIDAPI_KEY: "must-not-reach-web",
      PINNACLE17_MODE: "on",
      FLASHSCORE_API_KEY: "must-not-reach-web",
      FLASHSCORE_MODE: "on",
      BRIDGEODDS_USER: "bridge-user",
      BRIDGEODDS_PASS: "bridge-pass",
      LLM_MODELS_DISABLED: "groq/qwen/qwen3.8-27b",
      BACKUP_ENCRYPTION_KEY: "must-not-leak",
      BACKUP_DRIVE_TOKEN: "must-not-leak",
      DATABASE_URL_ADMIN: "postgresql://admin-must-not-leak@db/automabaca",
    });
    expect(web.AUTH_USERS).toBeTruthy();
    expect(web.TELEGRAM_TOKEN).toBeUndefined();
    expect(web.GEMINI_API_KEYS).toBeUndefined();
    expect(web.GROQ_API_KEY).toBeUndefined();
    expect(web.MISTRAL_API_KEY).toBeUndefined();
    // Só o worker consulta a Pinnacle17 e o FlashScore; o modo sai da web junto com a chave.
    for (const chave of ["PINNACLE17_RAPIDAPI_KEY", "PINNACLE17_MODE", "FLASHSCORE_API_KEY", "FLASHSCORE_MODE"]) {
      expect(web[chave], chave).toBeUndefined();
    }
    // O botão "Odds fechamento" consulta a BridgeOdds dentro da web.
    expect(web).toMatchObject({ BRIDGEODDS_USER: "bridge-user", BRIDGEODDS_PASS: "bridge-pass" });
    // A alavanca de exclusão de modelos chega aos dois: o card lê na web.
    expect(web.LLM_MODELS_DISABLED).toBe("groq/qwen/qwen3.8-27b");
    expect(worker.LLM_MODELS_DISABLED).toBe("groq/qwen/qwen3.8-27b");
    expect(web.TELEGRAM_WEBHOOK_URL).toBeTruthy();
    expect(web.TELEGRAM_WEBHOOK_SECRET).toBeTruthy();
    expect(worker.TELEGRAM_TOKEN).toBeTruthy();
    expect(worker.GEMINI_API_KEYS).toBe("must-not-reach-web");
    expect(worker.GROQ_API_KEY).toBe("must-not-reach-web");
    expect(worker.MISTRAL_API_KEY).toBe("must-not-reach-web");
    expect(worker).toMatchObject({ PINNACLE17_RAPIDAPI_KEY: "must-not-reach-web", PINNACLE17_MODE: "on",
      FLASHSCORE_API_KEY: "must-not-reach-web", FLASHSCORE_MODE: "on", BRIDGEODDS_PASS: "bridge-pass" });
    expect(worker.AUTH_USERS).toBeUndefined();
    for (const env of [web, worker]) {
      expect(env.BACKUP_ENCRYPTION_KEY).toBeUndefined();
      expect(env.BACKUP_DRIVE_TOKEN).toBeUndefined();
      expect(env.DATABASE_URL_ADMIN).toBeUndefined();
    }
  });

  it("usa o parser dotenv nativo do Node ao gerar os ambientes", async () => {
    const splitEnv = await readFile(new URL("../../deploy/split-env.cjs", import.meta.url), "utf8");
    expect(splitEnv).toContain('require("node:util")');
    expect(splitEnv).toContain("parseEnv(fs.readFileSync");
    expect(splitEnv).not.toContain("raw.replace(/\\s+#.*$/");
  });

  it("webhook isola o token no worker", async () => {
    const route = await readFile(new URL("../../app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
    expect(route).toContain("x-telegram-bot-api-secret-token");
    expect(route).not.toContain("TELEGRAM_TOKEN");
    expect(ALLOWLIST.web).toEqual(expect.arrayContaining(["TELEGRAM_WEBHOOK_URL", "TELEGRAM_WEBHOOK_SECRET"]));
    expect(ALLOWLIST.web).not.toContain("TELEGRAM_TOKEN");
  });

  it("remove arquivos de ambiente antes de empacotar o standalone", async () => {
    const prepare = await readFile(new URL("../../scripts/prepare-standalone.mjs", import.meta.url), "utf8");
    expect(prepare).toContain('[".env", ".env.production"]');
    expect(prepare).toContain('rmSync(path.join(root, fileName), { force: true })');
  });

  it("preparo do browser recusa banco que não seja isolado para E2E", async () => {
    const setup = await readFile(
      new URL("../../scripts/init-browser-test-db.mjs", import.meta.url),
      "utf8",
    );
    expect(setup).toContain("(?:^|_)e2e(?:_|$)");
    expect(setup.indexOf("Banco recusado")).toBeLessThan(setup.indexOf("new PgBoss"));
    expect(setup.indexOf("Banco recusado")).toBeLessThan(setup.indexOf("new Client"));
    expect(setup).toContain("TRUNCATE TABLE");
    expect(setup).toContain("table_name <> '_prisma_migrations'");

    const runner = await readFile(
      new URL("../../scripts/run-browser-suite.sh", import.meta.url),
      "utf8",
    );
    expect(runner).toContain("flock -n 9");
  });

  it("gera ambiente mínimo sem entregar segredos de backup ao app", async () => {
    const splitEnv = await readFile(new URL("../../deploy/split-env.cjs", import.meta.url), "utf8");
    const todas = [...ALLOWLIST.web, ...ALLOWLIST.worker];
    for (const chave of ["TELEGRAM_WEBHOOK_SECRET", "LOG_HASH_SECRET"]) {
      expect(ALLOWLIST.web).toContain(chave);
      expect(ALLOWLIST.worker).toContain(chave);
    }
    expect(todas.filter((chave) => chave.startsWith("BACKUP_"))).toEqual([]);
    expect(todas).not.toContain("DATABASE_URL_ADMIN");
    // Configuração vem só do arquivo auditado, nunca do shell de quem gerou.
    expect(splitEnv).not.toMatch(/\.\.\.process\.env/);
  });
});
