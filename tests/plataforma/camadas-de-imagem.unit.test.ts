import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comandosOperacionais } from "@/scripts/montar-camadas-de-imagem.mjs";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "automabaca-camadas-test-"));
  mkdirSync(join(repo, "scripts"));
});

afterEach(() => {
  safeRemoveTreeSync(tmpdir(), repo);
});

/**
 * A montagem das camadas é a fronteira entre "existe no repositório" e "viaja
 * na imagem": um comando operacional que ficasse de fora só quebraria no dia em
 * que alguém precisasse dele para mexer numa aposta.
 */
describe("Comandos operacionais que viajam na imagem do worker", () => {
  it("são todos os scripts/ops-*.ts, e só eles", () => {
    for (const nome of ["ops-settle.ts", "ops-apagar-filas.ts", "ops-settle.test.ts", "ops-velho.mjs", "build-worker.mjs", "seed.ts"]) {
      writeFileSync(join(repo, "scripts", nome), "");
    }
    expect(comandosOperacionais(repo)).toEqual(["ops-apagar-filas", "ops-settle"]);
  });

  it("o repositório de verdade tem o ops-settle, que o AGENTS.md manda usar para liquidar", () => {
    expect(comandosOperacionais()).toContain("ops-settle");
  });
});
