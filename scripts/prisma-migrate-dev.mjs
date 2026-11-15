#!/usr/bin/env node
/**
 * Autoria de migration SEM shadow database.
 *
 * `prisma migrate dev` replica a história num shadow database, onde o Prisma
 * NÃO cria `_prisma_migrations` — e a migration
 * `20260813174500_invalidate_reconstructed_fair_odds` lê essa tabela de
 * propósito (o cutoff vem do ledger, para sobreviver a um restore reaplicado
 * em outra data). No shadow o replay aborta com 42P01.
 *
 * Alternativas descartadas: editar a migration aplicada (o `migrate dev` recusa
 * o checksum, e um guarda `to_regclass` a tornaria no-op justamente no
 * restore) e pré-semear o shadow (o Prisma reseta o schema dele antes de usar).
 *
 * Aqui a história é replicada num banco DESCARTÁVEL DE VERDADE, por
 * `prisma migrate deploy`, que cria o ledger antes de aplicar. A garantia do
 * shadow ("a história reproduz o schema") continua: o banco de onde o diff
 * parte foi construído SÓ pelas migrations.
 *
 *   1. recria o banco de autoria (nome fail-closed, ver `lib/migrate-target`)
 *   2. `migrate deploy` — replica a história inteira, ledger incluso
 *   3. `migrate diff --from-config-datasource --to-schema` — a SQL nova
 *   4. escreve `prisma/migrations/<carimbo>_<nome>/migration.sql`
 *   5. `migrate deploy` de novo — aplica e REGISTRA a migration nova
 *
 * O DDL de banco vai por `pg` (dependência direta), e não por `psql`: binário
 * não declarado quebra em máquina limpa, e o `knip` acusa — corretamente.
 * `prisma migrate reset` faria o mesmo em um passo, mas o Prisma 7.9 o bloqueia
 * para agentes sem consentimento humano explícito, e contornar isso seria
 * furar uma proteção de propósito.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import pg from "pg";
import { assertAuthoringDatabase, resolveMigrateDatabaseUrl } from "./lib/migrate-target.mjs";
import { quoteDisposableDatabaseName } from "./lib/test-databases.mjs";
import { carimboDeMigration, nomeDeMigrationValido, parseArgsDeAutoria } from "./lib/migrate-authoring.mjs";

/** `--exit-code` do `migrate diff`: 0 = sem diferença, 2 = há SQL a escrever. */
const DIFF_VAZIO = 0;
const DIFF_COM_MUDANCA = 2;

function morrer(mensagem) {
  process.stderr.write(`${mensagem}\n`);
  process.exit(1);
}

let opcoes;
try {
  opcoes = parseArgsDeAutoria(process.argv.slice(2));
} catch (erro) {
  morrer(erro.message);
}

const { url, avisos } = resolveMigrateDatabaseUrl(process.env);
for (const aviso of avisos) console.warn(`aviso: ${aviso}`);

const alvo = new URL(url);
// Cinto e suspensório: `resolveMigrateDatabaseUrl` já recusa a produção, mas o
// passo 1 ZERA um banco. A conferência do nome é barata e explícita.
let bancoDeAutoria;
try {
  bancoDeAutoria = assertAuthoringDatabase(url, process.env);
} catch (erro) {
  morrer(erro.message);
}

process.stdout.write(
  `→ autoria de migration em ${alvo.hostname}:${alvo.port}/${bancoDeAutoria}\n` +
    "  (a produção recebe esta DDL pelo procedimento Docker do checkout)\n",
);

const ambiente = { ...process.env, DATABASE_URL: url };

function prisma(args, { silencioso = false } = {}) {
  return spawnSync("npx", ["prisma", ...args], {
    stdio: silencioso ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: ambiente,
  });
}

/**
 * Banco descartável do zero. O diff precisa partir de um estado produzido SÓ
 * pela história: uma autoria abortada antes deixaria drift aqui, e o drift
 * entraria na migration nova como se fosse mudança pedida.
 */
async function recriarBancoDeAutoria() {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const cliente = new pg.Client({ connectionString: admin.toString() });
  await cliente.connect();
  try {
    // `DROP DATABASE` não aceita parâmetro: o nome entra no SQL só depois da
    // guarda de banco descartável, além da conferência acima.
    const banco = quoteDisposableDatabaseName(bancoDeAutoria);
    await cliente.query(`DROP DATABASE IF EXISTS ${banco} WITH (FORCE)`);
    await cliente.query(`CREATE DATABASE ${banco}`);
  } finally {
    await cliente.end();
  }
}

// 1. Do zero, para o diff ser confiável.
process.stdout.write("→ recriando o banco de autoria…\n");
await recriarBancoDeAutoria();

// 2. A história inteira, com ledger — o que o shadow database não fazia.
process.stdout.write("→ replicando a história de migrations…\n");
if (prisma(["migrate", "deploy"]).status !== 0) {
  morrer("a história de migrations não aplica limpa; corrija antes de escrever a próxima.");
}

// 3. O que falta para o banco virar o schema.
const diff = prisma(
  ["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script", "--exit-code"],
  { silencioso: true },
);
if (diff.status !== DIFF_VAZIO && diff.status !== DIFF_COM_MUDANCA) {
  morrer(`migrate diff falhou:\n${diff.stderr || diff.stdout}`);
}
if (diff.status === DIFF_VAZIO) {
  process.stdout.write("nada a migrar: o schema já corresponde à história.\n");
  process.exit(0);
}

const sql = diff.stdout.replace(/^Loaded Prisma config.*\n/gm, "").trim();
if (!sql) morrer("migrate diff sinalizou mudança mas não produziu SQL.");

if (!opcoes.nome) {
  morrer("faltou --name <nome_da_migration>. Há mudança de schema pendente e ela precisa de nome.");
}
if (!nomeDeMigrationValido(opcoes.nome)) {
  morrer(`nome inválido (${opcoes.nome}): use minúsculas, dígitos e _, começando por letra.`);
}

// 4. O arquivo, no formato que o `migrate deploy` espera.
const diretorio = path.join("prisma", "migrations", `${carimboDeMigration(new Date())}_${opcoes.nome}`);
mkdirSync(diretorio, { recursive: true });
const arquivo = path.join(diretorio, "migration.sql");
writeFileSync(arquivo, `${sql}\n`);
process.stdout.write(`→ escrita ${arquivo}\n`);

if (opcoes.apenasCriar) {
  process.stdout.write("--create-only: revise a SQL e rode de novo sem a flag para aplicar.\n");
  process.exit(0);
}

// 5. Aplica e REGISTRA — sem isto a próxima autoria a veria como diff pendente.
if (prisma(["migrate", "deploy"]).status !== 0) {
  morrer(`a migration escrita não aplica. Revise ${arquivo}.`);
}
if (prisma(["generate"]).status !== 0) morrer("falha ao regenerar o client.");
process.stdout.write("✓ migration escrita, aplicada no banco de autoria e client regenerado.\n");
