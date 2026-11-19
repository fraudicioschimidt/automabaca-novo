/**
 * Vocabulário único de mercados cuja UNIDADE é uma estatística (cartões,
 * escanteios, props de jogador…), e não o placar da partida, e as unidades
 * que o placar responde em cada esporte. A regra mora em Rust
 * (`rust/crates/dominio/src/mercados/stat_qualifier.rs`), junto com o porquê
 * de cada termo.
 *
 * Vive em `mercados/` porque dois consumidores precisam dele antes do
 * settlement: a coerção de mercado no registro (`coerce.ts`, que não pode
 * apagar a estatística ao reescrever o rótulo) e o roteamento de providers
 * (`providers/coverage.ts`). O espelho SQL (`score-resolvable-query.ts`) usa
 * os mesmos termos: divergir ali tira a aposta do IA-Judge.
 */
import dominio from "@automabaca/dominio";

/** Fonte única das alternativas; o espelho SQL é gerado daqui (ver `nonScoreStatSqlTerms`). */
export const NON_SCORE_STAT_TERMS = dominio.nonScoreStatTerms();

/** A linha exige que CADA time alcance o mínimo de cartões, não o total do jogo. */
export function isBothTeamsCardsText(text: string): boolean {
  return dominio.isBothTeamsCardsText(text);
}

/**
 * A seleção DECLARA uma linha de estatística — não apenas contém uma palavra que
 * por acaso é nome de estatística ("Total / Over 9.5 Aces", não "Las Vegas Aces").
 */
export function selecaoDeclaraLinhaDeEstatistica(selecao: string): boolean {
  return dominio.selecaoDeclaraLinhaDeEstatistica(selecao);
}

/** Mercados de estatística (cartões, escanteios, props…) nunca resolvem por placar. */
export function hasNonScoreStatQualifier(mercado: string, selecao: string): boolean {
  return dominio.hasNonScoreStatQualifier(mercado, selecao);
}

/**
 * Um rótulo que nomeia a UNIDADE de Total/Handicap não pode cair aberto no
 * placar só porque essa unidade ainda não entrou no vocabulário.
 */
export function hasUnknownScoreQualifier(mercado: string): boolean {
  return dominio.hasUnknownScoreQualifier(mercado);
}

/** Termos aceitos pelo espelho SQL ao filtrar qualificadores nomeados. */
export function knownScoreQualifierSqlTerms(): string[] {
  return dominio.knownScoreQualifierSqlTerms();
}

/** Termos `contains` da denylist SQL, derivados das mesmas alternativas da regex. */
export function nonScoreStatSqlTerms(): string[] {
  return dominio.nonScoreStatSqlTerms();
}

const [goals, runs, points] = dominio.scoreUnitRules();

/**
 * Unidade da linha e esportes em que ela É o placar. Exportado como DADO
 * porque o filtro SQL precisa do mesmo par (termo, esporte) para não admitir
 * o que o domínio recusa. `inside` = a unidade vale NOS esportes listados;
 * fora deles é fail-closed.
 */
export const SCORE_UNIT_RULES = {
  goals: { terms: goals[0], sports: goals[1], mode: "inside" },
  runs: { terms: runs[0], sports: runs[1], mode: "inside" },
  points: { terms: points[0], sports: points[1], mode: "inside" },
} as const;

/** Espelho SQL de `hasScoreUnitMismatch`: os termos no plural, o lado seguro do `contains`. */
export function scoreUnitTermsForSql(): string[] {
  return dominio.scoreUnitTermsForSql();
}

/** Unidade da linha que NÃO é o placar agregado do esporte. */
export function hasScoreUnitMismatch(
  mercado: string,
  selecao: string,
  esporte?: string,
): boolean {
  return dominio.hasScoreUnitMismatch(mercado, selecao, esporte);
}

/** Unidade explícita do placar que pertence a outra modalidade. */
export function hasSportScoreUnitMismatch(mercado: string, selecao: string, esporte?: string): boolean {
  return dominio.hasSportScoreUnitMismatch(mercado, selecao, esporte);
}
