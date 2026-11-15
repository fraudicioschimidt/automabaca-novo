import { parse } from "dotenv";

/**
 * Bancos de teste de cada checkout, num servidor que várias worktrees dividem.
 *
 * O nome do banco no `TEST_DATABASE_URL` é o NOME-BASE de uma família:
 *
 *   automabaca_test_clv            base
 *   automabaca_test_clv_template   migrado uma vez por suíte (tests/global-setup.ts)
 *   automabaca_test_clv_1 … _N     um por worker do Vitest
 *   automabaca_test_clv_upgrade    reservado a teste de migration; a suíte o apaga no fim
 *   automabaca_test_clv_e2e        suíte de navegador (scripts/run-browser-suite.sh)
 *   automabaca_test_clv_migrate    autoria de migration (scripts/prisma-migrate-dev.mjs)
 *
 * Famílias diferentes não dividem nome nem trava: suítes de worktrees
 * diferentes rodam juntas no `db-test` do compose sem esperar uma pela outra.
 * A base padrão (CI e o `.env` do dev:setup) mantém os nomes de sempre,
 * inclusive `automabaca_e2e` e `automabaca_migrate`.
 *
 * Todo `automabaca_test*` do servidor é descartável: a suíte recria a família
 * dela a cada execução, e `scripts/worktree.sh` apaga a de worktree removida.
 */
export const DEFAULT_TEST_DATABASE = "automabaca_test";

/** Porta do `db-test` do docker-compose.dev.yml, o servidor que as worktrees dividem. */
const SHARED_TEST_SERVER_PORT = "5433";

// `automabaca_test_x_1` já é o banco do worker 1 da base `automabaca_test_x`:
// uma base que terminasse em papel ou número dividiria nomes com outra família.
const ROLES = new Set(["template", "upgrade", "e2e", "migrate"]);
const TEST_DATABASE = /^automabaca_test(?:_[a-z0-9]+)*$/;
// O PostgreSQL corta identificador em 63 bytes; base + "_template" tem de caber.
const MAX_BASE_LENGTH = 63 - "_template".length;

/** @param {string} name */
function baseProblem(name) {
  if (name === DEFAULT_TEST_DATABASE) return null;
  if (!TEST_DATABASE.test(name)) return "use automabaca_test ou automabaca_test_<nome>, só com a-z, 0-9 e _";
  if (name.length > MAX_BASE_LENGTH) return `passa de ${MAX_BASE_LENGTH} caracteres`;
  const segments = name.slice(DEFAULT_TEST_DATABASE.length + 1).split("_");
  const last = segments.at(-1) ?? "";
  if (ROLES.has(last) || /^\d+$/.test(last)) {
    return "não pode terminar em número nem em template, upgrade, e2e ou migrate (seria banco de outra família)";
  }
  // `e2e` entre `_` é a marca do banco de navegador (app/(painel)/_mock.ts).
  if (segments.includes("e2e")) return "não pode ter o trecho e2e, que marca o banco da suíte de navegador";
  return null;
}

/** @param {string} name */
function assertTestDatabaseBase(name) {
  const problem = baseProblem(name);
  if (problem) throw new Error(`Nome-base de banco de teste recusado (${name}): ${problem}.`);
  return name;
}

/**
 * Nome-base a partir do `TEST_DATABASE_URL`; sem banco no URL, a base padrão.
 * @param {string} testDatabaseUrl
 */
export function testDatabaseBaseFromUrl(testDatabaseUrl) {
  const name = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//, ""));
  return name === "" ? DEFAULT_TEST_DATABASE : assertTestDatabaseBase(name);
}

/**
 * @param {string} base
 * @param {string} poolId
 */
export function workerDatabaseName(base, poolId) {
  if (!/^[1-9]\d*$/.test(poolId)) throw new Error(`VITEST_POOL_ID inválido: ${poolId}`);
  return `${base}_${poolId}`;
}

/** @param {string} base */
export function templateDatabaseName(base) {
  return `${base}_template`;
}

