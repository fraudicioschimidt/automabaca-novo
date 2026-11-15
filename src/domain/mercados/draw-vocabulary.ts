/**
 * Vocabulário ÚNICO de Draw No Bet e Dupla Chance, como DADOS.
 *
 * Três bordas precisam da mesma lista: o classificador de mercado
 * (`classify.ts`), a limpeza de prefixo/sufixo da seleção
 * (`settlement/sides.ts`) e a allowlist SQL do lote de liquidação
 * (`services/settlement/score-resolvable-query.ts`). Grafia presente em só
 * duas delas deixa a aposta classificada mas fora do lote, PENDING para sempre
 * sem alerta. Por isso a regex e os termos SQL são CONSTRUÍDOS destas listas,
 * e o teste as percorre — grafia nova entra em um lugar só.
 */

import { accentVariants } from "./accents";

export const DRAW_NO_BET_VOCABULARY = {
  /** Rótulos que já significam DNB sozinhos. */
  standalone: ["draw no bet", "tie no bet", "aposta sem empate", "sem empate"],
  /** Siglas: no SQL usam limite de token, nunca `contains` amplo. */
  abbreviations: ["dnb"],
  /** "Empate <verbo> [objeto]". */
  verbs: ["anula", "devolve", "reembolsa", "estorna", "cancela"],
  objects: [
    "a aposta", "aposta", "o valor", "o investimento", "o dinheiro", "o capital",
    "o saldo", "saldo", "o patrimonio", "patrimonio", "o montante", "montante",
    "a verba", "verba", "a bet", "bet",
  ],
  /** "Empate <estado>". */
  states: [
    "nulo", "nao tem aposta", "nao conta", "nao vale", "sem aposta",
    // "Empate sem risco" é DNB; "APOSTA sem risco" é promoção de free bet e
    // não casa aqui porque o estado só vale depois da palavra "empate".
    "sem risco", "sem prejuizo", "sem perdas",
  ],
  /** "<substantivo> [do valor] <conector> empate". */
  nouns: ["reembolso", "devolucao", "estorno"],
  nounQualifiers: [
    "valor", "investimento", "aposta", "dinheiro", "capital", "saldo",
    "patrimonio", "montante", "verba", "bet",
  ],
  connectors: ["no", "em", "em caso de"],
} as const;

export const DOUBLE_CHANCE_VOCABULARY = {
  standalone: ["double chance"],
  abbreviations: ["dc"],
  /** Combina com "dupla" nas duas ordens ("Dupla Chance"/"Chance Dupla"). */
  terms: [
    "chance", "hipotese", "oportunidade", "possibilidade", "escolha", "opcao",
    "alternativa", "variante", "selecao",
  ],
} as const;


/** Termo da allowlist: todos os trechos precisam estar presentes no mercado. */
export type MarketVocabularyTerm = { readonly all: readonly string[] };

function spaced(parts: readonly string[], space: string): string {
  return parts.map((part) => part.replace(/ /g, space)).join("|");
}

/**
 * Padrão de DNB. `space` é o separador entre palavras: " " para chaves de
 * mercado (já normalizadas em espaço simples) e `\s+` para texto de seleção.
 */
export function drawNoBetPattern(space = " "): string {
  const objects = `(?:${spaced(DRAW_NO_BET_VOCABULARY.objects, space)})`;
  const verbs = `(?:${DRAW_NO_BET_VOCABULARY.verbs.join("|")})(?:${space}${objects})?(?:${space}de)?`;
  const states = `(?:${spaced(DRAW_NO_BET_VOCABULARY.states, space)})`;
  const nouns =
    `(?:${DRAW_NO_BET_VOCABULARY.nouns.join("|")})` +
    `(?:${space}(?:do|da)${space}(?:${DRAW_NO_BET_VOCABULARY.nounQualifiers.join("|")}))?` +
    `${space}(?:${spaced(DRAW_NO_BET_VOCABULARY.connectors, space)})${space}empate`;
  const standalone = spaced(
    [...DRAW_NO_BET_VOCABULARY.standalone, ...DRAW_NO_BET_VOCABULARY.abbreviations],
    space,
  );
  return `(?:${standalone}|empate${space}(?:${verbs}|${states})|${nouns})`;
}

