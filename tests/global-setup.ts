import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { PgBoss } from "pg-boss";
import { resolveTestDatabaseUrl } from "./helpers/db-url";
import { DB_TEST_MAX_WORKERS } from "./helpers/db-workers";
import {
  dropDisposableDatabase,
  quoteDisposableDatabaseName,
  suiteDatabaseNames,
  suiteLockKey,
  templateDatabaseName,
  testDatabaseBaseFromUrl,
  workerDatabaseName,
} from "../scripts/lib/test-databases.mjs";

/**
 * Global setup do projeto `db`: sobe um template migrado e clona N bancos
 * (`<base>_1` … `_N`) — um por worker Vitest. Assim o projeto db roda com
 * fileParallelism contra Postgres real, sem TRUNCATE cruzado. A base é o banco
 * do `TEST_DATABASE_URL`; suítes de bases diferentes dividem o servidor sem
 * esperar uma pela outra (`scripts/lib/test-databases.mjs`).
 */

async function recreateFromTemplate(
  admin: Client,
  dbName: string,
  templateName: string,
): Promise<void> {
  const quotedDbName = quoteDisposableDatabaseName(dbName);
  const quotedTemplateName = quoteDisposableDatabaseName(templateName);
  await dropDisposableDatabase(admin, dbName);
  await admin.query(`CREATE DATABASE ${quotedDbName} TEMPLATE ${quotedTemplateName}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const testUrl = resolveTestDatabaseUrl();
  const base = testDatabaseBaseFromUrl(testUrl);
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();

  // Os clones têm nomes fixos dentro da família. A trava vale a suíte inteira
  // para uma segunda execução da mesma base não derrubar bancos ainda em uso.
  const lockKey = suiteLockKey(base);
  await admin.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);

  const templateDbName = templateDatabaseName(base);
  const workerCount = DB_TEST_MAX_WORKERS;
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));

  try {
    await dropDisposableDatabase(admin, templateDbName);
    await admin.query(`CREATE DATABASE ${quoteDisposableDatabaseName(templateDbName)}`);

    const templateUrl = new URL(testUrl);
    templateUrl.pathname = `/${templateDbName}`;
    templateUrl.search = "";

    execFileSync(process.execPath, [path.join(repoRoot, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--config", "prisma.test.config.ts"], {
      cwd: repoRoot,
      env: { ...process.env, PRISMA_TEST_DATABASE_URL: templateUrl.toString() },
      stdio: "pipe",
    });

    // Schema pgboss no template — testes de dead-letter / filas herdam nas clones.
    const boss = new PgBoss({
      connectionString: templateUrl.toString(),
      schema: "pgboss",
    });
    await boss.start();
    await boss.stop({ graceful: false });

    for (let i = 1; i <= workerCount; i++) {
      await recreateFromTemplate(admin, workerDatabaseName(base, String(i)), templateDbName);
    }

    // Compat: nome base sem pool id (debug serial / ferramentas).
    await recreateFromTemplate(admin, base, templateDbName);
  } catch (error) {
    await admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
    await admin.end();
    throw error;
  }

  return async () => {
    try {
      for (const name of suiteDatabaseNames(base, workerCount)) {
        try {
          await dropDisposableDatabase(admin, name);
        } catch (err) {
          console.error(`Falha ao limpar banco de teste ${name}:`, err);
        }
      }
    } finally {
      await admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      await admin.end();
    }
  };
}
