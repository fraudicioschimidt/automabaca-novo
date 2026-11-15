import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
process.stdout.write(`Release conferida: commit ${manifest.source.commit}, SHA-256 ${manifest.runtime.sha256}\n`);
