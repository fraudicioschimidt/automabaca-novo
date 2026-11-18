/**
 * Vocabulário ÚNICO de Draw No Bet e Dupla Chance, como DADOS: o classificador
 * de mercado (`classify.ts`), a limpeza da seleção (`settlement/sides.ts`) e a
 * allowlist SQL do lote de liquidação
 * (`services/settlement/score-resolvable-query.ts`) saem das mesmas listas. As
 * listas, os padrões e os termos SQL moram em Rust
 * (`rust/crates/dominio/src/mercados/draw_vocabulary.rs`).
 */
import dominio from "@automabaca/dominio";

const [
  standalone,
  abbreviations,
  verbs,
  objects,
  states,
  nouns,
  nounQualifiers,
  connectors,
  doubleChanceStandalone,
  doubleChanceAbbreviations,
  doubleChanceTerms,
] = dominio.drawVocabulary();

export const DRAW_NO_BET_VOCABULARY = Object.freeze({
  /** Rótulos que já significam DNB sozinhos. */
  standalone,
  /** Siglas: no SQL usam limite de token, nunca `contains` amplo. */
  abbreviations,
  /** "Empate <verbo> [objeto]". */
  verbs,
  objects,
  /** "Empate <estado>". */
  states,
  /** "<substantivo> [do valor] <conector> empate". */
  nouns,
  nounQualifiers,
  connectors,
});

export const DOUBLE_CHANCE_VOCABULARY = Object.freeze({
  standalone: doubleChanceStandalone,
  abbreviations: doubleChanceAbbreviations,
  /** Combina com "dupla" nas duas ordens ("Dupla Chance"/"Chance Dupla"). */
  terms: doubleChanceTerms,
});

/** Termo da allowlist: todos os trechos precisam estar presentes no mercado. */
export type MarketVocabularyTerm = { readonly all: readonly string[] };

/** Detecta e remove sufixos ou qualificadores DNB/Empate Anula da seleção. */
export function stripDrawNoBetFromSelection(selecao: string): { isDnb: boolean; cleanTeam: string } {
  const cleanTeam = dominio.stripDrawNoBetFromSelection(selecao);
  return cleanTeam === null ? { isDnb: false, cleanTeam: selecao } : { isDnb: true, cleanTeam };
}

/** Detecta e remove prefixos ou sufixos de Dupla Chance (DC / Dupla Chance) da seleção. */
export function stripDoubleChanceFromSelection(selecao: string): { isDc: boolean; cleanTeam: string } {
  const cleanTeam = dominio.stripDoubleChanceFromSelection(selecao);
  return cleanTeam === null ? { isDc: false, cleanTeam: selecao } : { isDc: true, cleanTeam };
}

const terms = (lists: string[][]): MarketVocabularyTerm[] => lists.map((all) => ({ all }));

/**
 * Espelho SQL do vocabulário. Siglas ficam fora: elas exigem limite de token,
 * que o chamador aplica com `marketAbbreviationFilters`.
 */
export function drawNoBetSqlTerms(): MarketVocabularyTerm[] {
  return terms(dominio.drawNoBetSqlTerms());
}

export function doubleChanceSqlTerms(): MarketVocabularyTerm[] {
  return terms(dominio.doubleChanceSqlTerms());
}
