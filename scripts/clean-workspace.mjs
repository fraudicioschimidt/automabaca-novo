import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeRemoveTreeSync } from "./lib/safe-fs.mjs";

const projectRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const targets = [
  ".next",
  "coverage",
  "reports",
  "playwright-report",
  "test-results",
  "dist",
  ".eslintcache",
  "tsconfig.tsbuildinfo",
  "next-env.d.ts",
];

for (const entry of targets) {
  const target = resolve(projectRoot, entry);
  safeRemoveTreeSync(projectRoot, target);
}
