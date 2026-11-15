import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chunksComWasm, PONTE_NO_RUNTIME, wasmDoChunk } from "./lib/ponte.mjs";
import { sha256, sourceSnapshot } from "./lib/release-provenance.mjs";

// Arquivo fechado: sem .env, uploads ou ferramentas de desenvolvimento.
const source = sourceSnapshot();
execFileSync(process.execPath, ["scripts/verify-standalone.mjs"], { stdio: "inherit" });
mkdirSync("reports/ci", { recursive: true });
execFileSync("tar", ["-czf", "reports/ci/runtime.tar.gz", ".next/standalone", "dist/worker-runtime", "prisma/migrations"], { stdio: "inherit" });
// O WebAssembly da ponte vai embutido nos chunks do navegador: um registro por
// chunk, com o SHA-256 do módulo, para o manifesto conferir contra o job rust.
const chunks = chunksComWasm();
if (chunks.length === 0) throw new Error("Nenhum chunk do navegador leva o WebAssembly da ponte Rust.");
writeFileSync("reports/ci/runtime.json", JSON.stringify({
  source, archive: "runtime.tar.gz", sha256: sha256(readFileSync("reports/ci/runtime.tar.gz")),
  ponteNode: Object.fromEntries(PONTE_NO_RUNTIME.map((caminho) => [caminho, sha256(readFileSync(caminho))])),
  ponteWasm: Object.fromEntries(chunks.map((caminho) => [caminho, sha256(wasmDoChunk(readFileSync(caminho, "utf8")))])),
}, null, 2) + "\n");
