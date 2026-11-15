import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Instalação completa prepara o client; --omit=dev serve apenas aos artefatos
// já compilados e não deve executar o CLI do Prisma, mesmo se um peer o instalar.
const cli = new URL("../node_modules/prisma/build/index.js", import.meta.url);
const omit = (process.env.npm_config_omit ?? "").split(/[\s,]+/);
if (!omit.includes("dev") && process.env.NODE_ENV !== "production" && existsSync(cli)) {
  const result = spawnSync(process.execPath, [fileURLToPath(cli), "generate"], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
