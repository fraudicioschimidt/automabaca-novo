import "server-only";

/**
 * `?mock=1` só em desenvolvimento. Em production o query param é ignorado
 * (nunca serve dados fake no painel autenticado).
 */
export function allowMockQuery(mock: string | undefined): boolean {
  if (mock === undefined) return false;
  if (process.env.NODE_ENV !== "production") return true;
  if (process.env.VISUAL_TEST_MODE !== "1" || !process.env.DATABASE_URL) return false;
  try {
    const database = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
    return /(?:^|_)e2e(?:_|$)/i.test(database);
  } catch {
    return false;
  }
}

/**
 * O fixture do `?mock=1`, ou `null` fora do ambiente que o admite. É a única
 * porta dos mocks: a regra de lint só aceita `import()` de `_design/mock`
 * dentro do carregador passado aqui, então nenhuma página serve fixture sem
 * passar por `allowMockQuery`.
 */
export async function mockFixture<T>(mock: string | undefined, load: () => Promise<T>): Promise<T | null> {
  return allowMockQuery(mock) ? load() : null;
}
