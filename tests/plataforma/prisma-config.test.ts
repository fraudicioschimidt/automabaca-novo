import { describe, expect, it } from "vitest";
import { resolvePrismaDatabaseUrl } from "@/prisma.config";
import {
  e2eDatabaseName,
  isDisposableDatabaseName,
  migrateDatabaseName,
  suiteDatabaseNames,
} from "@/scripts/lib/test-databases.mjs";

describe("configuração do Prisma", () => {
  it("permite generate sem expor uma credencial de banco", () => {
    expect(resolvePrismaDatabaseUrl({}, ["node", "prisma", "generate"]))
      .toBe("postgresql://prisma-generate.invalid/automabaca");
  });

  it("continua fail-fast para comandos que podem acessar o banco", () => {
    expect(() => resolvePrismaDatabaseUrl({}, ["node", "prisma", "migrate", "deploy"]))
      .toThrow("DATABASE_URL não configurada");
  });

  it("sempre prefere o URL explicitamente configurado", () => {
    expect(resolvePrismaDatabaseUrl(
      { DATABASE_URL: "postgresql://configured/db" },
      ["node", "prisma", "generate"],
    )).toBe("postgresql://configured/db");
  });

  it("migrations usam a role administrativa quando ela existe", () => {
    expect(resolvePrismaDatabaseUrl(
      {
        DATABASE_URL: "postgresql://runtime/db",
        DATABASE_URL_ADMIN: "postgresql://admin/db",
      },
      ["node", "prisma", "migrate", "deploy"],
    )).toBe("postgresql://admin/db");
    expect(resolvePrismaDatabaseUrl(
      {
        DATABASE_URL: "postgresql://runtime/db",
        DATABASE_URL_ADMIN: "postgresql://admin/db",
      },
      ["node", "prisma", "generate"],
    )).toBe("postgresql://runtime/db");
  });
});

describe("Papel administrativo do Prisma contra banco descartável", () => {
  const ADMIN = "postgresql://admin:sintetica@production.invalid/production";
  const TESTE = "postgresql://test:sintetica@localhost:55443/automabaca_test_template";
  const PROD = "postgresql://app:sintetica@db.invalid/automabaca_novo";

  it("ADMIN herdada não sequestra um migrate declarado contra banco de teste", () => {
    expect(resolvePrismaDatabaseUrl(
      { DATABASE_URL_ADMIN: ADMIN, DATABASE_URL: TESTE },
      ["node", "prisma", "migrate", "deploy"],
    )).toBe(TESTE);
  });

  it.each([
    "automabaca_test", "automabaca_test_7", "automabaca_e2e", "automabaca_migrate",
    "automabaca_test_wtclv_3", "automabaca_test_wtclv_e2e", "automabaca_test_wtclv_migrate",
  ])(
    "protege também %s", (nome) => {
      expect(resolvePrismaDatabaseUrl(
        { DATABASE_URL_ADMIN: ADMIN, DATABASE_URL: `postgresql://t:s@localhost:5432/${nome}` },
        ["node", "prisma", "migrate", "deploy"],
      )).toContain(nome);
    });

  it("a regra copiada aqui concorda com a guarda de banco descartável", () => {
    // O migrador de produção leva só este arquivo, então a regra não é importada:
    // este teste é o que impede as duas cópias de divergirem.
    const nomes = [
      ...["automabaca_test", "automabaca_test_wtclv", "automabaca_test_rotinas_deploy"].flatMap((base) => [
        ...suiteDatabaseNames(base, 6), e2eDatabaseName(base), migrateDatabaseName(base),
      ]),
      "automabaca", "automabaca_novo", "postgres", "automabaca_scale", "automabaca_testx", "automabaca_test_",
      "automabaca_test__x", "automabaca_test_Clv", "automabaca_e2e_x", "automabaca_migrate_x",
      `automabaca_test_${"a".repeat(47)}`, `automabaca_test_${"a".repeat(48)}`,
    ];
    for (const nome of nomes) {
      const destino = `postgresql://t:s@localhost:5433/${nome}`;
      const usado = resolvePrismaDatabaseUrl(
        { DATABASE_URL_ADMIN: ADMIN, DATABASE_URL: destino },
        ["node", "prisma", "migrate", "deploy"],
      );
      expect(usado === destino, nome).toBe(isDisposableDatabaseName(nome));
    }
  });

  it("a migration de produção continua usando o papel administrativo", () => {
    expect(resolvePrismaDatabaseUrl(
      { DATABASE_URL_ADMIN: ADMIN, DATABASE_URL: PROD },
      ["node", "prisma", "migrate", "deploy"],
    )).toBe(ADMIN);
  });

  it("fora de migrate/db a ADMIN não entra, nem com destino de produção", () => {
    expect(resolvePrismaDatabaseUrl(
      { DATABASE_URL_ADMIN: ADMIN, DATABASE_URL: PROD },
      ["node", "prisma", "generate"],
    )).toBe(PROD);
  });

  it("URL ilegível não vira passe livre para a ADMIN sumir", () => {
    expect(resolvePrismaDatabaseUrl(
      { DATABASE_URL_ADMIN: ADMIN, DATABASE_URL: "isto-nao-e-url" },
      ["node", "prisma", "migrate", "deploy"],
    )).toBe(ADMIN);
  });
});
