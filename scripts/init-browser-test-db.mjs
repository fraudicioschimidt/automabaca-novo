import { PgBoss } from "pg-boss";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL ausente para preparar o banco E2E.");

const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
if (!/(?:^|_)e2e(?:_|$)/i.test(databaseName)) {
  throw new Error(`Banco recusado: ${databaseName || "(sem nome)"}. O preparo aceita somente *_e2e*.`);
}

const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
await boss.start();
await boss.stop({ graceful: false });

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const { rows } = await client.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema IN ('public', 'pgboss')
      AND table_name <> '_prisma_migrations'
    ORDER BY table_schema, table_name
  `);
  if (rows.length === 0) {
    throw new Error(`Nenhuma tabela resetável encontrada no banco E2E ${databaseName}.`);
  }
  const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const targets = rows.map(
    ({ table_schema: schema, table_name: table }) =>
      `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
  );
  await client.query("BEGIN");
  try {
    await client.query(`TRUNCATE TABLE ${targets.join(", ")} RESTART IDENTITY CASCADE`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  process.stdout.write(
    `pg-boss preparado e ${targets.length} tabelas limpas no banco isolado ${databaseName}.\n`,
  );
} finally {
  await client.end();
}
