import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeRemoveTreeSync } from "../../scripts/lib/safe-fs.mjs";

const SCRIPT = path.resolve("scripts/vez.sh");

type Run = { child: ChildProcess; done: Promise<{ code: number | null; output: string }> };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "automabaca-vez-test-"));
});

afterEach(() => {
  safeRemoveTreeSync(tmpdir(), dir);
});

function vez(args: string[], env: Record<string, string> = {}): Run {
  // A própria suíte roda dentro de uma vaga (AUTOMABACA_VEZ=1); os filhos não.
  const { AUTOMABACA_VEZ: _herdada, ...base } = process.env;
  const child = spawn("bash", [SCRIPT, ...args], {
    env: {
      ...base,
      AUTOMABACA_VEZ_DIR: path.join(dir, "vagas"),
      AUTOMABACA_VEZ_MEMORIA_GB: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  const done = new Promise<{ code: number | null; output: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, output }));
  });
  return { child, done };
}

/** Segura a vaga até o teste criar `solta`, marcando `dentro` enquanto isso. */
function holder(args: string[], env: Record<string, string> = {}): Run {
  return vez([...args, "--", "bash", "-c", `touch ${dir}/dentro; until [ -f ${dir}/solta ]; do sleep 0.05; done; rm ${dir}/dentro`], env);
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condição não chegou");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const probe = () => ["--", "bash", "-c", `[ -f ${dir}/dentro ] && echo SOBREPOS || echo SOZINHO`];

describe("vez.sh", () => {
  it("com a única vaga ocupada, o segundo comando espera o primeiro sair", async () => {
    const a = holder([], { AUTOMABACA_VEZ_VAGAS: "1" });
    await until(() => existsSync(path.join(dir, "dentro")));
    const b = vez(probe(), { AUTOMABACA_VEZ_VAGAS: "1" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    writeFileSync(path.join(dir, "solta"), "");
    expect((await a.done).code).toBe(0);
    expect(await b.done).toMatchObject({ code: 0, output: expect.stringContaining("SOZINHO") });
  }, 20_000);

  it("comando de peso 2 ocupa as duas vagas", async () => {
    const a = holder(["--peso", "2"], { AUTOMABACA_VEZ_VAGAS: "2" });
    await until(() => existsSync(path.join(dir, "dentro")));
    const b = vez(probe(), { AUTOMABACA_VEZ_VAGAS: "2" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    writeFileSync(path.join(dir, "solta"), "");
    await a.done;
    expect((await b.done).output).toContain("SOZINHO");
  }, 20_000);

  it("chamada aninhada usa a vaga de quem chamou e não espera", async () => {
    const a = holder([], { AUTOMABACA_VEZ_VAGAS: "1" });
    await until(() => existsSync(path.join(dir, "dentro")));
    const nested = await vez(probe(), { AUTOMABACA_VEZ_VAGAS: "1", AUTOMABACA_VEZ: "1" }).done;
    writeFileSync(path.join(dir, "solta"), "");
    await a.done;
    expect(nested.output).toContain("SOBREPOS");
  }, 20_000);

  it("desiste com erro claro quando a espera por vaga passa do teto", async () => {
    const a = holder([], { AUTOMABACA_VEZ_VAGAS: "1" });
    await until(() => existsSync(path.join(dir, "dentro")));
    const b = await vez(["--", "touch", path.join(dir, "rodou")], { AUTOMABACA_VEZ_VAGAS: "1", AUTOMABACA_VEZ_ESPERA_MAX_S: "1" }).done;
    writeFileSync(path.join(dir, "solta"), "");
    await a.done;
    expect(b.code).toBe(75);
    expect(b.output).toContain("sem vaga livre");
    expect(existsSync(path.join(dir, "rodou"))).toBe(false);
  }, 20_000);

  it("a vaga volta quando o processo que a segura morre", async () => {
    const a = vez(["--", "sleep", "60"], { AUTOMABACA_VEZ_VAGAS: "1" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    a.child.kill("SIGKILL");
    await a.done;
    const started = Date.now();
    expect((await vez(["--", "true"], { AUTOMABACA_VEZ_VAGAS: "1" }).done).code).toBe(0);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 20_000);

  it("devolve o código de saída do comando, inclusive sem conseguir abrir as vagas", async () => {
    expect((await vez(["--", "bash", "-c", "exit 7"]).done).code).toBe(7);
    const semVagas = await vez(["--", "bash", "-c", "exit 3"], { AUTOMABACA_VEZ_DIR: "/dev/null/vagas" }).done;
    expect(semVagas.code).toBe(3);
    expect(semVagas.output).toContain("rodando sem esperar a vez");
  }, 20_000);
});
