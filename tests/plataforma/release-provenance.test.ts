import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256, sourceSnapshot, verifyChecks } from "@/scripts/lib/release-provenance.mjs";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) safeRemoveTreeSync(tmpdir(), root); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "automabaca-release-")); roots.push(root);
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, ".gitignore"), ".env\nreports/\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init", "-b", "main"]); git(["add", "."]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"]);
  return root;
}
describe("rastreabilidade da release", () => {
  it("detecta fonte novo ou alterado e não lê segredos ignorados", () => {
    const root = fixture(); const before = sourceSnapshot(root);
    expect(before.dirty).toBe(false);
    writeFileSync(join(root, ".env"), "LOCAL_SECRET=private");
    expect(sourceSnapshot(root).sourceSha256).toBe(before.sourceSha256);
    writeFileSync(join(root, "app.ts"), "export const value = 1;");
    const next = sourceSnapshot(root);
    expect(next.sourceSha256).not.toBe(before.sourceSha256);
    expect(next.dirty).toBe(true);
    writeFileSync(join(root, "app.ts"), "export const value = 2;");
    expect(sourceSnapshot(root).sourceSha256).not.toBe(next.sourceSha256);
  });
  it("recusa gate faltante, falho e evidência de outro fonte", () => {
    const source = sourceSnapshot(fixture());
    const checks = ["static", "database", "browser", "build", "package"].map((name) => ({ name, source, exitCode: 0 }));
    expect(() => verifyChecks(source, checks)).not.toThrow();
    expect(() => verifyChecks(source, checks.slice(1))).toThrow(/static/);
    expect(() => verifyChecks(source, checks.map((c) => ({ ...c, exitCode: 1 })))).toThrow(/reprovada/);
    expect(() => verifyChecks({ ...source, sourceSha256: "alterado" }, checks)).toThrow(/Fonte mudou/);
  });
  it("verificação independente detecta alteração no pacote após emitir manifesto", () => {
    const root = fixture(); const source = sourceSnapshot(root);
    const folder = join(root, "reports/ci"); mkdirSync(folder, { recursive: true });
    const archive = "fixture de bytes de um artefato";
    writeFileSync(join(folder, "runtime.tar.gz"), archive);
    writeFileSync(join(folder, "runtime.json"), JSON.stringify({ source, archive: "runtime.tar.gz", sha256: sha256(archive) }));
    for (const name of ["static", "database", "browser", "build", "package"]) {
      writeFileSync(join(folder, `${name}.json`), JSON.stringify({ name, source, exitCode: 0 }));
    }
    const run = (script: string) => execFileSync(process.execPath, [join(process.cwd(), "scripts", script)], { cwd: root, stdio: "pipe" });
    expect(() => run("write-release-manifest.mjs")).not.toThrow();
    expect(() => run("verify-release.mjs")).not.toThrow();
    writeFileSync(join(folder, "runtime.tar.gz"), "alterado");
    expect(() => run("verify-release.mjs")).toThrow();
    expect(() => run("write-release-manifest.mjs")).toThrow();
  });
  it("aceita verificações reaproveitadas do PR só do commit declarado e com o mesmo fonte", () => {
    const root = fixture(); const source = sourceSnapshot(root);
    const folder = join(root, "reports/ci"); mkdirSync(folder, { recursive: true });
    const archive = "fixture de bytes de um artefato";
    writeFileSync(join(folder, "runtime.tar.gz"), archive);
    writeFileSync(join(folder, "runtime.json"), JSON.stringify({ source, archive: "runtime.tar.gz", sha256: sha256(archive) }));
    // Commit de teste do PR: outro SHA, mesma árvore (e portanto mesmo fonte).
    const testado = { ...source, commit: "f".repeat(40) };
    const gravar = (reaproveitadas: typeof source) => {
      for (const name of ["static", "database", "browser"]) {
        writeFileSync(join(folder, `${name}.json`), JSON.stringify({ name, source: reaproveitadas, exitCode: 0 }));
      }
      for (const name of ["build", "package"]) {
        writeFileSync(join(folder, `${name}.json`), JSON.stringify({ name, source, exitCode: 0 }));
      }
    };
    const run = (env: Record<string, string>) => execFileSync(process.execPath,
      [join(process.cwd(), "scripts", "write-release-manifest.mjs")],
      { cwd: root, stdio: "pipe", env: { ...process.env, CI_REAPROVEITADO_RUN: "", CI_REAPROVEITADO_COMMIT: "", ...env } });
    const reuso = { CI_REAPROVEITADO_RUN: "123", CI_REAPROVEITADO_COMMIT: testado.commit };

    gravar(testado);
    expect(() => run({})).toThrow(/é do commit f+, esperado/);
    expect(() => run({ ...reuso, CI_REAPROVEITADO_COMMIT: "e".repeat(40) })).toThrow(/é do commit f+, esperado e+/);
    expect(() => run(reuso)).not.toThrow();
    const manifesto = JSON.parse(readFileSync(join(folder, "release-manifest.json"), "utf8"));
    expect(manifesto.reusedChecks).toEqual({ fromRun: "123", commit: testado.commit, names: ["static", "database", "browser"] });
    expect(manifesto.source.commit).toBe(source.commit);

    gravar({ ...testado, sourceSha256: "outro fonte" });
    expect(() => run(reuso)).toThrow();
  });
});
