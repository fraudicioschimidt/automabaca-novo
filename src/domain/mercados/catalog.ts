/**
 * Catálogo aceito na entrada + labels FINAIS Pinnacle (Config/seed). Os finais
 * vêm de `catalog-data.json`; os intermediários, as traduções e a resolução
 * moram em Rust (`rust/crates/dominio/src/mercados/catalog.rs`).
 */
import dominio from "@automabaca/dominio";
import {
  MERCADO_CATALOG,
  type MercadoCatalogName,
} from "@/src/domain/mercados/catalog-data";

/**
 * Intermediários sport-aware (`Asian Handicap`, `Total`, `Moneyline`) continuam
 * aceitos para o finalize mapear por esporte; a Config lista só os finais.
 */
export const MERCADOS_INTERMEDIARIOS: readonly string[] = Object.freeze(dominio.mercadosIntermediarios());

/** Labels FINAIS persistidos e listados no Config (estilo Pinnacle). */
export const MERCADOS_FINAIS = Object.freeze(
  Object.keys(MERCADO_CATALOG) as MercadoCatalogName[],
);

export type MercadoFinal = MercadoCatalogName;

/** Tudo que `resolveMercadoStatic` aceita (entrada + final). */
export const CANONICAL_MARKETS: readonly string[] = [...MERCADOS_INTERMEDIARIOS, ...MERCADOS_FINAIS];

/** Traduções diretas PT/legado → intermediário ou final (defensivas). */
export const MERCADO_TRANSLATIONS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(dominio.mercadoTranslations()),
);

/** Chave de lookup de alias: minúsculo, sem acento, só [a-z0-9] e espaço. */
export function normalizeMercadoKey(s: string): string {
  return dominio.normalizeMercadoKey(s);
}

/** Resolve apenas nomes canônicos, sem aplicar aliases/traduções. */
export function resolveMercadoCanonical(raw: string): string | null {
  return dominio.resolveMercadoCanonical(raw);
}

/** Resolve direto contra catálogo + traduções estáticas (sem banco). */
export function resolveMercadoStatic(raw: string): string | null {
  return dominio.resolveMercadoStatic(raw);
}

/** O mercado gravado está no vocabulário canônico Pinnacle? */
export function isMercadoFinal(mercado: string): boolean {
  return dominio.isMercadoFinal(mercado);
}
