import { isDisposableDatabaseName } from "./test-databases.mjs";

/** URL independente das credenciais de produção, validada antes de abrir conexão. */
export function resolveDisposableMigrationUrl(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env.PRISMA_TEST_DATABASE_URL;
  if (!raw) throw new Error("PRISMA_TEST_DATABASE_URL é obrigatória para migrations de teste.");
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || !isDisposableDatabaseName(name)) {
    throw new Error("Destino de migration de teste não descartável.");
  }
  return url.toString();
}
