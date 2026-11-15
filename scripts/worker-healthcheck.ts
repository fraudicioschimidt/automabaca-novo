import { Pool } from "pg";
import { currentWorkerHealthy } from "@/src/infra/worker-instance";

// Menor que os 5s do Docker, incluindo conexão, consulta e fechamento do pool.
const deadline = setTimeout(() => process.exit(1), 4500);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 3000, statement_timeout: 3000, query_timeout: 3000 });
try {
  process.exitCode = await currentWorkerHealthy((sql, values) => pool.query(sql, values)) ? 0 : 1;
} catch { process.exitCode = 1; }
finally {
  await pool.end();
  clearTimeout(deadline);
}
