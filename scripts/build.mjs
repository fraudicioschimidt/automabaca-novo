import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildEnv } from "./lib/build-env.mjs";

const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)),
  "build",
  ...process.argv.slice(2),
], { env: buildEnv, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
