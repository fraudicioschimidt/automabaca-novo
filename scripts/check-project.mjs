import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Gate do projeto em três modos:
 *   fast — local, só o que a mudança na árvore afeta;
 *   ci   — estáticas + unitários (job `verificações` da CI);
 *   full — ci + testes com PostgreSQL (o que a CI roda, menos build e navegador).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const activeChildren = new Set();

function writeLine(message = "") {
  process.stdout.write(`${message}\n`);
}

function npmTask(label, script, extraArgs = []) {
  return {
    label,
    command: NPM,
    args: ["run", "--silent", script, ...(extraArgs.length ? ["--", ...extraArgs] : [])],
  };
}

function formatDuration(milliseconds) {
  return milliseconds < 1_000
    ? `${Math.round(milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function actionableFailure(output, maxLength = 8_000) {
  if (output.length <= maxLength) return output;
  const omitted = output.length - maxLength;
  return `${output.slice(0, 1_500)}\n\n... ${omitted} caracteres omitidos ...\n\n${output.slice(-6_500)}`;
}

async function runTask(task) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const child = spawn(task.command, task.args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: "0", npm_config_loglevel: "error" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);

    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { output += `\n${error.stack ?? error.message}\n`; });
    child.on("close", (code, signal) => {
      activeChildren.delete(child);
      resolve({ ...task, ok: code === 0, code, signal, output: output.trim(), duration: performance.now() - startedAt });
    });
  });
}

async function runPhase(tasks, concurrency) {
  if (tasks.length === 0) return [];
  const results = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await runTask(tasks[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

  for (const result of results) {
    writeLine(`${(result.ok ? "OK" : "FALHOU").padEnd(6)} ${result.label} (${formatDuration(result.duration)})`);
    if (!result.ok) {
      // O npm às vezes falha sem saída útil (o audit já imprimiu só "undefined"),
      // então o código de saída ou o sinal sempre acompanham o rótulo.
      const causa = result.signal ? `sinal ${result.signal}` : `saiu ${result.code}`;
      console.error(`\n--- ${result.label} (${causa}) ---\n${actionableFailure(result.output || "(sem saida)")}\n--- fim ---\n`);
    }
  }
  return results;
}

function failIfNeeded(results) {
  if (results.some((result) => !result.ok)) process.exit(1);
}

/**
 * Worktree com `node_modules` emprestado não roda o postinstall: o client do
 * Prisma fica com o schema antigo, e tipos e testes falham com erro falso.
 * Gerar custa menos de um segundo.
 */
function generatePrismaClient() {
  const cli = path.join(ROOT, "node_modules/prisma/build/index.js");
  if (!existsSync(cli)) return;
  try {
    execFileSync(process.execPath, [cli, "generate"], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    console.error(`FALHOU prisma generate\n${error.stdout ?? ""}${error.stderr ?? ""}`);
    process.exit(1);
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function lines(value) {
  return value ? value.split("\n").filter(Boolean) : [];
}

function changedFiles() {
  const explicitIndex = process.argv.indexOf("--files");
  if (explicitIndex >= 0) {
    return [...new Set(process.argv.slice(explicitIndex + 1).filter(Boolean))].sort();
  }
  // Contra o ponto em que o branch saiu da main, não contra o HEAD: trabalho já
  // commitado também conta, senão o gate "antes do PR" não confere nada.
  let base = "HEAD";
  try {
    base = git(["merge-base", "HEAD", "origin/main"]);
  } catch {
    // Sem origin/main (clone sem remoto): só o que não foi commitado.
  }
  const tracked = lines(git(["diff", "--name-only", "--diff-filter=ACMRD", base, "--"]));
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

export function isDocumentation(file) {
  return file.startsWith("docs/") || file.endsWith(".md");
}

export function isCode(file) {
  return /\.(?:[cm]?[jt]sx?)$/.test(file);
}

export function requiresFullTests(file) {
  return /^(?:package-lock\.json|vitest\.config\.ts|prisma\/schema\.prisma|prisma\/migrations\/|tests\/(?:global-setup|setup-env)\.ts|tests\/helpers\/)/.test(file);
}

export function classifyImpact(files, fileExists = (file) => existsSync(path.join(ROOT, file))) {
  const existingFiles = files.filter(fileExists);
  const codeFiles = existingFiles.filter(isCode);
  const deletedCode = files.some((file) => isCode(file) && !fileExists(file));
  return {
    documentationOnly: files.length > 0 && files.every(isDocumentation),
    codeFiles,
    existingFiles,
    deletedCode,
    shellFiles: existingFiles.filter((file) => file.endsWith(".sh")),
    // O Vitest segue imports; não enxerga o shell carregado pelo subprocesso.
    scriptTests: files.includes("scripts/lib/test-runtime-env.sh")
      ? ["tests/plataforma/test-runtime-env.test.ts"] : [],
    lintFiles: codeFiles.filter((file) => !file.startsWith("src/generated/")),
    operationsChanged: files.some((file) => /^(?:(?:scripts|infra|deploy|\.github)\/|package\.json$|(?:next|playwright|prisma)\.config\.)/.test(file)),
    fullTests: deletedCode || files.some(requiresFullTests),
    browserChanged: files.some((file) =>
      /^tests\/browser\//.test(file)
      || file.startsWith("app/")
      || /^(?:playwright\.config\.|next\.config\.|scripts\/run-(?:browser-suite|playwright-canonical)\.sh$|scripts\/lib\/test-runtime-env\.sh$)/.test(file),
    ),
  };
}

/**
 * Testes que leem a árvore de fontes em vez de importar módulos (fronteiras de
 * arquitetura, por exemplo). O `vitest related` segue imports e nunca os
 * alcança, então o modo `fast` os roda sempre.
 */
export function treeScanningTests(dir = path.join(ROOT, "tests")) {
  // Recursivo: os testes vivem em subpastas por área (`tests/<area>/`).
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => /\.test\.tsx?$/.test(name) && !/\.db\.test\./.test(name))
    .filter((name) => {
      const source = readFileSync(path.join(dir, name), "utf8");
      return /from "(?:\.\.?\/)+helpers\/source-files"/.test(source)
        || (/readdirSync\(|[^a-zA-Z]readdir\(/.test(source) && !/mkdtemp\w*\(/.test(source));
    })
    .map((name) => `tests/${name}`)
    .sort();
}

export function staticGateTasks() {
  return [
    npmTask("lint", "lint"),
    npmTask("TypeScript", "typecheck"),
    npmTask("codigo morto", "knip"),
    npmTask("segredos", "security:scan"),
    npmTask("operacoes destrutivas", "security:destructive"),
    npmTask("dependencias de producao", "security:audit"),
  ];
}

async function runCi() {
  const startedAt = performance.now();
  writeLine("Gate da CI: estaticas e unitarios em paralelo.\n");
  failIfNeeded(await runPhase([...staticGateTasks(), npmTask("testes unitarios", "test:unit")], 4));
  writeLine(`\nOK     gate da CI (${formatDuration(performance.now() - startedAt)})`);
}

async function runFull() {
  const startedAt = performance.now();
  writeLine("Gate completo: estaticas e unitarios, depois testes com PostgreSQL.\n");
  failIfNeeded(await runPhase([...staticGateTasks(), npmTask("testes unitarios", "test:unit")], 4));
  failIfNeeded(await runPhase([npmTask("testes com PostgreSQL", "test:db")], 1));
  writeLine(`\nOK     gate completo (${formatDuration(performance.now() - startedAt)})`);
}

async function runFast() {
  const startedAt = performance.now();
  const files = changedFiles();
  if (files.length === 0) {
    writeLine("OK     check incremental: arvore sem alteracoes");
    return;
  }
  const impact = classifyImpact(files);
  if (impact.documentationOnly) {
    writeLine(`OK     check incremental: ${files.length} arquivo(s) somente de documentacao`);
    return;
  }

  writeLine(`Check incremental: ${files.length} arquivo(s) alterado(s).`);
  const staticTasks = [];
  if (impact.lintFiles.length) staticTasks.push(npmTask("lint alterado", "lint:affected", impact.lintFiles));
  if (files.some(isCode) || files.some((file) => /^(?:tsconfig|next\.config|prisma\/)/.test(file))) {
    staticTasks.push(npmTask("TypeScript", "typecheck"));
  }
  for (const file of impact.shellFiles) {
    staticTasks.push({ label: `sintaxe shell: ${file}`, command: "bash", args: ["-n", file] });
  }
  if (impact.operationsChanged) {
    staticTasks.push(npmTask("segredos alterados", "security:scan:affected", impact.existingFiles));
    staticTasks.push(npmTask("operacoes destrutivas", "security:destructive"));
  }
  failIfNeeded(await runPhase(staticTasks, 3));

  const testTasks = [];
  if (impact.fullTests) {
    testTasks.push(npmTask("testes completos por mudanca global", "test"));
  } else {
    if (impact.scriptTests.length) testTasks.push(npmTask("testes de scripts afetados", "test:unit", impact.scriptTests));
    if (impact.codeFiles.length) testTasks.push(npmTask("testes relacionados", "test:affected", impact.codeFiles));
    testTasks.push(npmTask("testes que varrem a arvore", "test:unit", treeScanningTests()));
  }
  failIfNeeded(await runPhase(testTasks, 1));

  if (impact.browserChanged) {
    writeLine("AVISO  navegador afetado: execute npm run test:browser:local para validar o Playwright isolado");
  }
  writeLine(`OK     check incremental (${formatDuration(performance.now() - startedAt)})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      for (const child of activeChildren) child.kill(signal);
      process.exit(128);
    });
  }

  const mode = process.argv[2] ?? "full";
  generatePrismaClient();
  if (mode === "full") await runFull();
  else if (mode === "fast") await runFast();
  else if (mode === "ci") await runCi();
  else {
    console.error(`Modo desconhecido: ${mode}. Use fast, ci ou full.`);
    process.exit(2);
  }
}
