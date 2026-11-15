import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedNode = pkg.engines.node;
const expectedNpm = pkg.packageManager.slice("npm@".length);
const actualNpm = process.env.npm_config_user_agent?.match(/^npm\/([^ ]+)/)?.[1];
if (process.versions.node !== expectedNode || actualNpm !== expectedNpm) {
  console.error(`Toolchain divergente. Use Node ${expectedNode} e npm ${expectedNpm} (ver README.md).`);
  process.exitCode = 1;
}
