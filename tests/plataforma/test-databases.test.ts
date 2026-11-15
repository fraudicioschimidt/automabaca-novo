import { describe, expect, it } from "vitest";
import {
  assertDisposableDatabaseName,
  belongsToFamily,
  e2eDatabaseName,
  e2eDatabaseUrl,
  familyBaseOf,
  migrateDatabaseName,
  quoteDisposableDatabaseName,
  suiteDatabaseNames,
  suiteLockKey,
  testDatabaseBaseFromUrl,
  worktreeEnvText,
  worktreeSharingBase,
  worktreeTestDatabaseBase,
} from "../../scripts/lib/test-databases.mjs";

describe("família de bancos de uma base", () => {
  it("a base de uma worktree nomeia os bancos da suíte, do navegador e da autoria de migration", () => {
    expect(suiteDatabaseNames("automabaca_test_wtclv", 2)).toEqual([
      "automabaca_test_wtclv",
      "automabaca_test_wtclv_template",
      "automabaca_test_wtclv_upgrade",
      "automabaca_test_wtclv_1",
      "automabaca_test_wtclv_2",
    ]);
    expect(e2eDatabaseUrl("postgresql://automabaca:x@127.0.0.1:5433/automabaca_test_wtclv"))
      .toBe("postgresql://automabaca:x@127.0.0.1:5433/automabaca_test_wtclv_e2e");
    expect(migrateDatabaseName("automabaca_test_wtclv")).toBe("automabaca_test_wtclv_migrate");
  });

  it("a base padrão, da CI e do dev:setup, fica com os nomes e a trava de sempre", () => {
    expect(suiteDatabaseNames("automabaca_test", 2)).toEqual([
      "automabaca_test",
      "automabaca_test_template",
      "automabaca_test_upgrade",
      "automabaca_test_1",
      "automabaca_test_2",
    ]);
    expect(suiteLockKey("automabaca_test")).toBe("automabaca:test:db-suite");
    expect(e2eDatabaseUrl("postgresql://u:p@localhost:5433/automabaca_test"))
      .toBe("postgresql://u:p@localhost:5433/automabaca_e2e");
    // O job de navegador da CI sobe o PostgreSQL já com o banco e2e.
    expect(e2eDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:51451/automabaca_e2e"))
      .toBe("postgresql://postgres:postgres@127.0.0.1:51451/automabaca_e2e");
    expect(migrateDatabaseName("automabaca_test")).toBe("automabaca_migrate");
    expect(testDatabaseBaseFromUrl("postgresql://u:p@localhost:5433")).toBe("automabaca_test");
  });

  it("bases diferentes não dividem trava nem banco", () => {
    const bases = ["automabaca_test", "automabaca_test_clv", "automabaca_test_clv2", "automabaca_test_clv_rotinas"];
    expect(new Set(bases.map(suiteLockKey)).size).toBe(bases.length);
    const nomes = bases.flatMap((base) => [
      ...suiteDatabaseNames(base, 6), e2eDatabaseName(base), migrateDatabaseName(base),
    ]);
    expect(new Set(nomes).size).toBe(nomes.length);
    // Apagar a família de uma worktree não leva a de outra que começa igual.
    expect(belongsToFamily("automabaca_test_clv_e2e", "automabaca_test_clv")).toBe(true);
    expect(belongsToFamily("automabaca_test_clv_4", "automabaca_test_clv")).toBe(true);
    expect(belongsToFamily("automabaca_test_clv2_1", "automabaca_test_clv")).toBe(false);
    expect(belongsToFamily("automabaca_test_clv_rotinas", "automabaca_test_clv")).toBe(false);
    expect(belongsToFamily("automabaca_test_clv_rotinas_1", "automabaca_test_clv")).toBe(false);
  });

  it("cada banco de teste volta à base da sua família", () => {
    expect(familyBaseOf("automabaca_test_clv")).toBe("automabaca_test_clv");
    expect(familyBaseOf("automabaca_test_clv_3")).toBe("automabaca_test_clv");
    expect(familyBaseOf("automabaca_test_rotinas_deploy_template")).toBe("automabaca_test_rotinas_deploy");
    expect(familyBaseOf("automabaca_test_clv_e2e")).toBe("automabaca_test_clv");
    expect(familyBaseOf("automabaca_test_clv_migrate")).toBe("automabaca_test_clv");
    expect(familyBaseOf("automabaca_test_2")).toBe("automabaca_test");
    expect(familyBaseOf("automabaca_e2e")).toBe("automabaca_test");
    expect(familyBaseOf("automabaca_migrate")).toBe("automabaca_test");
    // Nome que nenhuma família gera fica sem dono: a poda não o toca.
    expect(familyBaseOf("automabaca_test_e2e_clv")).toBeNull();
    expect(familyBaseOf("automabaca_test_x_1_2")).toBeNull();
    expect(familyBaseOf("automabaca")).toBeNull();
  });
});

describe("guarda de banco descartável", () => {
  it("recusa qualquer banco fora da família de teste", () => {
    expect(quoteDisposableDatabaseName("automabaca_test_2")).toBe('"automabaca_test_2"');
    expect(quoteDisposableDatabaseName("automabaca_test_upgrade")).toBe('"automabaca_test_upgrade"');
    expect(quoteDisposableDatabaseName("automabaca_test_wtclv_template")).toBe('"automabaca_test_wtclv_template"');
    expect(assertDisposableDatabaseName("automabaca_test_rotinas_deploy_e2e")).toBe("automabaca_test_rotinas_deploy_e2e");
    expect(assertDisposableDatabaseName("automabaca_migrate")).toBe("automabaca_migrate");
    for (const nome of [
      "automabaca",
      "automabaca_novo",
      "postgres",
      "automabaca_scale",
      "automabaca_testx",
      "automabaca_test_Clv",
      `automabaca_test_${"a".repeat(48)}`,
    ]) {
      expect(() => assertDisposableDatabaseName(nome), nome).toThrow("não descartável");
    }
    expect(() => assertDisposableDatabaseName("automabaca_test;DROP DATABASE automabaca")).toThrow();
    expect(() => assertDisposableDatabaseName('automabaca_test_x" WITH (FORCE); DROP DATABASE "automabaca')).toThrow();
  });
});

describe("worktree nova", () => {
  it("a tarefa vira o sufixo do banco, com o hífen trocado por _", () => {
    expect(worktreeTestDatabaseBase("clv")).toBe("automabaca_test_clv");
    expect(worktreeTestDatabaseBase("rotinas-deploy")).toBe("automabaca_test_rotinas_deploy");
    expect(worktreeTestDatabaseBase("rev169")).toBe("automabaca_test_rev169");
    expect(() => worktreeTestDatabaseBase("fix-2")).toThrow(/número/);
  });

  it.each(["Clv", "rotinas_deploy", "rotinas.deploy", "x/../wt-outra", "-clv", "clv-", "rotinas--deploy", ""])(
    "recusa a tarefa %j, que não é só a-z, 0-9 e hífen entre trechos",
    (tarefa) => {
      // `Clv` e `rotinas_deploy` cairiam na mesma base de `clv` e `rotinas-deploy`.
      expect(() => worktreeTestDatabaseBase(tarefa)).toThrow(/Tarefa inválida/);
    },
  );

  it("aponta a pasta wt-* que já cai na mesma base, inclusive as criadas à mão", () => {
    expect(worktreeSharingBase("rotinas-deploy", ["clv", "rotinas_deploy"])).toBe("rotinas_deploy");
    expect(worktreeSharingBase("clv", ["Clv"])).toBe("Clv");
    expect(worktreeSharingBase("clv", ["clv2", "clv-2", "rotinas"])).toBeNull();
  });

  it("o .env é o da árvore principal com o banco da worktree no servidor compartilhado", () => {
    const linhas = (testDatabaseUrl: string) => [
      "# local",
      'DATABASE_URL="postgresql://automabaca:automabaca@127.0.0.1:5432/automabaca"',
      testDatabaseUrl,
      "GEMINI_API_KEYS=a,b",
      "",
    ].join("\n");
    expect(worktreeEnvText(linhas('TEST_DATABASE_URL="postgresql://automabaca:s$&nha@127.0.0.1:5500/automabaca_test"'), "clv"))
      .toBe(linhas('TEST_DATABASE_URL="postgresql://automabaca:s$&nha@127.0.0.1:5433/automabaca_test_clv"'));
    // Sem TEST_DATABASE_URL na principal, o servidor do compose.
    expect(worktreeEnvText("LOG_LEVEL=debug", "clv"))
      .toBe('LOG_LEVEL=debug\nTEST_DATABASE_URL="postgresql://automabaca:automabaca@127.0.0.1:5433/automabaca_test_clv"\n');
    // Porta ilegível não pode virar, calada, a porta do servidor da principal.
    expect(() => worktreeEnvText("", "clv", "54a33")).toThrow(/Porta inválida/);
  });
});
