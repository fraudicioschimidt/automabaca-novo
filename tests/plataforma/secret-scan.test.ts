import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeRemoveTreeSync } from "../../scripts/lib/safe-fs.mjs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "automabaca-secret-scan-test-"));
});

afterEach(() => {
  safeRemoveTreeSync(tmpdir(), dir);
});

function scan(content: string): { status: number | null; output: string } {
  const file = path.join(dir, "arquivo.txt");
  writeFileSync(file, content);
  const run = spawnSync(process.execPath, ["scripts/secret-scan.mjs", "--files", file], { encoding: "utf8" });
  return { status: run.status, output: run.stdout + run.stderr };
}

// Montados em pedaços: o texto inteiro neste arquivo reprovaria a própria varredura.
const SECRETS: Record<string, string> = {
  "chave da Groq": "GROQ_API_KEY=" + "gsk_" + "a1B2".repeat(13),
  "chave privada do age": "AGE-SECRET-" + "KEY-1" + "Q7".repeat(29),
  "chave da RapidAPI": "0123456789" + "msh" + "0123456789abcde" + "p1" + "abc123" + "jsn" + "0123456789ab",
  "URL de banco com senha": "postgresql" + "://automabaca_novo:" + "s3nhaDeVerdade" + "@db:5432/automabaca_novo",
  "token do Telegram": "123456789" + ":" + "A".repeat(35),
};

describe("secret-scan.mjs", () => {
  it.each(Object.entries(SECRETS))("reprova %s", (_name, secret) => {
    const result = scan(`antes\n${secret}\ndepois\n`);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("segredo provável");
  });

  it("deixa passar os endereços locais dos exemplos e o URL montado por variável", () => {
    const local = [
      "postgresql" + "://USUARIO:SENHA@localhost:5432/automabaca",
      "postgresql" + "://postgres:postgres@127.0.0.1:5433/automabaca_test",
      "postgresql" + "://${user}:${password}@${host}/banco",
      "GROQ_API_KEY=",
    ].join("\n");
    expect(scan(local)).toMatchObject({ status: 0 });
  });
});
