import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeRemoveTreeSync } from "../../scripts/lib/safe-fs.mjs";

const SCRIPT = path.resolve("scripts/worktree.sh");

let dir: string;
let principal: string;
let ambiente: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ambiente, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function worktree(args: string[], env: Record<string, string> = {}): { code: number | null; saida: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], { cwd: principal, env: { ...ambiente, ...env }, encoding: "utf8" });
  return { code: r.status, saida: `${r.stdout}${r.stderr}` };
}

function executavel(arquivo: string, conteudo: string): void {
  writeFileSync(arquivo, conteudo);
  chmodSync(arquivo, 0o755);
}

// Nada escuta no 127.0.0.2:1, e a conexão é recusada na hora (no 127.0.0.1, a
// rede espelhada do WSL deixa esperando): o `remover` não toca o PostgreSQL da
// máquina.
const SEM_SERVIDOR = { AUTOMABACA_TEST_DB_PORT: "1" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "automabaca-worktree-test-"));
  principal = path.join(dir, "automabaca-novo");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  // `npx prisma generate`, o build da ponte Rust e o `gh` são de mentira; o git é de verdade.
  executavel(path.join(bin, "npx"), `#!/usr/bin/env bash\necho "$PWD $*" >> "${dir}/npx.log"\n`);
  executavel(path.join(bin, "npm"), `#!/usr/bin/env bash\necho "$PWD $*" >> "${dir}/npm.log"\n`);
  executavel(path.join(bin, "gh"), `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\nprintf '%s' "\${GH_MERGEADOS:-}"\n`);
  ambiente = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "teste",
    GIT_AUTHOR_EMAIL: "teste@example.invalid",
    GIT_COMMITTER_NAME: "teste",
    GIT_COMMITTER_EMAIL: "teste@example.invalid",
  };
  delete ambiente.AUTOMABACA_TEST_DB_PORT;

  git(dir, "init", "-q", "--bare", "-b", "main", "origem.git");
  git(dir, "init", "-q", "-b", "main", principal);
  writeFileSync(path.join(principal, ".gitignore"), ".env\nnode_modules\n");
  git(principal, "add", ".gitignore");
  git(principal, "commit", "-q", "-m", "inicio");
  git(principal, "remote", "add", "origin", path.join(dir, "origem.git"));
  git(principal, "push", "-q", "-u", "origin", "main");
  mkdirSync(path.join(principal, "node_modules"));
  writeFileSync(path.join(principal, "node_modules", "marca"), "");
  writeFileSync(
    path.join(principal, ".env"),
    'TEST_DATABASE_URL="postgresql://automabaca:segredo@127.0.0.2:5433/automabaca_test"\nLOG_LEVEL=debug\n',
  );
});

afterEach(() => {
  safeRemoveTreeSync(tmpdir(), dir);
});

const wt = () => path.join(dir, "wt-clv");

function commitNaWorktree(mensagem: string): string {
  writeFileSync(path.join(wt(), `${mensagem.replaceAll(" ", "-")}.txt`), mensagem);
  git(wt(), "add", ".");
  git(wt(), "commit", "-q", "-m", mensagem);
  return git(wt(), "rev-parse", "HEAD");
}

