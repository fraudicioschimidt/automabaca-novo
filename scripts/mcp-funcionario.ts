/**
 * Servidor MCP do funcionário de IA, no PC do dono (stdio). Cada ferramenta
 * roda o `ops-funcionario` no worker de produção, por ssh,
 * com o ator `agent:<AUTOMABACA_AGENT>:por:<AUTOMABACA_DONO>`.
 *
 *   AUTOMABACA_AGENT=gemini npx tsx scripts/mcp-funcionario.ts
 *
 * Variáveis: AUTOMABACA_AGENT (obrigatória: gemini, claude, codex…),
 * AUTOMABACA_DONO (padrão: fabricio), AUTOMABACA_SSH_HOST (padrão: hermes).
 * Cada chamada vai para ~/.local/state/automabaca/funcionario.log, sem
 * evidência nem conteúdo. Como ligar: docs/FUNCIONARIO-IA.md.
 *
 * O stdout é o canal do MCP: nada mais escreve nele.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createFuncionarioServer,
  remoteShellCommand,
  type FuncionarioLogEntry,
  type RemoteCommand,
  type RemoteResult,
} from "./lib/funcionario-mcp";

const REMOTE_TIMEOUT_MS = 180_000;
const LOG_FILE = path.join(homedir(), ".local/state/automabaca/funcionario.log");

function runOverSsh(host: string) {
  return (command: RemoteCommand): Promise<RemoteResult> => new Promise((resolve) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", host, remoteShellCommand(command)], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    // Só o ssh local morre: o comando no worker pode terminar (e gravar) depois.
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, REMOTE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: "", stderr: `ssh não rodou: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
          + (timedOut ? `\ntempo esgotado (${REMOTE_TIMEOUT_MS / 1000} s): o comando pode ter terminado no worker` : signal ? `\ninterrompido (${signal})` : ""),
      });
    });
    // Sem stdin, o `docker exec -i` precisa do fim da entrada.
    child.stdin.end(command.stdin ?? "");
  });
}

async function appendLog(entry: FuncionarioLogEntry): Promise<void> {
  try {
    await mkdir(path.dirname(LOG_FILE), { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    process.stderr.write(`funcionario.log: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function main(): Promise<void> {
  const agent = process.env.AUTOMABACA_AGENT ?? "";
  const server = createFuncionarioServer({
    agent,
    owner: process.env.AUTOMABACA_DONO || "fabricio",
    run: runOverSsh(process.env.AUTOMABACA_SSH_HOST || "hermes"),
    // O log nunca derruba a ferramenta: a falha de escrita já vai para o stderr.
    log: (entry) => { appendLog(entry).catch(() => {}); },
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
