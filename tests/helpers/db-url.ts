import { config as loadDotenv } from "dotenv";
import {
  DEFAULT_TEST_DATABASE,
  testDatabaseBaseFromUrl,
  workerDatabaseName,
} from "../../scripts/lib/test-databases.mjs";

/**
 * Derivação da URL do banco de TESTE — SEM importar o prisma global. Fica isolada
 * aqui porque o `global-setup` (processo runner do vitest, antes dos forks) precisa
 * dela mas NÃO pode iniciar o pool do prisma (DATABASE_URL de teste só existe nos
 * forks). Os testes usam `createTestDb` (helpers/db) que reaproveita o prisma global.
 */

/**
 * Nome do banco deste worker dentro da família `base`. Só o projeto `db` liga
 * `VITEST_DB_PARALLEL=1` (unitários também recebem `VITEST_POOL_ID`, mas não
 * devem exigir clones).
 */
export function resolveTestDatabaseName(
  base: string,
  processEnv: NodeJS.Dict<string | undefined> = process.env,
): string {
  const poolId = processEnv.VITEST_POOL_ID;
  if (processEnv.VITEST_DB_PARALLEL === "1" && poolId) return workerDatabaseName(base, poolId);
  return base;
}

/**
 * Escolhe o cluster de TESTE. O processo vence o arquivo `.env` — senão
 * `TEST_DATABASE_URL=… npx vitest` seria ignorado. Sem TEST_DATABASE_URL
 * explícito não há fallback para DATABASE_URL: esse caminho apontaria a suíte
 * para o host de produção, só trocando o nome do banco.
 */
export function selectTestClusterUrl(
  processEnv: NodeJS.Dict<string | undefined>,
  fileEnv: NodeJS.Dict<string | undefined>,
): string | undefined {
  const fromProcess = processEnv.TEST_DATABASE_URL?.trim();
  if (fromProcess) return fromProcess;
  const fromFile = fileEnv.TEST_DATABASE_URL?.trim();
  if (fromFile) return fromFile;
  return undefined;
}

/**
 * URL do banco deste processo. O nome do banco no `TEST_DATABASE_URL` é a base
 * da família (`scripts/lib/test-databases.mjs`): cada worktree tem a sua no
 * mesmo servidor.
 */
export function resolveTestDatabaseUrlFrom(
  processEnv: NodeJS.Dict<string | undefined>,
  fileEnv: NodeJS.Dict<string | undefined>,
): string {
  const clusterUrl = selectTestClusterUrl(processEnv, fileEnv);
  const parallel = processEnv.VITEST_DB_PARALLEL === "1";
  if (!clusterUrl || clusterUrl.includes("@localhost:5432/automabaca_test")) {
    // Projeto `unit` (sem VITEST_DB_PARALLEL): no CI não há .env nem Postgres —
    // placeholder basta; unitários não abrem conexão. Projeto `db` exige cluster
    // descartável explícito.
    if (!parallel) {
      return `postgresql://test:test@localhost:5432/${resolveTestDatabaseName(DEFAULT_TEST_DATABASE, processEnv)}`;
    }
    throw new Error(
      "Testes de banco exigem TEST_DATABASE_URL num cluster descartável; recusado fallback para DATABASE_URL.",
    );
  }
  const url = new URL(clusterUrl);
  url.pathname = `/${resolveTestDatabaseName(testDatabaseBaseFromUrl(clusterUrl), processEnv)}`;
  url.search = "";
  return url.toString();
}

export function resolveTestDatabaseUrl(): string {
  // `processEnv: {}` impede o dotenv de poluir o process.env do runner.
  const parsed = loadDotenv({ path: ".env", processEnv: {}, quiet: true });
  return resolveTestDatabaseUrlFrom(process.env, parsed.parsed ?? {});
}
