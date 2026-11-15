import "dotenv/config";
import { defineConfig } from "prisma/config";

const GENERATE_ONLY_URL = "postgresql://prisma-generate.invalid/automabaca";

/**
 * A guarda de banco descartável de `scripts/lib/test-databases.mjs`: nomes que
 * as ferramentas de teste criam e destroem, inclusive os das worktrees. Aqui
 * servem para RECUSAR o papel administrativo, não para autorizar destino. A
 * regra fica copiada, e não importada, porque o migrador de produção
 * (`deploy/migrar.py`) extrai do commit só este arquivo, `prisma/` e o que o
 * `npm ci` precisa; `tests/plataforma/prisma-config.test.ts` confere que as
 * duas cópias concordam.
 */
const BANCO_DESCARTAVEL = /^automabaca_(?:test(?:_[a-z0-9]+)*|e2e|migrate)$/;

function apontaParaBancoDescartavel(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const banco = decodeURIComponent(new URL(url).pathname.slice(1));
    return banco.length <= 63 && BANCO_DESCARTAVEL.test(banco);
  } catch {
    return false;
  }
}

export function resolvePrismaDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
): string {
  const touchesExistingDatabase = argv.includes("migrate") || argv.includes("db");
  // `DATABASE_URL_ADMIN` existe para a migration de produção rodar com papel
  // administrativo, e por isso vence o `DATABASE_URL` comum. Mas vencer sempre
  // é perigoso: um `migrate deploy` disparado de dentro de uma suíte, num
  // ambiente que por acaso tenha a ADMIN exportada, migraria o banco de
  // produção em vez do descartável. Quando o destino declarado é claramente um
  // banco de teste, a ADMIN herdada perde — nenhum fluxo legítimo pede papel
  // administrativo para mexer em `automabaca_test_*`.
  const admin = touchesExistingDatabase && env["DATABASE_URL_ADMIN"] && !apontaParaBancoDescartavel(env["DATABASE_URL"]);
  const databaseUrl = admin ? env["DATABASE_URL_ADMIN"] : env["DATABASE_URL"];
  if (databaseUrl) return databaseUrl;
  // `generate` só lê o schema. Um URL sintaticamente válido permite gerar o
  // client em builds sem segredo; migrate/db continuam falhando antes de tocar
  // em qualquer host acidental.
  if (argv.includes("generate")) return GENERATE_ONLY_URL;
  throw new Error("DATABASE_URL não configurada.");
}

const databaseUrl = resolvePrismaDatabaseUrl(process.env, process.argv);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Sem isto, `prisma migrate reset` recria o banco SEM a taxonomia de
    // mercados e os testes quebram por dado ausente, não por regressão.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: databaseUrl,
  },
});
