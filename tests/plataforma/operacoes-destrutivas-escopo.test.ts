import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanDestructiveOps } from "@/scripts/check-destructive-ops.mjs";

// `security:destructive` barra remoção recursiva fora dos helpers fail-closed
// (`scripts/lib/safe-*`); estes casos garantem que ele pega e que não acusa
// os próprios helpers nem worktrees de outra sessão.

function repoFalso(): string {
  const raiz = mkdtempSync(path.join(tmpdir(), "ab-destrutivo-"));
  mkdirSync(path.join(raiz, "scripts", "lib"), { recursive: true });
  return raiz;
}

function escrever(raiz: string, rel: string, conteudo: string): void {
  const destino = path.join(raiz, rel);
  mkdirSync(path.dirname(destino), { recursive: true });
  writeFileSync(destino, conteudo);
}

const REMOCAO_RECURSIVA = 'limpar() {\n  rm -rf "$alvo"\n}\n';
const REMOCAO_NODE = 'import { rmSync } from "node:fs";\nrmSync(alvo, { recursive: true, force: true });\n';

describe("escopo da varredura de operações destrutivas", () => {
  it("pega remoção recursiva em script comum", () => {
    const raiz = repoFalso();
    escrever(raiz, "scripts/deploy-falso.sh", REMOCAO_RECURSIVA);
    const { violations } = scanDestructiveOps(raiz);
    expect(violations.join("\n")).toContain("scripts/deploy-falso.sh");
  });

  /**
   * Uma âncora `^` no regex exigiria `rm` colado no início da linha, e TODO
   * `rm -rf` indentado passaria — dentro de função, dentro de `if`, com tab —,
   * que é justamente onde se escreve `rm -rf` na vida real.
   */
  it.each([
    ["sem indentação", 'rm -rf "$alvo"\n'],
    ["indentado com espaços", 'limpar() {\n  rm -rf "$alvo"\n}\n'],
    ["dentro de if", 'if [ -d x ]; then\n    rm -rf x\nfi\n'],
    ["com tab", 'f() {\n\trm -rf /tmp/x\n}\n'],
    ["depois de ponto-e-vírgula", 'cd /tmp; rm -rf x\n'],
    ["forma longa --recursive", '  rm --recursive /tmp/x\n'],
  ])("pega `rm -r` %s", (_nome, fonte) => {
    const raiz = repoFalso();
    escrever(raiz, "scripts/perigoso.sh", fonte);
    expect(scanDestructiveOps(raiz).violations.length).toBeGreaterThan(0);
  });

  it.each([
    ["comentário", "# rm -rf perigoso\n"],
    ["rm não recursivo", "  rm arquivo.txt\n"],
  ])("NÃO acusa %s", (_nome, fonte) => {
    // Falso positivo treina quem publica a contornar o gate — custa a defesa
    // inteira, não só o comando.
    const raiz = repoFalso();
    escrever(raiz, "scripts/inocente.sh", fonte);
    expect(scanDestructiveOps(raiz).violations).toEqual([]);
  });

  it("os helpers fail-closed são a exceção — não podem se acusar", () => {
    const raiz = repoFalso();
    escrever(raiz, "scripts/lib/safe-delete.sh", REMOCAO_RECURSIVA);
    escrever(raiz, "scripts/lib/safe-fs.mjs", REMOCAO_NODE);
    expect(scanDestructiveOps(raiz).violations).toEqual([]);
  });

  it("worktree de agente fica fora: é outro checkout, com gate próprio", () => {
    // Dentro da worktree os helpers perderiam a exceção (a allowlist casa
    // caminho exato) e o gate reprovaria a publicação de quem não os tocou.
    const raiz = repoFalso();
    escrever(raiz, ".claude/worktrees/sessao-x/scripts/lib/safe-delete.sh", REMOCAO_RECURSIVA);
    escrever(raiz, ".claude/worktrees/sessao-x/scripts/qualquer.sh", REMOCAO_RECURSIVA);
    const { violations, files } = scanDestructiveOps(raiz) as { violations: string[]; files: string[] };
    expect(violations).toEqual([]);
    expect(files.some((arquivo) => arquivo.includes("worktrees"))).toBe(false);
  });

  it("artefatos gerados ficam fora: não são código-fonte executável", () => {
    const raiz = repoFalso();
    escrever(raiz, "artifacts/auditoria/relatorio.md", REMOCAO_NODE);
    const { violations, files } = scanDestructiveOps(raiz) as { violations: string[]; files: string[] };
    expect(violations).toEqual([]);
    expect(files.some((arquivo) => arquivo.startsWith("artifacts/"))).toBe(false);
  });

  it("o RESTO de .claude continua varrido — hook com rm -rf é risco real", () => {
    const raiz = repoFalso();
    escrever(raiz, ".claude/hooks/pos-commit.sh", REMOCAO_RECURSIVA);
    expect(scanDestructiveOps(raiz).violations.join("\n")).toContain(".claude/hooks/pos-commit.sh");
  });
});
