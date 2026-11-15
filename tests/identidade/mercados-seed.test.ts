import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MERCADOS_FINAIS, normalizeMercadoKey } from "@/src/domain/mercados/catalog";
import { MERCADO_CATALOG } from "@/src/domain/mercados/catalog-data";

describe("seed de mercados", () => {
  it("catálogo final e seed têm exatamente o mesmo conjunto", () => {
    expect(Object.keys(MERCADO_CATALOG)).toEqual([...MERCADOS_FINAIS]);
  });

  it("o mesmo alias+casa não aponta para dois canônicos", () => {
    const visto = new Map<string, string>();
    const choques: string[] = [];
    for (const [nome, aliases] of Object.entries(MERCADO_CATALOG)) {
      for (const entry of aliases) {
        const casaDeAposta = "casaDeAposta" in entry ? entry.casaDeAposta : "";
        const chave = `${normalizeMercadoKey(entry.alias)}|${normalizeMercadoKey(casaDeAposta ?? "")}`;
        const anterior = visto.get(chave);
        if (anterior && anterior !== nome) {
          choques.push(`${chave}: ${anterior} vs ${nome}`);
        }
        visto.set(chave, nome);
      }
    }
    expect(choques).toEqual([]);
  });
});

const ROOT = path.resolve(__dirname, "../..");
// Socket inexistente: o seed que passar da trava falha na hora ao conectar e
// nunca grava (porta TCP fechada pode ficar pendurada, conforme a rede).
const UNREACHABLE_DB = "postgresql://seed:seed@localhost/nenhum?host=/nonexistent-automabaca";

function runSeed(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, DATABASE_URL: UNREACHABLE_DB, AUTOMABACA_PROCESS: "", ...env },
  });
  return { status: result.status, stderr: result.stderr };
}

describe("prisma/seed.ts", () => {
  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["processo do worker", { NODE_ENV: "development", AUTOMABACA_PROCESS: "worker" }],
  ])("recusa em produção (%s) e aponta o caminho auditado, sem abrir conexão", (_, env) => {
    const { status, stderr } = runSeed(env);
    expect(status).toBe(1);
    expect(stderr).toContain("ops-sincronizar-mercados");
    expect(stderr).not.toContain("Seed falhou");
  }, 60_000);

  it("em desenvolvimento segue para o banco", () => {
    const { status, stderr } = runSeed({ NODE_ENV: "development" });
    expect(status).toBe(1);
    expect(stderr).toContain("Seed falhou");
    expect(stderr).not.toContain("ops-sincronizar-mercados");
  }, 60_000);
});
