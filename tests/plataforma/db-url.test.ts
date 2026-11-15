import { describe, expect, it } from "vitest";
import { resolveTestDatabaseName, resolveTestDatabaseUrlFrom, selectTestClusterUrl } from "../helpers/db-url";

const FILE = { TEST_DATABASE_URL: "postgresql://file:x@wrong-cluster.invalid:5432/automabaca_test" };
const SHELL = { TEST_DATABASE_URL: "postgresql://shell:x@isolated.invalid:55443/automabaca_test" };
const WORKTREE = { TEST_DATABASE_URL: "postgresql://automabaca:x@127.0.0.1:5433/automabaca_test_wtclv" };

describe("cluster de teste (A05)", () => {
  it("o TEST_DATABASE_URL do processo vence o do arquivo", () => {
    expect(selectTestClusterUrl(SHELL, FILE)).toBe(SHELL.TEST_DATABASE_URL);
    expect(selectTestClusterUrl({}, FILE)).toBe(FILE.TEST_DATABASE_URL);
    expect(selectTestClusterUrl({ DATABASE_URL: "postgresql://a:b@production-example.invalid/production" }, {}))
      .toBeUndefined();
  });

  it("suíte db recusa cair na DATABASE_URL de produção", () => {
    expect(() => resolveTestDatabaseUrlFrom(
      { VITEST_DB_PARALLEL: "1", DATABASE_URL: "postgresql://a:b@production-example.invalid/production_example" },
      {},
    )).toThrow(/TEST_DATABASE_URL/);
  });

  it("suíte db usa o host do TEST_DATABASE_URL e só troca o nome do banco", () => {
    const url = resolveTestDatabaseUrlFrom(
      { VITEST_DB_PARALLEL: "1", VITEST_POOL_ID: "2", ...SHELL },
      FILE,
    );
    expect(url).toContain("@isolated.invalid:55443/automabaca_test_2");
    expect(url).not.toContain("wrong-cluster");
  });

  it("unitários sem cluster real recebem placeholder e não exigem Postgres", () => {
    expect(resolveTestDatabaseUrlFrom({}, {})).toBe("postgresql://test:test@localhost:5432/automabaca_test");
  });

  it("recusa VITEST_POOL_ID que não seja número de worker", () => {
    expect(() => resolveTestDatabaseName("automabaca_test", { VITEST_DB_PARALLEL: "1", VITEST_POOL_ID: "../../etc" }))
      .toThrow("VITEST_POOL_ID inválido");
  });
});

describe("banco de cada worktree", () => {
  it("a base é o banco do TEST_DATABASE_URL, e cada worker ganha o seu clone", () => {
    expect(resolveTestDatabaseUrlFrom({ VITEST_DB_PARALLEL: "1", VITEST_POOL_ID: "3", ...WORKTREE }, {}))
      .toBe("postgresql://automabaca:x@127.0.0.1:5433/automabaca_test_wtclv_3");
    // O global-setup e o projeto unit ficam com o banco-base.
    expect(resolveTestDatabaseUrlFrom(WORKTREE, {})).toBe(WORKTREE.TEST_DATABASE_URL);
  });

  it.each([
    "automabaca_test_clv_1", // clone do worker 1 da base automabaca_test_clv
    "automabaca_test_template",
    "automabaca_test_clv_e2e",
    "automabaca_test_e2e_clv",
    "automabaca_test-clv",
    "automabaca_test_Clv",
    `automabaca_test_${"a".repeat(40)}`,
    "automabaca",
    "postgres",
  ])("recusa a base %s, que colidiria com outra família ou não é de teste", (banco) => {
    const env = { VITEST_DB_PARALLEL: "1", VITEST_POOL_ID: "1", TEST_DATABASE_URL: `postgresql://u:p@localhost:5433/${banco}` };
    expect(() => resolveTestDatabaseUrlFrom(env, {})).toThrow(/recusado/);
  });
});
