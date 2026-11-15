import { lstatSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const automabacaRoot = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryRoot = realpathSync(tmpdir());
const removableProjectEntries = [
  ".next",
  "coverage",
  "dist",
  ".eslintcache",
  "node_modules",
  "next-env.d.ts",
  "playwright-report",
  "reports",
  "test-results",
  "tsconfig.tsbuildinfo",
].map((entry) => resolve(automabacaRoot, entry));

function existingRealpath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertApprovedRoot(root) {
  const canonicalRoot = realpathSync(root);
  const approvedRoots = new Set([
    automabacaRoot,
    temporaryRoot,
  ]);
  if (!approvedRoots.has(canonicalRoot) || canonicalRoot === sep) {
    throw new Error(`raiz de remoção Node recusada: ${canonicalRoot}`);
  }
  return canonicalRoot;
}

function assertContainedTarget(root, target) {
  const canonicalRoot = assertApprovedRoot(root);
  const absoluteTarget = resolve(target);
  const rel = relative(canonicalRoot, absoluteTarget);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`alvo de remoção Node fora da raiz: ${absoluteTarget}`);
  }
  if (
    canonicalRoot === automabacaRoot
    && !removableProjectEntries.some((entry) => (
      absoluteTarget === entry || absoluteTarget.startsWith(`${entry}${sep}`)
    ))
  ) {
    throw new Error(`alvo interno fora da lista de artefatos removíveis: ${absoluteTarget}`);
  }
  if (canonicalRoot === temporaryRoot && !rel.split(sep)[0]?.startsWith("automabaca-")) {
    throw new Error(`temporário sem prefixo automabaca recusado: ${absoluteTarget}`);
  }

  let cursor = canonicalRoot;
  for (const segment of rel.split(sep)) {
    cursor = resolve(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`symlink recusado na remoção Node: ${cursor}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }

  const resolvedTarget = existingRealpath(absoluteTarget);
  if (resolvedTarget) {
    const resolvedRel = relative(canonicalRoot, resolvedTarget);
    if (!resolvedRel || resolvedRel === ".." || resolvedRel.startsWith(`..${sep}`)) {
      throw new Error(`alvo resolvido fora da raiz: ${resolvedTarget}`);
    }
  }
  return absoluteTarget;
}

export function safeRemoveTreeSync(root, target) {
  const validatedTarget = assertContainedTarget(root, target);
  rmSync(validatedTarget, { recursive: true, force: true, maxRetries: 2 });
}
