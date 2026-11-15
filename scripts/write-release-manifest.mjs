import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { PONTE_BINARIO, PONTE_NO_RUNTIME, PONTE_WASM } from "./lib/ponte.mjs";
import { sha256, sourceSnapshot, verifyChecks } from "./lib/release-provenance.mjs";

const source = sourceSnapshot();
if (process.env.CI && source.dirty) throw new Error("Release de CI exige checkout limpo.");
const root = "reports/ci";
const checks = readdirSync(root).filter((name) => /^(static|database|browser|build|package|rust)\.json$/.test(name))
  .map((name) => JSON.parse(readFileSync(`${root}/${name}`, "utf8")));
verifyChecks(source, checks);
// Na main, static/database/browser podem vir da execução do PR cujo commit de
// teste tem a MESMA árvore deste (scripts/ci-reaproveitar.mjs). O fonte já foi
// conferido acima; aqui fica registrado de onde vieram, e cada registro tem de
// ser do commit declarado — os demais, deste commit.
const reusedChecks = process.env.CI_REAPROVEITADO_RUN
  ? { fromRun: process.env.CI_REAPROVEITADO_RUN, commit: process.env.CI_REAPROVEITADO_COMMIT,
    names: ["static", "database", "browser"] }
  : null;
for (const check of checks) {
  const esperado = reusedChecks?.names.includes(check.name) ? reusedChecks.commit : source.commit;
  if (check.source.commit !== esperado) {
    throw new Error(`Verificação ${check.name} é do commit ${check.source.commit}, esperado ${esperado}.`);
  }
}
const runtime = JSON.parse(readFileSync(`${root}/runtime.json`, "utf8"));
if (runtime.archive !== "runtime.tar.gz" || runtime.source.sourceSha256 !== source.sourceSha256 ||
    runtime.sha256 !== sha256(readFileSync(`${root}/runtime.tar.gz`))) {
  throw new Error("Artefato não corresponde ao fonte verificado ou foi alterado.");
}
// O binário da ponte Rust no pacote (web e worker) é o que o job `rust`
// compilou e testou: o artefato `ci-rust` o devolve ao caminho do checkout.
const binario = sha256(readFileSync(PONTE_BINARIO));
for (const caminho of PONTE_NO_RUNTIME) {
  if (runtime.ponteNode?.[caminho] !== binario) {
    throw new Error(`Ponte Rust no runtime (${caminho}) não é o binário do job rust (${binario}).`);
  }
}
// O mesmo para o WebAssembly embutido nos chunks do navegador.
const wasm = sha256(readFileSync(PONTE_WASM));
const chunksComWasm = Object.entries(runtime.ponteWasm ?? {});
if (chunksComWasm.length === 0 || chunksComWasm.some(([, hash]) => hash !== wasm)) {
  throw new Error(`WebAssembly da ponte nos chunks do navegador não é o do job rust (${wasm}).`);
}
writeFileSync(`${root}/release-manifest.json`, JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(), source, runtime,
  checks, workflowRun: process.env.GITHUB_RUN_ID ?? null, reusedChecks,
}, null, 2) + "\n");
process.stdout.write("Release vinculada ao fonte, migrations, artefato, ponte Rust e verificações aprovadas.\n");
