import { normalizeMercadoKey } from "@/src/domain/mercados/catalog";
import { MERCADO_CATALOG, type MercadoCatalogAlias } from "@/src/domain/mercados/catalog-data";
import type { MercadoCatalogClient } from "@/src/services/mercados/normalize";

/** `mercados_alias` como produção o tem (o `MERCADO_CATALOG` materializado pelo seed): [destino, alias normalizado, casa]. */
export const PRODUCTION_MARKET_ALIASES: ReadonlyArray<readonly [string, string, string]> = [
  ...Object.entries(MERCADO_CATALOG).flatMap(([nome, aliases]) =>
    (aliases as readonly MercadoCatalogAlias[])
      .map((entry) => [nome, normalizeMercadoKey(entry.alias), entry.casaDeAposta ?? ""] as const)
      .filter(([, alias]) => alias)),
];

/** Cliente de catálogo com os aliases de produção, para `normalizeBetFields` sem banco. */
export function productionMarketCatalogClient(): MercadoCatalogClient {
  const aliases = PRODUCTION_MARKET_ALIASES.map(([nome, aliasNormalizado, casaDeAposta]) => ({
    aliasNormalizado, casaDeAposta, mercadoPadrao: { nome, ativo: true },
  }));
  const markets = Object.keys(MERCADO_CATALOG);
  return {
    mercadoAlias: { findMany: async () => aliases },
    mercadoPadrao: {
      findMany: async ({ where }: { where: { nome: { in: string[] } } }) =>
        markets.filter((nome) => where.nome.in.includes(nome)).map((nome) => ({ nome })),
    },
  } as unknown as MercadoCatalogClient;
}
