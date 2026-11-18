import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ignoredDirectories = new Set([
  ".git",
  ".next",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "reports",
  "test-results",
]);

// Worktrees de agente são checkouts de outra branch; têm o próprio gate. O
// `rust/target` é o build do Cargo (gigabytes depois do `build:ponte`), não
// código; por caminho, porque `target` noutro lugar pode ser.
const ignoredPaths = new Set([".claude/worktrees", "rust/target"]);

const recursiveDeleteAllowlist = new Set([
  "scripts/lib/safe-fs.mjs",
  "scripts/lib/safe-delete.sh",
  // Mesma lógica do `file === scanner` abaixo: quem TESTA o caçador precisa
  // conter as presas. As fixtures são strings de teste, nunca executadas.
  "tests/plataforma/operacoes-destrutivas-escopo.test.ts",
]);
const scanner = "scripts/check-destructive-ops.mjs";
export function scanDestructiveOps(root = process.cwd()) {
  function listFiles(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      // Por CAMINHO, não por nome: `.claude/worktrees` sai, `.claude` fica.
      if (entry.isDirectory() && ignoredPaths.has(relative(root, absolute).replaceAll("\\", "/"))) continue;
      if (entry.isDirectory()) files.push(...listFiles(absolute));
      else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
    }
    return files;
  }

  const files = listFiles(root);
  const violations = [];
  for (const file of files) {
    if (file === scanner) continue;
    let source;
    try {
      source = readFileSync(resolve(root, file), "utf8");
    } catch {
      continue;
    }

    if (!recursiveDeleteAllowlist.has(file)) {
      // Pega `rm -r` indentado (dentro de função/if); comentário `# rm -rf` não conta.
      if (/(?:^[ \t]*|[;&|][ \t]*|\b(?:then|else|do)[ \t]+)rm[ \t]+(?:-[A-Za-z]*[rR][A-Za-z]*\b|--recursive\b)/m.test(source)) {
        violations.push(`${file}: remoção recursiva deve usar scripts/lib/safe-delete.sh`);
      }
      if (/\b(?:fs\.)?(?:rm|rmdir)(?:Sync)?\s*\([^)]{0,500}\{[^}]*\brecursive\s*:\s*true/.test(source)) {
        violations.push(`${file}: remoção recursiva Node fora do clean centralizado`);
      }
      if (/^[ \t]*find[ \t]+[^\n]*[ \t]-delete\b/m.test(source)) {
        violations.push(`${file}: find -delete deve usar ab_safe_delete_old_files`);
      }
    }
  }
  return { files, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = scanDestructiveOps();
  if (result.violations.length) {
    process.stderr.write(`${result.violations.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`OK destructive-ops (${result.files.length} arquivos verificados).\n`);
}
