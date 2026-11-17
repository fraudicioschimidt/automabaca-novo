/**
 * Normalização de texto para MATCHING (nunca para exibição) e o vocabulário
 * de tokens de nome de time. É a base de `text.ts` e `team-category.ts`, que
 * dependem daqui e nunca o contrário. A regra e as listas moram em Rust
 * (`rust/crates/dominio/src/text_normalization.rs`).
 */
import dominio from "@automabaca/dominio";

/** `normalize("NFD")`, sem diacríticos, em minúsculas e sem espaço nas pontas. */
export function normalizeStr(s: string): string {
  return dominio.normalizeStr(s || "");
}

const [stopWords, reserveClassTokens, [reserveClassMarker]] = dominio.teamNameVocabulary();

export const TEAM_STOP_WORDS = new Set(stopWords);

/**
 * Reservas / II / Youth / U21–U23 — mesma "classe" em feeds (Pinnacle vs
 * tipster): "Adelaide United II" ↔ "Adelaide United U23". O "b" solto
 * (Barcelona B) fica fora: em várias ligas o time B ≠ U23.
 */
export const RESERVE_CLASS_TOKENS = new Set(reserveClassTokens);
export const RESERVE_CLASS_MARKER = reserveClassMarker!;

/** Token que distingue times diferentes (feminino, sub-20, B, reserva): nunca removido nem expandido. */
export function isProtectedToken(token: string): boolean {
  return dominio.isProtectedToken(token);
}

/**
 * Canonicaliza um nome de time para matching: acentos fora, separadores viram
 * espaço e abreviações expandidas, preservando tokens protegidos e números que
 * podem fazer parte da identidade ("Racing 01" ≠ "Racing 02").
 */
export function canonicalizeTeamName(s: string): string {
  return dominio.canonicalizeTeamName(s || "");
}

/** Formas equivalentes do mesmo nome (português, sigla do estado, abreviação), já canonicalizadas. */
export const TEAM_NAME_EQUIVALENTS: ReadonlyArray<readonly string[]> = dominio.teamNameEquivalents();

// O `text.ts`, ainda em TypeScript, chama `teamNameVariants` dentro do laço de
// comparação de nomes: a memória evita uma travessia da ponte por par.
const VARIANT_CACHE_LIMIT = 10_000;
const variantCache = new Map<string, readonly string[]>();

/**
 * As outras formas de um nome já canonicalizado, pelas equivalências (vazia
 * quando nenhuma regra se aplica, que é o caso comum).
 */
export function teamNameVariants(canon: string): readonly string[] {
  const cached = variantCache.get(canon);
  if (cached) return cached;
  const result = dominio.teamNameVariants(canon);
  if (variantCache.size >= VARIANT_CACHE_LIMIT) variantCache.clear();
  variantCache.set(canon, result);
  return result;
}