describe("worktree.sh nova", () => {
  it("cria a worktree da origin/main ligada à principal, com o banco de teste dela", () => {
    const { code, saida } = worktree(["nova", "clv", "feat/clv"]);
    expect(code, saida).toBe(0);

    expect(git(wt(), "rev-parse", "HEAD")).toBe(git(principal, "rev-parse", "origin/main"));
    expect(git(wt(), "branch", "--show-current")).toBe("feat/clv");
    // Sem upstream: o primeiro push cria a branch remota com o mesmo nome.
    expect(() => git(wt(), "rev-parse", "--abbrev-ref", "feat/clv@{upstream}")).toThrow();
    expect(readlinkSync(path.join(wt(), "node_modules"))).toBe("../automabaca-novo/node_modules");
    expect(readFileSync(path.join(wt(), ".env"), "utf8")).toBe(
      'TEST_DATABASE_URL="postgresql://automabaca:segredo@127.0.0.2:5433/automabaca_test_clv"\nLOG_LEVEL=debug\n',
    );
    expect(statSync(path.join(wt(), ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(dir, "npx.log"), "utf8")).toBe(`${wt()} prisma generate\n`);
    expect(readFileSync(path.join(dir, "npm.log"), "utf8")).toBe(`${wt()} run --silent build:dominio-node\n`);
    expect(saida).toContain("automabaca_test_clv");
  });

  it("com --build, a worktree já nasce com o node_modules copiado com hardlinks", () => {
    const { code, saida } = worktree(["nova", "clv", "feat/clv", "--build"]);
    expect(code, saida).toBe(0);
    expect(lstatSync(path.join(wt(), "node_modules")).isDirectory()).toBe(true);
    expect(statSync(path.join(wt(), "node_modules", "marca")).ino)
      .toBe(statSync(path.join(principal, "node_modules", "marca")).ino);
    expect(git(wt(), "branch", "--show-current")).toBe("feat/clv");
  });

  it.each(["Clv", "rotinas_deploy", "x/../wt-outra"])("recusa, sem criar nada, a tarefa %j fora do padrão", (tarefa) => {
    const { code, saida } = worktree(["nova", tarefa, "feat/x"]);
    expect(code).toBe(1);
    expect(saida).toContain("Tarefa inválida");
    expect(readdirSync(dir).filter((nome) => nome.startsWith("wt-"))).toEqual([]);
    expect(git(principal, "branch", "--list", "feat/x")).toBe("");
  });

  it("recusa a tarefa cuja base já é de outra pasta wt-*, mesmo criada à mão", () => {
    mkdirSync(path.join(dir, "wt-Rotinas_Deploy"));
    const { code, saida } = worktree(["nova", "rotinas-deploy", "feat/x"]);
    expect(code).toBe(1);
    expect(saida).toContain("wt-Rotinas_Deploy");
    expect(existsSync(path.join(dir, "wt-rotinas-deploy"))).toBe(false);
  });

  it("recusa, sem criar nada, a tarefa cujo banco seria de outra família", () => {
    const { code, saida } = worktree(["nova", "fix-2", "feat/x"]);
    expect(code).toBe(1);
    expect(saida).toMatch(/número/);
    expect(existsSync(path.join(dir, "wt-fix-2"))).toBe(false);
    expect(git(principal, "branch", "--list", "feat/x")).toBe("");
  });
});

describe("worktree.sh build", () => {
  it("troca o link do node_modules por hardlinks, e a remoção não leva os arquivos da principal", () => {
    expect(worktree(["nova", "clv", "feat/clv"]).code).toBe(0);
    // O Turbopack recusa node_modules que aponta para fora da worktree.
    expect(lstatSync(path.join(wt(), "node_modules")).isSymbolicLink()).toBe(true);

    const { code, saida } = worktree(["build", "clv"]);
    expect(code, saida).toBe(0);
    expect(lstatSync(path.join(wt(), "node_modules")).isDirectory()).toBe(true);
    expect(statSync(path.join(wt(), "node_modules", "marca")).ino)
      .toBe(statSync(path.join(principal, "node_modules", "marca")).ino);
    expect(worktree(["build", "clv"]).saida).toContain("já é uma pasta");

    expect(worktree(["remover", "clv"], SEM_SERVIDOR).code).toBe(0);
    expect(existsSync(wt())).toBe(false);
    expect(existsSync(path.join(principal, "node_modules", "marca"))).toBe(true);
  });

  it("recusa tarefa fora do padrão, que levaria a outra pasta", () => {
    expect(worktree(["nova", "clv", "feat/clv"]).code).toBe(0);
    mkdirSync(path.join(dir, "wt-x"));
    const { code, saida } = worktree(["build", "x/../wt-clv"]);
    expect(code).toBe(1);
    expect(saida).toContain("Tarefa inválida");
    expect(lstatSync(path.join(wt(), "node_modules")).isSymbolicLink()).toBe(true);
  });

  it("recusa pasta que não é worktree do repositório", () => {
    mkdirSync(path.join(dir, "wt-outra"));
    const { code, saida } = worktree(["build", "outra"]);
    expect(code).toBe(1);
    expect(saida).toContain("não é uma worktree");
  });
});

describe("worktree.sh remover", () => {
  beforeEach(() => {
    const { code, saida } = worktree(["nova", "clv", "feat/clv"]);
    expect(code, saida).toBe(0);
  });

  it("recusa arquivo sem commit e mostra qual", () => {
    writeFileSync(path.join(wt(), "rascunho.txt"), "de outra sessão");
    const { code, saida } = worktree(["remover", "clv"], SEM_SERVIDOR);
    expect(code).toBe(1);
    expect(saida).toContain("rascunho.txt");
    expect(existsSync(wt())).toBe(true);
  });

  it("recusa tarefa fora do padrão, que levaria a outra pasta", () => {
    mkdirSync(path.join(dir, "wt-x"));
    const { code, saida } = worktree(["remover", "x/../wt-clv"], SEM_SERVIDOR);
    expect(code).toBe(1);
    expect(saida).toContain("Tarefa inválida");
    expect(existsSync(wt())).toBe(true);
  });

  it("commit que só está em outro remoto não conta como enviado ao GitHub", () => {
    commitNaWorktree("trabalho no espelho");
    git(dir, "init", "-q", "--bare", "-b", "main", "espelho.git");
    git(principal, "remote", "add", "espelho", path.join(dir, "espelho.git"));
    git(wt(), "push", "-q", "espelho", "feat/clv");
    const { code, saida } = worktree(["remover", "clv"], SEM_SERVIDOR);
    expect(code).toBe(1);
    expect(saida).toContain("trabalho no espelho");
    expect(existsSync(wt())).toBe(true);
  });

  it("recusa commit que não está no GitHub e mostra qual", () => {
    commitNaWorktree("trabalho local");
    const { code, saida } = worktree(["remover", "clv"], SEM_SERVIDOR);
    expect(code).toBe(1);
    expect(saida).toContain("trabalho local");
    expect(existsSync(wt())).toBe(true);
  });

  it("com o commit numa branch remota, remove a worktree e mantém a branch fora da main", () => {
    commitNaWorktree("trabalho enviado");
    git(wt(), "push", "-q", "origin", "feat/clv");
    const { code, saida } = worktree(["remover", "clv"], SEM_SERVIDOR);
    expect(code, saida).toBe(0);
    expect(existsSync(wt())).toBe(false);
    expect(git(principal, "branch", "--list", "feat/clv")).not.toBe("");
    expect(saida).toContain("mantida");
    expect(saida).toContain("sem conexão com o servidor de teste");
    // O link some sem levar o node_modules da árvore principal junto.
    expect(existsSync(path.join(principal, "node_modules", "marca"))).toBe(true);
  });

  it("apaga a branch que entrou na main por PR mergeado, mesmo com a branch remota apagada", () => {
    // Squash + delete_branch_on_merge: o commit só fica no pull/<n>/head do GitHub.
    const commit = commitNaWorktree("trabalho do pr");
    git(wt(), "push", "-q", "origin", "HEAD:refs/pull/7/head");
    const { code, saida } = worktree(["remover", "clv"], { ...SEM_SERVIDOR, GH_MERGEADOS: `7 ${commit}\n` });
    expect(code, saida).toBe(0);
    expect(existsSync(wt())).toBe(false);
    expect(git(principal, "branch", "--list", "feat/clv")).toBe("");
    expect(saida).toContain("PR #7");
    expect(readFileSync(path.join(dir, "gh.log"), "utf8")).toContain("--head feat/clv");
  });

  it("não aceita PR mergeado que não contém o último commit", () => {
    const doPr = commitNaWorktree("trabalho do pr");
    git(wt(), "push", "-q", "origin", "HEAD:refs/pull/7/head");
    commitNaWorktree("depois do merge");
    const { code, saida } = worktree(["remover", "clv"], { ...SEM_SERVIDOR, GH_MERGEADOS: `7 ${doPr}\n` });
    expect(code).toBe(1);
    expect(saida).toContain("depois do merge");
    expect(existsSync(wt())).toBe(true);
  });

  it("apaga a branch sem commit próprio", () => {
    const { code, saida } = worktree(["remover", "clv"], SEM_SERVIDOR);
    expect(code, saida).toBe(0);
    expect(existsSync(wt())).toBe(false);
    expect(git(principal, "branch", "--list", "feat/clv")).toBe("");
  });
});

describe("worktree.sh podar", () => {
  it("sem servidor de teste, avisa e não falha", () => {
    expect(worktree(["nova", "clv", "feat/clv"]).code).toBe(0);
    const { code, saida } = worktree(["podar"], SEM_SERVIDOR);
    expect(code, saida).toBe(0);
    expect(saida).toContain("sem conexão com o servidor de teste");
  });
});
