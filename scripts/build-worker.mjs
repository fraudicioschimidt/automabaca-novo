/**
 * Bundle do worker para produção (sem tsx em runtime).
 * Uso: node scripts/build-worker.mjs
 */
import * as esbuild from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comandosOperacionais } from "./montar-camadas-de-imagem.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist/worker.mjs");

const result = await esbuild.build({
  entryPoints: [path.join(root, "src/jobs/worker.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile,
  packages: "external",
  alias: {
    "@": root,
  },
  logLevel: "info",
  sourcemap: true,
  metafile: true,
});
await writeFile(path.join(root, "dist/worker.meta.json"), JSON.stringify(result.metafile));

const bundle = await readFile(outfile, "utf8");
if (/\b(?:from|import)\s*["']server-only["']/.test(bundle)) {
  throw new Error(
    'bundle do worker importa "server-only"; mova o módulo compartilhado para fora da fronteira exclusiva do Next',
  );
}

console.warn("✓ worker → dist/worker.mjs");

const health = await esbuild.build({
  entryPoints: [path.join(root, "scripts/worker-healthcheck.ts")],
  bundle: true, platform: "node", target: "node24", format: "esm",
  outfile: path.join(root, "dist/worker-healthcheck.mjs"),
  packages: "external", alias: { "@": root }, metafile: true, logLevel: "info",
});
await writeFile(path.join(root, "dist/worker-healthcheck.meta.json"), JSON.stringify(health.metafile));

// Comandos operacionais (`scripts/ops-*.ts`): cada um vira `dist/<nome>.mjs` e
// roda via `docker exec` no worker. A montagem das camadas leva os mesmos à imagem.
for (const nome of comandosOperacionais(root)) {
  const ops = await esbuild.build({
    entryPoints: [path.join(root, `scripts/${nome}.ts`)],
    bundle: true, platform: "node", target: "node24", format: "esm",
    outfile: path.join(root, `dist/${nome}.mjs`),
    packages: "external", alias: { "@": root }, metafile: true, logLevel: "info",
  });
  await writeFile(path.join(root, `dist/${nome}.meta.json`), JSON.stringify(ops.metafile));
}
