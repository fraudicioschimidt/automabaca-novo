import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = new Set();
let stopping = false;

function start(script) {
  const child = spawn(npmCommand, ["run", script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function result(child, name) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ name, code: 1, error }));
    child.once("exit", (code, signal) => resolve({ name, code, signal }));
  });
}

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stop(signal);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  });
}

const infra = start("dev:infra:up");
const infraResult = await result(infra, "infraestrutura");
if (infraResult.error || infraResult.code !== 0) {
  const detail = infraResult.error?.message ?? `código ${infraResult.code}`;
  console.error(`Falha ao iniciar infraestrutura local: ${detail}`);
  process.exit(1);
}

process.stdout.write("✓ bancos locais saudáveis; iniciando web e worker.\n");
const web = start("dev");
const worker = start("worker:dev");
const first = await Promise.race([result(web, "web"), result(worker, "worker")]);

if (!stopping) {
  const detail = first.error?.message
    ?? (first.signal ? `sinal ${first.signal}` : `código ${first.code}`);
  console.error(`${first.name} encerrou (${detail}); desligando o outro processo.`);
  stop();
  process.exitCode = first.code && first.code > 0 ? first.code : 1;
}

await Promise.allSettled([...children].map((child) => result(child, "serviço")));
