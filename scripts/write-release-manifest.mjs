import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
writeFileSync(`${root}/release-manifest.json`, JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(), source, runtime,
  checks, workflowRun: process.env.GITHUB_RUN_ID ?? null, reusedChecks,
}, null, 2) + "\n");
process.stdout.write("Release vinculada ao fonte, migrations, artefato e verificações aprovadas.\n");
