import { describe, expect, it } from "vitest";
import { resolveDisposableMigrationUrl } from "@/scripts/lib/test-migration-url";

describe("migration de teste isolada de credenciais administrativas", () => {
  it("usa somente o destino explícito, mesmo com dois URLs de produção herdados", () => {
    const test = "postgresql://test:synthetic@localhost:55443/automabaca_test_template";
    expect(resolveDisposableMigrationUrl({ PRISMA_TEST_DATABASE_URL: test,
      DATABASE_URL: "postgresql://runtime@production.invalid/live",
      DATABASE_URL_ADMIN: "postgresql://admin@production.invalid/live" })).toBe(test);
  });
  it("aceita os bancos de teste de uma worktree no servidor compartilhado", () => {
    for (const banco of ["automabaca_test_wtclv_template", "automabaca_test_wtclv_e2e", "automabaca_e2e"]) {
      const url = `postgresql://test:synthetic@localhost:5433/${banco}`;
      expect(resolveDisposableMigrationUrl({ PRISMA_TEST_DATABASE_URL: url })).toBe(url);
    }
    expect(() => resolveDisposableMigrationUrl({ PRISMA_TEST_DATABASE_URL: "postgresql://t:s@localhost:5433/automabaca_testx" }))
      .toThrow("não descartável");
  });
  it("recusa omissão e banco de negócio sem expor credencial", () => {
    expect(() => resolveDisposableMigrationUrl({ DATABASE_URL_ADMIN: "postgresql://admin/live" })).toThrow("obrigatória");
    expect(() => resolveDisposableMigrationUrl({ PRISMA_TEST_DATABASE_URL: "postgresql://admin:secret@host/live" }))
      .toThrow("não descartável");
  });
});
