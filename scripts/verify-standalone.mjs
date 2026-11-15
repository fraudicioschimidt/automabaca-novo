import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { carregarDominioNode } from "./lib/dominio-node.mjs";

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
  carregarDominioNode(root);
} catch (error) {
  throw new Error("Standalone não consegue carregar a ponte Rust (@automabaca/dominio-node).", { cause: error });
}

const nestedAssets = [".next/static/static", "public/public"].filter((entry) =>
  existsSync(path.join(root, entry)),
);
if (nestedAssets.length > 0) {
  throw new Error(`Standalone contem assets aninhados incorretamente: ${nestedAssets.join(", ")}`);
}

process.stdout.write("OK standalone sem arquivos sensiveis ou artefatos de desenvolvimento.\n");
