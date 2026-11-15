import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PONTE_NO_RUNTIME } from "./lib/ponte.mjs";
import { sha256, sourceSnapshot, verifyChecks } from "./lib/release-provenance.mjs";

const folder = resolve(process.argv[2] ?? "reports/ci");
const manifest = JSON.parse(readFileSync(`${folder}/release-manifest.json`, "utf8"));
const source = sourceSnapshot();
if (manifest.schemaVersion !== 1 || manifest.source.sourceSha256 !== source.sourceSha256) {
  throw new Error("Manifesto incompatível com o checkout atual.");
}
verifyChecks(source, manifest.checks);
if (manifest.runtime.source.sourceSha256 !== source.sourceSha256 || manifest.runtime.archive !== "runtime.tar.gz" || manifest.runtime.sha256 !== sha256(readFileSync(`${folder}/runtime.tar.gz`))) {
  throw new Error("Pacote alterado ou incompleto.");
}
// As duas cópias da ponte Rust dentro do pacote são o binário que o manifesto
// registrou (o do job rust, conferido no write-release-manifest).
const nativos = manifest.runtime.ponteNode ?? {};
if (Object.keys(nativos).sort().join() !== [...PONTE_NO_RUNTIME].sort().join()) {
  throw new Error("Manifesto sem as cópias esperadas da ponte Rust.");
}
for (const caminho of PONTE_NO_RUNTIME) {
  const conteudo = execFileSync("tar", ["-xzOf", `${folder}/runtime.tar.gz`, caminho], { maxBuffer: 64 * 1024 * 1024 });
  if (sha256(conteudo) !== nativos[caminho] || nativos[caminho] !== nativos[PONTE_NO_RUNTIME[0]]) {
    throw new Error(`Ponte Rust alterada no pacote: ${caminho}`);
  }
}
// E o WebAssembly que o navegador baixa, o que o manifesto registrou.
const publicados = Object.entries(manifest.runtime.ponteWasm ?? {});
if (publicados.length !== 1) throw new Error("Manifesto sem o WebAssembly da ponte Rust.");
for (const [caminho, hash] of publicados) {
  const wasm = execFileSync("tar", ["-xzOf", `${folder}/runtime.tar.gz`, caminho], { maxBuffer: 64 * 1024 * 1024 });
  if (sha256(wasm) !== hash) throw new Error(`WebAssembly da ponte alterado no pacote: ${caminho}`);
}
process.stdout.write(`Release conferida: commit ${manifest.source.commit}, SHA-256 ${manifest.runtime.sha256}, ponte Rust ${nativos[PONTE_NO_RUNTIME[0]]}\n`);
