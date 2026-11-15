import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { sourceSnapshot } from "./lib/release-provenance.mjs";

const [name, separator, command, ...args] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]*$/.test(name ?? "") || separator !== "--" || !command) {
  throw new Error("Uso: node scripts/record-check.mjs <nome> -- <comando> [argumentos]");
}
const source = sourceSnapshot();
const startedAt = new Date().toISOString();
const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
const unchanged = source.sourceSha256 === sourceSnapshot().sourceSha256;
const exitCode = unchanged ? (result.status ?? 1) : 1;
mkdirSync("reports/ci", { recursive: true });
writeFileSync(`reports/ci/${name}.json`, JSON.stringify({
  name, command: [command, ...args], source, exitCode, startedAt,
  finishedAt: new Date().toISOString(), unchanged,
  runtime: { node: process.version, npm: process.env.npm_config_user_agent ?? null },
}, null, 2) + "\n");
if (!unchanged) process.stderr.write("Fonte alterado durante a verificação; evidência recusada.\n");
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exitCode = exitCode;
