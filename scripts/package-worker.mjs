import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { safeRemoveTreeSync } from "./lib/safe-fs.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = path.join(root, "dist/worker-runtime");
const source = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lockBytes = readFileSync(path.join(root, "package-lock.json"));
const lock = JSON.parse(lockBytes);
const dependencies = {};
const entries = ["worker", "worker-healthcheck"];

for (const entry of entries) {
  const meta = JSON.parse(readFileSync(path.join(root, `dist/${entry}.meta.json`), "utf8"));
  for (const output of Object.values(meta.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external || isBuiltin(imported.path)) continue;
      const parts = imported.path.split("/");
      const name = imported.path.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      if (!source.dependencies[name]) throw new Error(`Import externo não declarado: ${imported.path}`);
      dependencies[name] = source.dependencies[name];
    }
  }
}

// O runtime é instalado sem peers, para não trazer os opcionais (Prisma CLI,
// TypeScript). O peer OBRIGATÓRIO de uma dependência direta é import dela em
// tempo de carga (o pg-boss importa @opentelemetry/api): entra como dependência
// direta, na versão do lockfile auditado.
for (const name of Object.keys(dependencies)) {
  const pkg = lock.packages[`node_modules/${name}`];
  for (const peer of Object.keys(pkg?.peerDependencies ?? {})) {
    if (pkg.peerDependenciesMeta?.[peer]?.optional || dependencies[peer]) continue;
    const resolved = lock.packages[`node_modules/${peer}`];
    if (!resolved) throw new Error(`Peer obrigatório de ${name} fora do lockfile: ${peer}`);
    dependencies[peer] = resolved.version;
  }
}

safeRemoveTreeSync(root, target);
mkdirSync(path.join(target, "dist"), { recursive: true });
for (const entry of entries) {
  cpSync(path.join(root, `dist/${entry}.mjs`), path.join(target, `dist/${entry}.mjs`));
}
const manifest = {
  name: `${source.name}-worker`, version: source.version, private: true,
  engines: source.engines, packageManager: source.packageManager,
  scripts: { start: "node dist/worker.mjs" },
  dependencies,
  overrides: Object.fromEntries(Object.entries(source.overrides).map(([name, value]) => [
    name, typeof value === "string" && value.startsWith("$") ? source.dependencies[value.slice(1)] : value,
  ])),
  allowScripts: source.allowScripts,
};
// Apenas omitir dev no manifesto completo ainda instala Prisma/TypeScript como
// peers opcionais. A árvore de runtime deriva dos imports efetivos dos bundles.
writeFileSync(path.join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(path.join(target, "package-lock.json"), lockBytes);
cpSync(path.join(root, ".npmrc"), path.join(target, ".npmrc"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args) {
  const result = spawnSync(npm, args, { cwd: target, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} falhou (${result.status}).`);
}
run(["install", "--package-lock-only", "--ignore-scripts", "--omit=dev", "--omit=peer", "--no-audit", "--fund=false"]);

// Não permita que a resolução da árvore reduzida introduza uma versão ou um
// tarball que não tenha sido auditado no lockfile da fonte.
function packageKey(location, pkg) {
  return `${location.split("node_modules/").at(-1)}@${pkg.version}:${pkg.integrity}`;
}
const approved = new Set(Object.entries(lock.packages).filter(([key]) => key)
  .map(([key, pkg]) => packageKey(key, pkg)));
const runtimeLock = JSON.parse(readFileSync(path.join(target, "package-lock.json"), "utf8"));
for (const [key, pkg] of Object.entries(runtimeLock.packages)) {
  if (key && !approved.has(packageKey(key, pkg))) {
    throw new Error(`Runtime selecionou pacote fora do lockfile auditado: ${key}@${pkg.version}`);
  }
}
// Sem peers instalados, o peer obrigatório que ninguém declarou só faltaria na
// subida do worker, já na produção. Importar daqui não prova nada: o Node acha
// o pacote no node_modules do checkout, acima desta pasta.
for (const [key, pkg] of Object.entries(runtimeLock.packages)) {
  for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
    if (pkg.peerDependenciesMeta?.[peer]?.optional) continue;
    if (!runtimeLock.packages[`node_modules/${peer}`]) {
      throw new Error(`Peer obrigatório ausente no runtime do worker: ${peer} (de ${key || "raiz"})`);
    }
  }
}
run(["ci", "--omit=dev", "--omit=peer", "--no-audit", "--fund=false"]);
// Image-format qualification now imports Sharp in the worker too. Verify the
// native binding in the reduced runtime, not only in the full build checkout.
if (dependencies.sharp) {
  const smoke = spawnSync(process.execPath, ["--input-type=module", "-e",
    "import sharp from 'sharp'; const out = await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer(); if (!out.length) process.exit(1);",
  ], { cwd: target, stdio: "inherit" });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0) throw new Error("Sharp indisponível no pacote do worker.");
}
writeFileSync(path.join(target, "build-manifest.json"), `${JSON.stringify({
  node: process.version,
  sourceLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
  bundles: Object.fromEntries(entries.map((entry) => [entry,
    createHash("sha256").update(readFileSync(path.join(target, `dist/${entry}.mjs`))).digest("hex")],
  )),
}, null, 2)}\n`);
process.stdout.write(`Worker empacotado em ${target} (${Object.keys(dependencies).length} dependências diretas).\n`);
