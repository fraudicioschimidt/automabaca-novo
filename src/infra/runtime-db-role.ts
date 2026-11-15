/**
 * Role de runtime sem superuser: web e worker falam como automabaca_runtime.
 * Migrations, CREATE ROLE e backup usam a role administrativa do cluster.
 */

const AUTOMABACA_RUNTIME_ROLE = "automabaca_runtime";

export type SqlClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type ConnectedRoleInspection = {
  connectedRole: string;
  connectedSuperuser: boolean;
  connectedCreatedb: boolean;
  connectedCreaterole: boolean;
  connectedReplication: boolean;
  connectedBypassrls: boolean;
};

async function inspectConnectedRole(client: SqlClient): Promise<ConnectedRoleInspection> {
  const connected = await client.query(`
    SELECT current_user AS role,
           r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname = current_user
  `);
  const row = connected.rows[0] ?? {};
  return {
    connectedRole: String(row["role"] ?? ""),
    connectedSuperuser: row["rolsuper"] === true,
    connectedCreatedb: row["rolcreatedb"] === true,
    connectedCreaterole: row["rolcreaterole"] === true,
    connectedReplication: row["rolreplication"] === true,
    connectedBypassrls: row["rolbypassrls"] === true,
  };
}

/** Atributos que tornam a role conectada inadequada para o pool de runtime. */
export function connectedRoleIsPrivileged(
  inspection: Pick<
    ConnectedRoleInspection,
    | "connectedSuperuser"
    | "connectedCreatedb"
    | "connectedCreaterole"
    | "connectedReplication"
    | "connectedBypassrls"
  >,
): boolean {
  return (
    inspection.connectedSuperuser ||
    inspection.connectedCreatedb ||
    inspection.connectedCreaterole ||
    inspection.connectedReplication ||
    inspection.connectedBypassrls
  );
}

/** Banco descartável da suíte de navegador (`*_e2e*`), mesmo contrato do mock/docker gate. */
export function databaseUrlLooksLikeE2eSuite(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false;
  try {
    const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
    return /(?:^|_)e2e(?:_|$)/i.test(database);
  } catch {
    return false;
  }
}

/**
 * Contextos em que NODE_ENV=production é só para reproduzir a borda do Next
 * (browser suite, CI, vitest), sem exigir a role de runtime do cluster real.
 * Produção (sem CI/VISUAL_TEST_MODE+e2e) continua fail-fast.
 */
export type RuntimeRoleEnv = NodeJS.Dict<string>;

export function isRuntimeRoleAssertionExempt(
  env: RuntimeRoleEnv = process.env,
): boolean {
  if (env.CI === "true" || env.CI === "1") return true;
  if (env.VITEST === "true" || env.VITEST === "1") return true;
  if (env.AUTOMABACA_PROCESS === "test") return true;
  if (env.PW_TEST_CONNECT_WS_ENDPOINT) return true;
  // Mesmo gate do mock visual: VISUAL_TEST_MODE + banco *_e2e*.
  if (env.VISUAL_TEST_MODE === "1" && databaseUrlLooksLikeE2eSuite(env.DATABASE_URL)) {
    return true;
  }
  return false;
}

/**
 * Fail-fast de boot (SEC-02): em produção o pool não pode estar como
 * superusuário/admin. Migrations usam outra URL; web (`instrumentation.ts`) e
 * worker (`main` de `src/jobs/worker.ts`) conferem no boot que falam só como
 * automabaca_runtime.
 *
 * Exceção: suítes/CI que sobem o Next com NODE_ENV=production mas
 * DATABASE_URL de cluster descartável (postgres superuser em *_e2e*).
 */
export async function assertRuntimeConnectionIsUnprivileged(
  client: SqlClient,
  options: { nodeEnv?: string; env?: RuntimeRoleEnv } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV;
  if (nodeEnv !== "production") return;
  if (isRuntimeRoleAssertionExempt(env)) return;
  const inspection = await inspectConnectedRole(client);
  if (!connectedRoleIsPrivileged(inspection)) return;
  throw new Error(
    `DATABASE_URL em produção conectou como role privilegiada ` +
      `"${inspection.connectedRole}" (super=${inspection.connectedSuperuser}, ` +
      `createdb=${inspection.connectedCreatedb}, createrole=${inspection.connectedCreaterole}, ` +
      `replication=${inspection.connectedReplication}, bypassrls=${inspection.connectedBypassrls}). ` +
      `Use a role de runtime (${AUTOMABACA_RUNTIME_ROLE}).`,
  );
}