/**
 * Os bancos que a suíte do Vitest cria e apaga.
 * @param {string} base
 * @param {number} workers
 */
export function suiteDatabaseNames(base, workers) {
  return [
    base,
    templateDatabaseName(base),
    `${base}_upgrade`,
    ...Array.from({ length: workers }, (_, index) => workerDatabaseName(base, String(index + 1))),
  ];
}

/** @param {string} base */
export function e2eDatabaseName(base) {
  return base === DEFAULT_TEST_DATABASE ? "automabaca_e2e" : `${base}_e2e`;
}

/** @param {string} base */
export function migrateDatabaseName(base) {
  return base === DEFAULT_TEST_DATABASE ? "automabaca_migrate" : `${base}_migrate`;
}

/**
 * Banco da suíte de navegador para um `TEST_DATABASE_URL`. A CI sobe o
 * PostgreSQL do job de navegador já com o banco e2e no URL.
 * @param {string} testDatabaseUrl
 */
export function e2eDatabaseUrl(testDatabaseUrl) {
  const url = new URL(testDatabaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  url.pathname = `/${name === "automabaca_e2e" ? name : e2eDatabaseName(testDatabaseBaseFromUrl(testDatabaseUrl))}`;
  url.search = "";
  return url.toString();
}

/**
 * Trava que a suíte segura do começo ao fim: duas suítes da MESMA família
 * apagariam os bancos uma da outra. A base padrão fica com a chave de antes,
 * que os checkouts antigos (só conhecem os nomes fixos) também usam. Trava
 * consultiva vale por banco: quem a toma conecta no `postgres`.
 * @param {string} base
 */
export function suiteLockKey(base) {
  return base === DEFAULT_TEST_DATABASE ? "automabaca:test:db-suite" : `automabaca:test:db-suite:${base}`;
}

/**
 * @param {string} name
 * @param {string} base
 */
export function belongsToFamily(name, base) {
  const named = [base, templateDatabaseName(base), `${base}_upgrade`, e2eDatabaseName(base), migrateDatabaseName(base)];
  if (named.includes(name)) return true;
  return name.startsWith(`${base}_`) && /^[1-9]\d*$/.test(name.slice(base.length + 1));
}

// `DROP DATABASE` não aceita parâmetro: um nome só entra no SQL depois desta conferência.
const DISPOSABLE_DATABASE = /^(?:automabaca_test(?:_[a-z0-9]+)*|automabaca_e2e|automabaca_migrate)$/;

/** @param {unknown} name */
export function isDisposableDatabaseName(name) {
  return typeof name === "string" && name.length <= 63 && DISPOSABLE_DATABASE.test(name);
}

/** @param {string} name */
export function assertDisposableDatabaseName(name) {
  if (!isDisposableDatabaseName(name)) throw new Error(`Banco não descartável recusado: ${name}`);
  return name;
}

/** @param {string} name */
export function quoteDisposableDatabaseName(name) {
  return `"${assertDisposableDatabaseName(name)}"`;
}

/**
 * Apaga um banco descartável; `FORCE` derruba as conexões que sobraram nele.
 * @param {import("pg").ClientBase} admin
 * @param {string} name
 */
export async function dropDisposableDatabase(admin, name) {
  await admin.query(`DROP DATABASE IF EXISTS ${quoteDisposableDatabaseName(name)} WITH (FORCE)`);
}

/**
 * Base da família de um banco de teste, ou `null` para nome que nenhuma
 * família gera.
 * @param {string} name
 */
export function familyBaseOf(name) {
  if (name === "automabaca_e2e" || name === "automabaca_migrate") return DEFAULT_TEST_DATABASE;
  if (baseProblem(name) === null) return name;
  const base = name.slice(0, name.lastIndexOf("_"));
  return baseProblem(base) === null && belongsToFamily(name, base) ? base : null;
}

/** Família com suíte rodando ou conexão aberta: apagar derrubaria o trabalho de alguém. */
class FamilyInUseError extends Error {}

/**
 * Apaga a família de `base` inteira e devolve os nomes apagados. Recusa com a
 * suíte dela rodando ou com conexão aberta em qualquer banco dela, e recusa a
 * base padrão, que é de todo checkout que usa `automabaca_test`. `admin`
 * conecta no banco `postgres`, como a suíte.
 * @param {import("pg").ClientBase} admin
 * @param {string} base
 */
export async function dropTestDatabaseFamily(admin, base) {
  if (assertTestDatabaseBase(base) === DEFAULT_TEST_DATABASE) {
    throw new Error(`A família ${DEFAULT_TEST_DATABASE} é de todo checkout que a usa; não se apaga por worktree.`);
  }
  const key = suiteLockKey(base);
  const lock = await admin.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS free", [key]);
  if (!lock.rows[0]?.free) throw new FamilyInUseError(`Uma suíte de ${base} está rodando; espere ela terminar.`);
  try {
    const { rows } = await admin.query(
      "SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname",
      [base],
    );
    /** @type {string[]} */
    const family = rows.map((row) => row.datname).filter((name) => belongsToFamily(name, base));
    // Os bancos de navegador e de autoria não têm trava: conexão aberta é o sinal de uso.
    const { rows: open } = await admin.query(
      `SELECT datname, count(*)::int AS connections FROM pg_stat_activity
       WHERE datname = ANY($1::text[]) GROUP BY datname ORDER BY datname`,
      [family],
    );
    if (open.length) {
      const busy = open.map((row) => `${row.datname} (${row.connections} conexões)`).join(", ");
      throw new FamilyInUseError(`${busy} em uso; espere as conexões fecharem.`);
    }
    for (const name of family) {
      // Sem FORCE: conexão aberta depois da conferência faz o DROP recusar (55006), e não cair.
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteDisposableDatabaseName(name)}`);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "55006") {
          throw new FamilyInUseError(`${name} em uso; espere as conexões fecharem.`);
        }
        throw error;
      }
    }
    return family;
  } finally {
    await admin.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
  }
}

/**
 * Base que uma pasta `wt-<nome>` qualquer ocupa, inclusive a criada à mão com
 * nome fora do padrão: o que não é letra ou dígito vira `_`.
 * @param {string} name
 */
function directoryBase(name) {
  const suffix = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return suffix ? `${DEFAULT_TEST_DATABASE}_${suffix}` : null;
}

/**
 * Apaga as famílias de worktree sem pasta `wt-*` que caia nelas, só as
 * ociosas; as em uso voltam em `busy`. A família padrão nunca sai.
 * @param {import("pg").ClientBase} admin
 * @param {string[]} existingTasks nomes das pastas `wt-*`, sem o `wt-`
 */
export async function pruneOrphanFamilies(admin, existingTasks, prefix = `${DEFAULT_TEST_DATABASE}_`) {
  const live = new Set(existingTasks.map(directoryBase));
  const { rows } = await admin.query("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [prefix]);
  const orphans = [...new Set(rows.map((row) => familyBaseOf(row.datname)))]
    .filter((base) => base !== null && base !== DEFAULT_TEST_DATABASE && !live.has(base))
    .sort();
  /** @type {string[]} */
  const dropped = [];
  /** @type {string[]} */
  const busy = [];
  for (const base of orphans) {
    try {
      dropped.push(...await dropTestDatabaseFamily(admin, base));
    } catch (error) {
      if (!(error instanceof FamilyInUseError)) throw error;
      busy.push(base);
    }
  }
  return { dropped, busy };
}

// Tarefa de `wt-<tarefa>`: minúsculas e dígitos, com hífen entre trechos. Com o
// hífen virando `_`, cada tarefa dá uma base, e nenhuma outra dá a mesma.
const TASK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Base da worktree `wt-<task>`: `automabaca_test_<task>`, com `-` virando `_`.
 * @param {string} task
 */
export function worktreeTestDatabaseBase(task) {
  if (!TASK.test(task)) throw new Error(`Tarefa inválida: "${task}" (use a-z e 0-9, com hífen entre trechos).`);
  return assertTestDatabaseBase(`${DEFAULT_TEST_DATABASE}_${task.replaceAll("-", "_")}`);
}

/**
 * Pasta `wt-*` que já cai na base da tarefa, se houver: as duas dividiriam os bancos.
 * @param {string} task
 * @param {string[]} existingTasks nomes das pastas `wt-*`, sem o `wt-`
 */
export function worktreeSharingBase(task, existingTasks) {
  const base = worktreeTestDatabaseBase(task);
  return existingTasks.find((other) => other !== task && directoryBase(other) === base) ?? null;
}

/**
 * URL de um banco no servidor compartilhado, com usuário, senha e host do
 * `TEST_DATABASE_URL` da árvore principal.
 * @param {string | undefined} mainTestDatabaseUrl
 * @param {string} port
 * @param {string} database
 */
function sharedServerUrl(mainTestDatabaseUrl, port, database) {
  // O setter de `port` ignora valor inválido e manteria a porta da principal.
  if (!/^[1-9]\d{0,4}$/.test(String(port)) || Number(port) > 65_535) throw new Error(`Porta inválida: ${port}`);
  const url = new URL(mainTestDatabaseUrl || "postgresql://automabaca:automabaca@127.0.0.1/");
  url.port = String(port);
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

/**
 * `.env` de uma worktree nova: o da árvore principal, trocando só o
 * `TEST_DATABASE_URL`, que passa a apontar o banco da worktree no servidor
 * compartilhado.
 * @param {string} mainEnvText
 * @param {string} task
 */
export function worktreeEnvText(mainEnvText, task, port = SHARED_TEST_SERVER_PORT) {
  const url = sharedServerUrl(parse(mainEnvText).TEST_DATABASE_URL, port, worktreeTestDatabaseBase(task));
  const line = `TEST_DATABASE_URL="${url}"`;
  let replaced = false;
  // Função, não string: um `$` na senha viraria padrão de substituição.
  const text = mainEnvText.replace(/^[ \t]*(?:export[ \t]+)?TEST_DATABASE_URL[ \t]*=.*$/gm, () => {
    replaced = true;
    return line;
  });
  if (replaced) return text;
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

/**
 * Roda `work` conectado ao `postgres` do servidor compartilhado. Sem conexão,
 * devolve o motivo em vez de falhar: o `db-test` guarda os bancos na RAM, e o
 * que sobrar some quando o container reiniciar.
 * @template T
 * @param {string} mainEnvText
 * @param {string} port
 * @param {(admin: import("pg").ClientBase) => Promise<T>} work
 * @returns {Promise<T | { unreachable: string }>}
 */
async function onSharedServer(mainEnvText, port, work) {
  const { default: pg } = await import("pg");
  // Curto: com a rede espelhada do WSL, porta sem servidor no 127.0.0.1 não
  // recusa a conexão, só deixa esperando.
  const admin = new pg.Client({
    connectionString: sharedServerUrl(parse(mainEnvText).TEST_DATABASE_URL, port, "postgres"),
    connectionTimeoutMillis: 3_000,
  });
  try {
    await admin.connect();
  } catch (error) {
    return { unreachable: error instanceof Error ? error.message : String(error) };
  }
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

/**
 * Apaga, no servidor compartilhado, os bancos da worktree `wt-<task>`.
 * @param {string} mainEnvText
 * @param {string} task
 */
export async function dropWorktreeTestDatabases(mainEnvText, task, port = SHARED_TEST_SERVER_PORT) {
  const base = worktreeTestDatabaseBase(task);
  return onSharedServer(mainEnvText, port, async (admin) => ({ dropped: await dropTestDatabaseFamily(admin, base) }));
}

/**
 * Apaga, no servidor compartilhado, as famílias de worktree que já não existe.
 * @param {string} mainEnvText
 * @param {string[]} existingTasks nomes das pastas `wt-*`, sem o `wt-`
 */
export async function pruneOrphanTestDatabases(mainEnvText, existingTasks, port = SHARED_TEST_SERVER_PORT) {
  return onSharedServer(mainEnvText, port, (admin) => pruneOrphanFamilies(admin, existingTasks));
}
