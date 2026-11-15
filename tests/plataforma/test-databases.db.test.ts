import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropTestDatabaseFamily,
  pruneOrphanFamilies,
  quoteDisposableDatabaseName,
  suiteLockKey,
  workerDatabaseName,
} from "../../scripts/lib/test-databases.mjs";

/**
 * Worktrees dividem o servidor de teste: cada suíte trava só a própria família
 * de bancos, e apagar a família de uma worktree não toca a de outra.
 */

// Únicas por execução: outra suíte rodando no mesmo servidor não as vê.
const sufixo = `familia${process.pid}x${Date.now().toString(36)}`;
const A = `automabaca_test_${sufixo}`;
const B = `automabaca_test_${sufixo}b`; // começa com o nome da A
const C = `automabaca_test_${sufixo}c`;
// A poda só olha este prefixo: no servidor compartilhado há famílias de outras worktrees.
const PODA = `automabaca_test_poda${sufixo}`;

let admin: Client;

async function conectar(banco = "postgres"): Promise<Client> {
  // No `postgres`, o mesmo banco do admin da suíte: a trava consultiva vale por banco.
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${banco}`;
  const cliente = new Client({ connectionString: url.toString() });
  await cliente.connect();
  return cliente;
}

async function tentarTravar(cliente: Client, base: string): Promise<boolean> {
  const { rows } = await cliente.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
    [suiteLockKey(base)],
  );
  return rows[0]!.ok;
}

async function bancosQueComecamCom(prefixo: string): Promise<string[]> {
  const { rows } = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
    [prefixo],
  );
  return rows.map((row) => row.datname).sort();
}

beforeAll(async () => {
  admin = await conectar();
});

async function criar(...nomes: string[]): Promise<void> {
  for (const nome of nomes) await admin.query(`CREATE DATABASE ${quoteDisposableDatabaseName(nome)}`);
}

afterAll(async () => {
  for (const base of [A, B, C, `${PODA}a`, `${PODA}b`, `${PODA}c`]) {
    await dropTestDatabaseFamily(admin, base).catch(() => undefined);
  }
  await admin.end();
});

describe("bancos de teste de worktrees no mesmo servidor", () => {
  it("a suíte em curso segura a trava da própria base, e só dela", async () => {
    // O global-setup desta suíte travou a base dela; o banco deste worker é `<base>_<pool>`.
    const banco = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    const base = banco.slice(0, banco.lastIndexOf("_"));
    expect(workerDatabaseName(base, process.env.VITEST_POOL_ID!)).toBe(banco);

    const outraSuite = await conectar();
    const terceira = await conectar();
    try {
      expect(await tentarTravar(outraSuite, base)).toBe(false);
      // Duas famílias novas travam ao mesmo tempo, cada uma na sua conexão...
      expect(await tentarTravar(outraSuite, A)).toBe(true);
      expect(await tentarTravar(terceira, B)).toBe(true);
      // ...e a mesma família continua exclusiva.
      expect(await tentarTravar(terceira, A)).toBe(false);
    } finally {
      // Fechar a conexão solta as travas dela.
      await outraSuite.end();
      await terceira.end();
    }
  });

  it("apagar a família de uma worktree não leva os bancos de outra", async () => {
    const daA = [A, `${A}_template`, `${A}_1`, `${A}_e2e`];
    const daB = [B, `${B}_1`];
    await criar(...daA, ...daB);

    expect((await dropTestDatabaseFamily(admin, A)).sort()).toEqual(daA.sort());
    expect(await bancosQueComecamCom(A)).toEqual(daB.sort());
  });

  it("recusa apagar a família de uma suíte que está rodando", async () => {
    const suite = await conectar();
    try {
      expect(await tentarTravar(suite, B)).toBe(true);
      await expect(dropTestDatabaseFamily(admin, B)).rejects.toThrow(/rodando/);
      expect(await bancosQueComecamCom(B)).toEqual([B, `${B}_1`].sort());
    } finally {
      await suite.end();
    }
  });

  it("recusa apagar a família com conexão aberta, inclusive no banco e2e, que não tem trava", async () => {
    const daC = [C, `${C}_1`, `${C}_e2e`, `${C}_migrate`];
    await criar(...daC);
    const navegador = await conectar(`${C}_e2e`);
    try {
      await expect(dropTestDatabaseFamily(admin, C)).rejects.toThrow(/em uso/);
      expect(await bancosQueComecamCom(C)).toEqual([...daC].sort());
    } finally {
      await navegador.end();
    }
    expect((await dropTestDatabaseFamily(admin, C)).sort()).toEqual([...daC].sort());
  });

  it("a poda apaga só as famílias ociosas sem pasta wt-*", async () => {
    await criar(`${PODA}a`, `${PODA}a_1`, `${PODA}a_e2e`, `${PODA}b`, `${PODA}b_1`, `${PODA}c`, `${PODA}c_migrate`);
    const autoria = await conectar(`${PODA}c_migrate`);
    try {
      // Só a pasta da `b` existe; a `c` está em uso.
      const resultado = await pruneOrphanFamilies(admin, [`poda${sufixo}b`], PODA);
      expect(resultado.dropped.sort()).toEqual([`${PODA}a`, `${PODA}a_1`, `${PODA}a_e2e`].sort());
      expect(resultado.busy).toEqual([`${PODA}c`]);
      expect(await bancosQueComecamCom(PODA))
        .toEqual([`${PODA}b`, `${PODA}b_1`, `${PODA}c`, `${PODA}c_migrate`].sort());
    } finally {
      await autoria.end();
    }
  });

  it("recusa apagar a família padrão, que é de todo checkout", async () => {
    await expect(dropTestDatabaseFamily(admin, "automabaca_test")).rejects.toThrow(/todo checkout/);
  });
});
