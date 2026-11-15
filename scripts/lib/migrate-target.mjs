/**
 * Banco ALVO da AUTORIA de migration (`prisma migrate dev`).
 *
 * `migrate dev` não gera SQL: ele gera E APLICA. Apontado para a
 * `DATABASE_URL`, toda migration escrita chegaria à PRODUÇÃO no instante da
 * autoria — antes do CI, do gate e do deploy, e sem rollback (trocar a imagem
 * reverte CÓDIGO, não DDL). Por isso a autoria acontece num banco descartável
 * do cluster de TESTE; a produção recebe DDL por um caminho só, o
 * `prisma migrate deploy` da release validada (portão:
 * `tests/plataforma/migrate-target.test.ts`).
 *
 * O banco de autoria é construído SÓ pelas migrations, então não arrasta para
 * a migration nova o drift cosmético da produção. O nome é o da família do
 * `TEST_DATABASE_URL` (`automabaca_migrate`, ou `<base>_migrate` numa
 * worktree): duas autorias no servidor compartilhado não zeram o banco uma da
 * outra.
 */
import { migrateDatabaseName, testDatabaseBaseFromUrl } from "./test-databases.mjs";

function partes(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    porta: parsed.port || "5432",
    banco: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

/**
 * URL de autoria derivada do cluster de teste, ou erro acionável.
 *
 * Devolve também `avisos` para o caso em que o alvo é um banco DIFERENTE no
 * MESMO cluster da produção: não há risco ao dado, mas a disputa por
 * checkpointer/WAL é a razão de o cluster de teste existir.
 */
export function resolveMigrateDatabaseUrl(env) {
  const teste = env.TEST_DATABASE_URL;
  if (!teste) {
    throw new Error(
      "TEST_DATABASE_URL ausente. `prisma migrate dev` APLICA a DDL no banco que aponta; " +
        "sem o cluster de teste o alvo seria a produção. Configure TEST_DATABASE_URL no .env.",
    );
  }

  let alvo;
  try {
    alvo = new URL(teste);
  } catch {
    throw new Error("TEST_DATABASE_URL não é uma URL válida.");
  }
  alvo.pathname = `/${migrateDatabaseName(testDatabaseBaseFromUrl(teste))}`;
  // O `pg` aceita `?host=` e `?port=` por cima do host do URL: a conferência
  // abaixo olharia um servidor, e a conexão administrativa iria para outro.
  alvo.search = "";
  const url = alvo.toString();

  const producao = env.DATABASE_URL;
  const avisos = [];
  if (producao) {
    let p;
    try {
      p = partes(producao);
    } catch {
      throw new Error("DATABASE_URL não é uma URL válida.");
    }
    const a = partes(url);
    if (a.host === p.host && a.porta === p.porta && a.banco === p.banco) {
      throw new Error(
        `Alvo de autoria coincide com a produção (${p.host}:${p.porta}/${p.banco}). ` +
          "Migration só chega à produção por `prisma migrate deploy` no deploy.",
      );
    }
    if (a.host === p.host && a.porta === p.porta) {
      avisos.push(
        `autoria e produção no MESMO cluster (${p.host}:${p.porta}); ` +
          "o dado está protegido, mas a disputa por WAL/checkpointer é o motivo do cluster de teste existir",
      );
    }
  }

  return { url, avisos };
}

/**
 * Nome do banco de autoria em `url`, conferido antes de a autoria o ZERAR: tem
 * de ser exatamente o da família do `TEST_DATABASE_URL`.
 */
export function assertAuthoringDatabase(url, env) {
  const banco = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  const esperado = migrateDatabaseName(testDatabaseBaseFromUrl(env.TEST_DATABASE_URL));
  if (banco !== esperado) {
    throw new Error(
      `banco de autoria inesperado (${banco}); esperado ${esperado}. ` +
        "Recusando recriar um banco cujo nome não é o descartável.",
    );
  }
  return banco;
}
