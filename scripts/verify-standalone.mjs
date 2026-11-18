import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parse } from "acorn";
import { carregarPonte } from "./lib/ponte.mjs";

const root = path.resolve(".next", "standalone");
const forbidden = [
  ".git",
  ".github",
  ".saved-credentials",
  ".eslintcache",
  "BLUEPRINT.md",
  "CLAUDE.md",
  "README.md",
  "app",
  "docs",
  "artifacts",
  "reports",
  "coverage",
  "test-results",
  "playwright-report",
  "dist",
  "infra",
  "prisma",
  "rust",
  "scripts",
  "src",
  "tests",
  "eslint.config.mjs",
  "knip.json",
  "next.config.ts",
  "playwright.config.ts",
  "tsconfig.json",
  "vitest.config.ts",
];

if (!existsSync(root)) {
  throw new Error(`Standalone ausente: ${root}`);
}

const rootEntries = readdirSync(root);
const leaked = rootEntries.filter(
  (entry) => forbidden.includes(entry) || /^\.env(?:\.|$)/.test(entry),
);
if (leaked.length > 0) {
  throw new Error(`Standalone contem arquivos proibidos: ${leaked.join(", ")}`);
}

const requiredAssets = [
  "server.js",
  ".next/static/chunks",
  "node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js",
  "public/fonts/geist-400-latin.woff2",
  "public/sports-icons/soccer.png",
];
const missingAssets = requiredAssets.filter((entry) => !existsSync(path.join(root, entry)));
if (missingAssets.length > 0) {
  throw new Error(`Standalone sem assets obrigatorios: ${missingAssets.join(", ")}`);
}

try {
  const standaloneRequire = createRequire(path.join(root, "server.js"));
  const sharpPath = standaloneRequire.resolve("sharp");
  if (!sharpPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Sharp resolvido fora do standalone.");
  }
  const sharp = standaloneRequire("sharp");
  await sharp(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  )).resize(2, 2).png().toBuffer();
} catch (error) {
  throw new Error("Standalone não consegue carregar o runtime nativo do Sharp.", { cause: error });
}

try {
  carregarPonte(root);
} catch (error) {
  throw new Error("Standalone não consegue carregar a ponte Rust (@automabaca/dominio).", { cause: error });
}

// O `browserslist` do package.json (Chrome/Edge 117, Firefox 113, Safari 16.4)
// lê ES2022 inteiro e nada além: sintaxe mais nova (inclusive de regex, como a
// flag `v`), vinda do código ou de dependência, quebraria a tela inteira lá.
const ECMA_DOS_NAVEGADORES = 2022;
const chunksDoNavegador = readdirSync(path.join(root, ".next/static/chunks"), { recursive: true })
  .filter((arquivo) => String(arquivo).endsWith(".js"));
const sintaxeNova = chunksDoNavegador.flatMap((arquivo) => {
  const codigo = readFileSync(path.join(root, ".next/static/chunks", String(arquivo)), "utf8");
  const erros = ["module", "script"].map((sourceType) => {
    try {
      parse(codigo, { ecmaVersion: ECMA_DOS_NAVEGADORES, sourceType, allowHashBang: false });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  return erros.includes(null) ? [] : [`${String(arquivo)}: ${erros[0]}`];
});
if (chunksDoNavegador.length === 0) {
  throw new Error("Standalone sem chunks de navegador em .next/static/chunks");
}
if (sintaxeNova.length > 0) {
  throw new Error(`JavaScript do navegador além de ES${ECMA_DOS_NAVEGADORES} (browserslist):\n${sintaxeNova.join("\n")}`);
}

const nestedAssets = [".next/static/static", "public/public"].filter((entry) =>
  existsSync(path.join(root, entry)),
);
if (nestedAssets.length > 0) {
  throw new Error(`Standalone contem assets aninhados incorretamente: ${nestedAssets.join(", ")}`);
}

process.stdout.write("OK standalone sem arquivos sensiveis ou artefatos de desenvolvimento.\n");
