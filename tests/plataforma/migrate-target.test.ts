import { describe, expect, it } from "vitest";
import { assertAuthoringDatabase, resolveMigrateDatabaseUrl } from "@/scripts/lib/migrate-target.mjs";

/**
 * Autoria de migration não toca a produção.
 *
 * `prisma migrate dev` gera E APLICA. Lendo a `DATABASE_URL`, toda migration
 * chegaria à produção no instante em que é escrita — antes do CI, do gate e do
 * deploy. Um `DROP` ou um `NOT NULL` sem default faria estrago sem rollback:
 * trocar a imagem reverte código, não DDL.
 *
 * Prosa não previne. Este portão reprova a CLASSE: qualquer resolução de alvo
 * que aponte para o banco de produção falha aqui.
 */

const PRODUCAO = "postgresql://automabaca:s@localhost:5432/automabaca";
const TESTE = "postgresql://automabaca:s@localhost:5433/automabaca_test";

const alvo = (env: Record<string, string | undefined>) =>
  resolveMigrateDatabaseUrl(env) as { url: string; avisos: string[] };

describe("alvo de autoria de migration", () => {
  it("deriva o banco descartável do cluster de teste", () => {
    const { url, avisos } = alvo({ DATABASE_URL: PRODUCAO, TEST_DATABASE_URL: TESTE });
    expect(url).toBe("postgresql://automabaca:s@localhost:5433/automabaca_migrate");
    expect(avisos).toEqual([]);
  });

  it("numa worktree, o banco de autoria é o da família dela", () => {
    // Duas autorias no servidor compartilhado não zeram o banco uma da outra.
    const { url } = alvo({
      DATABASE_URL: PRODUCAO,
      TEST_DATABASE_URL: "postgresql://automabaca:s@localhost:5433/automabaca_test_wtclv",
    });
    expect(url).toBe("postgresql://automabaca:s@localhost:5433/automabaca_test_wtclv_migrate");
  });

  it("descarta a query do TEST_DATABASE_URL, que desviaria a conexão administrativa", () => {
    // O `pg` aceita `?host=` e `?port=` por cima do host do URL: a conferência
    // contra a produção olharia um host, e a conexão iria para outro.
    const { url } = alvo({
      DATABASE_URL: PRODUCAO,
      TEST_DATABASE_URL: "postgresql://automabaca:s@localhost:5433/automabaca_test?host=localhost&port=5432",
    });
    expect(url).toBe("postgresql://automabaca:s@localhost:5433/automabaca_migrate");
  });

  it("só aceita zerar o banco de autoria exato da família do TEST_DATABASE_URL", () => {
    const env = { TEST_DATABASE_URL: "postgresql://automabaca:s@localhost:5433/automabaca_test_clv" };
    const url = (banco: string) => `postgresql://automabaca:s@localhost:5433/${banco}`;
    expect(assertAuthoringDatabase(url("automabaca_test_clv_migrate"), env)).toBe("automabaca_test_clv_migrate");
    // Terminar em `migrate` e ser descartável não basta: estes são de outra família.
    for (const banco of ["automabaca_test_outra_migrate", "automabaca_migrate", "automabaca_test_clvmigrate"]) {
      expect(() => assertAuthoringDatabase(url(banco), env), banco).toThrow(/banco de autoria inesperado/);
    }
  });

  it("nunca devolve o banco de produção", () => {
    const { url } = alvo({ DATABASE_URL: PRODUCAO, TEST_DATABASE_URL: TESTE });
    const derivado = new URL(url);
    const producao = new URL(PRODUCAO);
    expect(
      derivado.hostname === producao.hostname &&
        derivado.port === producao.port &&
        derivado.pathname === producao.pathname,
    ).toBe(false);
  });

  it("recusa quando o alvo derivado É a produção", () => {
    // Cluster de teste mal configurado, no host e porta da produção: o caso em
    // que a derivação silenciosa causaria o dano.
    expect(() =>
      alvo({
        DATABASE_URL: "postgresql://a:s@localhost:5432/automabaca_migrate",
        TEST_DATABASE_URL: "postgresql://a:s@localhost:5432/automabaca_test",
      }),
    ).toThrow(/produção/);
  });

  it("recusa TEST_DATABASE_URL que aponta para um banco que não é de teste", () => {
    expect(() => alvo({ DATABASE_URL: PRODUCAO, TEST_DATABASE_URL: PRODUCAO })).toThrow(/recusado \(automabaca\)/);
  });

  it("recusa sem TEST_DATABASE_URL em vez de cair na produção", () => {
    // Fail-closed: a ausência do cluster de teste não pode virar "usa o que
    // tiver".
    expect(() => alvo({ DATABASE_URL: PRODUCAO })).toThrow(/TEST_DATABASE_URL/);
  });

  it("avisa (sem recusar) quando autoria e produção dividem o cluster", () => {
    const { url, avisos } = alvo({
      DATABASE_URL: PRODUCAO,
      TEST_DATABASE_URL: "postgresql://automabaca:s@localhost:5432/automabaca_test",
    });
    expect(url).toContain("automabaca_migrate");
    expect(avisos.join(" ")).toMatch(/MESMO cluster/);
  });

  it("recusa URL inválida em vez de montar alvo pela metade", () => {
    expect(() => alvo({ TEST_DATABASE_URL: "nao-e-url" })).toThrow(/URL/);
    expect(() => alvo({ DATABASE_URL: "nao-e-url", TEST_DATABASE_URL: TESTE })).toThrow(/URL/);
  });
});
