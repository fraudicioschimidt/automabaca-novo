import catalog from "./catalog-data.json";

export type MercadoCatalogAlias = {
  readonly alias: string;
  readonly casaDeAposta?: string;
};

/**
 * Registro executável único do catálogo final e dos aliases materializados,
 * em `catalog-data.json`: o TypeScript o importa (e tira daqui o tipo dos
 * mercados finais), o seed persiste exatamente estes dados e o crate
 * `dominio` o lê na compilação (`rust/crates/dominio/build.rs`), evitando duas
 * representações autoritativas. O deploy não roda o seed: mercado ou alias
 * novo chega ao banco de produção pelo `scripts/ops-sincronizar-mercados.ts`.
 */
export const MERCADO_CATALOG: Readonly<Record<keyof typeof catalog, readonly MercadoCatalogAlias[]>> = catalog;

export type MercadoCatalogName = keyof typeof catalog;
