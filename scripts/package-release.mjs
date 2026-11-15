import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { PONTE_NO_RUNTIME } from "./lib/ponte.mjs";
import { sha256, sourceSnapshot } from "./lib/release-provenance.mjs";

// Arquivo fechado: sem .env, uploads ou ferramentas de desenvolvimento.
const source = sourceSnapshot();
execFileSync(process.execPath, ["scripts/verify-standalone.mjs"], { stdio: "inherit" });
mkdirSync("reports/ci", { recursive: true });
execFileSync("tar", ["-czf", "reports/ci/runtime.tar.gz", ".next/standalone", "dist/worker-runtime", "prisma/migrations"], { stdio: "inherit" });
writeFileSync("reports/ci/runtime.json", JSON.stringify({
  source, archive: "runtime.tar.gz", sha256: sha256(readFileSync("reports/ci/runtime.tar.gz")),
  ponteNode: Object.fromEntries(PONTE_NO_RUNTIME.map((caminho) => [caminho, sha256(readFileSync(caminho))])),
}, null, 2) + "\n");
