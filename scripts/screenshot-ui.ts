/* eslint-disable no-console -- script de verificação visual; saída é o produto */
import "dotenv/config";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { mintBrowserSessionCookie } from "@/scripts/lib/browser-session";

/**
 * Screenshots ad hoc do painel para inspeção visual. Aceita `next dev`; para a
 * homologação final, aponte para o standalone de produção:
 *
 *   npm run build
 *   PORT=3199 HOSTNAME=127.0.0.1 NODE_ENV=production AUTOMABACA_PROCESS=web node .next/standalone/server.js
 *   npx tsx scripts/screenshot-ui.ts [--base http://127.0.0.1:3199] [--out /tmp/automabaca-shots]
 *     [--theme dark|light|both] [--mobile] [paths...]
 *
 * Sem paths usa o conjunto padrão de páginas. Login é automático: cookie de
 * sessão assinado com AUTH_USERS/AUTH_SESSION_SECRET do .env.
 */

const PAGINAS_PADRAO = ["/", "/tipsters", "/contas", "/operacoes", "/ferramentas", "/config", "/login"];

type Opcoes = {
  base: string;
  out: string;
  temas: Array<"dark" | "light">;
  mobile: boolean;
  paths: string[];
};

function parseArgs(argv: string[]): Opcoes {
  const o: Opcoes = {
    base: "http://127.0.0.1:3199",
    out: "/tmp/automabaca-shots",
    temas: ["dark"],
    mobile: false,
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--base") o.base = argv[++i] ?? o.base;
    else if (a === "--out") o.out = argv[++i] ?? o.out;
    else if (a === "--mobile") o.mobile = true;
    else if (a === "--theme") {
      const t = argv[++i];
      o.temas = t === "both" ? ["dark", "light"] : t === "light" ? ["light"] : ["dark"];
    } else o.paths.push(a);
  }
  if (o.paths.length === 0) o.paths = [...PAGINAS_PADRAO];
  return o;
}

function nomeArquivo(p: string, tema: string, mobile: boolean): string {
  const slug = p === "/" ? "dashboard" : p.replace(/^\//, "").replace(/[/?&=]+/g, "-");
  return `${slug}--${tema}${mobile ? "--mobile" : ""}.png`;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const sessao = await mintBrowserSessionCookie({ userAgent: "AutomaBACA screenshot-ui", baseURL: o.base });
  mkdirSync(o.out, { recursive: true });

  const browser = await chromium.launch();
  let falhas = 0;
  try {
    for (const tema of o.temas) {
      const context = await browser.newContext({
        viewport: o.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      });
      await context.addCookies([
        ...sessao.cookies,
        { name: "theme", value: tema, url: o.base },
      ]);
      const page = await context.newPage();
      for (const p of o.paths) {
        const resp = await page.goto(`${o.base}${p}`, { waitUntil: "networkidle" });
        // Aguarda fontes, transições e desenho dos SVGs estabilizarem.
        await page.waitForTimeout(1700);
        const arquivo = path.join(o.out, nomeArquivo(p, tema, o.mobile));
        await page.screenshot({ path: arquivo, fullPage: true });
        const status = resp?.status() ?? 0;
        // O redirect do proxy para /login TERMINA em 200: checar só o status
        // deixava o script fotografar a tela de login e imprimir "ok" para
        // todas as páginas. A URL final é o que prova que a sessão valeu.
        const urlFinal = new URL(page.url());
        const caiuNoLogin = urlFinal.pathname === "/login" && p !== "/login";
        const ok = status === 200 && !caiuNoLogin;
        if (!ok) falhas++;
        const motivo = caiuNoLogin ? "SEM SESSÃO (caiu em /login)" : `HTTP ${status}`;
        console.log(`${ok ? "ok " : motivo} ${arquivo}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  if (falhas > 0) {
    process.exitCode = 1;
    console.error(`${falhas} página(s) sem sessão válida ou fora do 200 — conferir acima.`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