/** Padrão de Dupla Chance, mesmo contrato de `space`. */
export function doubleChancePattern(space = " "): string {
  const terms = DOUBLE_CHANCE_VOCABULARY.terms.join("|");
  const standalone = spaced(
    [...DOUBLE_CHANCE_VOCABULARY.standalone, ...DOUBLE_CHANCE_VOCABULARY.abbreviations],
    space,
  );
  return `(?:${standalone}|dupla${space}(?:${terms})|(?:${terms})${space}dupla)`;
}

/**
 * Detecta e remove sufixos ou qualificadores DNB/Empate Anula da seleção.
 * Devolve `{ isDnb: boolean; cleanTeam: string }`.
 */
export function stripDrawNoBetFromSelection(selecao: string): { isDnb: boolean; cleanTeam: string } {
  const dnbRegex = new RegExp(`\\s*(?:[-(/])?\\s*(?:${drawNoBetPattern('\\s+')})\\s*\\)?$`, 'i');
  if (dnbRegex.test(selecao)) {
    const cleanTeam = selecao.replace(dnbRegex, '').trim();
    return { isDnb: true, cleanTeam };
  }
  return { isDnb: false, cleanTeam: selecao };
}

/**
 * Detecta e remove sufixos de Dupla Chance (DC / Dupla Chance) da seleção.
 */
export function stripDoubleChanceFromSelection(selecao: string): { isDc: boolean; cleanTeam: string } {
  const label = doubleChancePattern(String.raw`\s+`);
  const prefix = new RegExp(String.raw`^\s*(?:\(\s*)?${label}\b\s*\)?\s*[:–—-]?\s*`, "i");
  const suffix = new RegExp(String.raw`(?:^|\s+|\s*[-–—(/]\s*)${label}\b\s*\)?\s*$`, "i");
  // Fronteiras obrigatórias: uma palavra terminada em "dc" não é um mercado.
  // Compara sem acentos, mas usa os índices no original para preservar o nome.
  const normalized = selecao.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const start = normalized.match(prefix);
  const end = normalized.match(suffix);
  if (!start && !end) return { isDc: false, cleanTeam: selecao };
  const from = start?.[0].length ?? 0;
  const to = end?.index ?? selecao.length;
  return { isDc: true, cleanTeam: selecao.slice(from, Math.max(from, to)).trim() };
}

/**
 * Espelho SQL do vocabulário. O verbo entra sem o objeto porque `contains` já
 * é prefixo ("empate anula" cobre "Empate Anula a Aposta de"); o substantivo
 * entra como par composto porque o qualificador fica no MEIO da expressão
 * ("Devolução DO VALOR no empate"). Siglas ficam fora: elas exigem limite de
 * token, que o chamador aplica com `marketAbbreviationFilters`.
 */
export function drawNoBetSqlTerms(): MarketVocabularyTerm[] {
  const terms: MarketVocabularyTerm[] = [];
  for (const label of DRAW_NO_BET_VOCABULARY.standalone) {
    for (const variant of accentVariants(label)) terms.push({ all: [variant] });
  }
  for (const verb of DRAW_NO_BET_VOCABULARY.verbs) {
    for (const variant of accentVariants(`empate ${verb}`)) terms.push({ all: [variant] });
  }
  for (const state of DRAW_NO_BET_VOCABULARY.states) {
    for (const variant of accentVariants(`empate ${state}`)) terms.push({ all: [variant] });
  }
  for (const noun of DRAW_NO_BET_VOCABULARY.nouns) {
    for (const variant of accentVariants(noun)) terms.push({ all: [variant, "empate"] });
  }
  return terms;
}

export function doubleChanceSqlTerms(): MarketVocabularyTerm[] {
  const terms: MarketVocabularyTerm[] = [];
  for (const label of DOUBLE_CHANCE_VOCABULARY.standalone) terms.push({ all: [label] });
  for (const term of DOUBLE_CHANCE_VOCABULARY.terms) {
    for (const label of [`dupla ${term}`, `${term} dupla`]) {
      for (const variant of accentVariants(label)) terms.push({ all: [variant] });
    }
  }
  return terms;
}
