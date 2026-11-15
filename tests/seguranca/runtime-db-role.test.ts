import { describe, expect, it } from "vitest";

describe("runtime-db-role SEC-02 (fail-fast de boot)", () => {
  it("marca superuser/createdb/createrole/replication/bypassrls como privilegiado", async () => {
    const { connectedRoleIsPrivileged, assertRuntimeConnectionIsUnprivileged } = await import(
      "@/src/infra/runtime-db-role"
    );
    expect(connectedRoleIsPrivileged({
      connectedSuperuser: false,
      connectedCreatedb: false,
      connectedCreaterole: false,
      connectedReplication: false,
      connectedBypassrls: false,
    })).toBe(false);
    expect(connectedRoleIsPrivileged({
      connectedSuperuser: true,
      connectedCreatedb: false,
      connectedCreaterole: false,
      connectedReplication: false,
      connectedBypassrls: false,
    })).toBe(true);

    let calls = 0;
    const client = {
      query: async (sql: string) => {
        calls += 1;
        if (sql.includes("current_user")) {
          return {
            rows: [{
              database: "db", role: "automabaca_novo",
              rolsuper: true, rolcreatedb: true, rolcreaterole: false,
              rolreplication: false, rolbypassrls: false,
            }],
          };
        }
        return { rows: [] };
      },
    };
    // Produção real (sem isenção): falha com role privilegiada.
    await expect(assertRuntimeConnectionIsUnprivileged(client, {
      nodeEnv: "production",
      env: { NODE_ENV: "production" },
    })).rejects.toThrow(/role privilegiada/);
    await expect(assertRuntimeConnectionIsUnprivileged(client, {
      nodeEnv: "development",
      env: { NODE_ENV: "development" },
    })).resolves.toBeUndefined();
    expect(calls).toBeGreaterThan(0);
  });

  it("isenta CI / vitest / browser e2e e mantém fail-fast em produção real", async () => {
    const {
      databaseUrlLooksLikeE2eSuite,
      isRuntimeRoleAssertionExempt,
      assertRuntimeConnectionIsUnprivileged,
    } = await import("@/src/infra/runtime-db-role");

    expect(databaseUrlLooksLikeE2eSuite("postgresql://postgres:postgres@127.0.0.1:5432/automabaca_e2e")).toBe(true);
    expect(databaseUrlLooksLikeE2eSuite("postgresql://postgres:postgres@127.0.0.1:5432/automabaca_novo")).toBe(false);

    expect(isRuntimeRoleAssertionExempt({ CI: "true" })).toBe(true);
    expect(isRuntimeRoleAssertionExempt({ VITEST: "true" })).toBe(true);
    expect(isRuntimeRoleAssertionExempt({ AUTOMABACA_PROCESS: "test" })).toBe(true);
    expect(isRuntimeRoleAssertionExempt({
      VISUAL_TEST_MODE: "1",
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/automabaca_e2e",
    })).toBe(true);
    // VISUAL_TEST_MODE sozinho em banco de produção NÃO isenta.
    expect(isRuntimeRoleAssertionExempt({
      VISUAL_TEST_MODE: "1",
      DATABASE_URL: "postgresql://automabaca_runtime:x@db:5432/automabaca_novo",
    })).toBe(false);
    expect(isRuntimeRoleAssertionExempt({ NODE_ENV: "production" })).toBe(false);

    let inspected = 0;
    const client = {
      query: async (sql: string) => {
        inspected += 1;
        if (sql.includes("current_user")) {
          return {
            rows: [{
              database: "automabaca_e2e", role: "postgres",
              rolsuper: true, rolcreatedb: true, rolcreaterole: true,
              rolreplication: false, rolbypassrls: false,
            }],
          };
        }
        return { rows: [] };
      },
    };

    // Browser/CI: NODE_ENV=production + postgres superuser no *_e2e* — não aborta.
    await expect(assertRuntimeConnectionIsUnprivileged(client, {
      nodeEnv: "production",
      env: {
        NODE_ENV: "production",
        CI: "true",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/automabaca_e2e",
      },
    })).resolves.toBeUndefined();
    await expect(assertRuntimeConnectionIsUnprivileged(client, {
      nodeEnv: "production",
      env: {
        NODE_ENV: "production",
        VISUAL_TEST_MODE: "1",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/automabaca_e2e",
      },
    })).resolves.toBeUndefined();
    // Isentos não inspecionam o banco.
    expect(inspected).toBe(0);

    // Produção real com role privilegiada: ainda falha.
    await expect(assertRuntimeConnectionIsUnprivileged(client, {
      nodeEnv: "production",
      env: {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://postgres:secret@db:5432/automabaca_novo",
      },
    })).rejects.toThrow(/role privilegiada/);
    expect(inspected).toBeGreaterThan(0);
  });
});
