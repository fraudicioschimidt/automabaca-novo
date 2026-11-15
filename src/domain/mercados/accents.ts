/**
 * Grafia acentuada equivalente de um termo do vocabulário de mercados.
 *
 * O `contains` do Postgres compara CAIXA, não diacrítico: todo espelho SQL de
 * uma lista do domínio precisa das DUAS grafias. `draw-vocabulary.ts`,
 * `stat-qualifier.ts` e `score-resolvable-query.ts` usam esta mesma função —
 * com cópias, cada lista nova esquecia uma variante ("finalizacoe",
 * "titulo"/"taca"). Uma implementação, três bordas.
 *
 * As REGRAS vêm primeiro porque sobrevivem a termo novo; o mapa cobre só o que
 * é irregular e não tem sufixo previsível.
 */

const IRREGULAR: Record<string, string> = {
  campea: "campeã",
  hipotese: "hipótese",
  patrimonio: "patrimônio",
  prejuizo: "prejuízo",
  premio: "prêmio",
  serie: "série",
  taca: "taça",
  titulo: "título",
  trofeu: "troféu",
};

/**
 * Sufixos regulares do PT. `coe`/`cao` antes de `oe`/`ao` porque a cedilha faz
 * parte da regra; o plural opcional está no próprio padrão porque o espelho SQL
 * às vezes recebe o radical sem o `s` (`finalizacoes?` → `finalizacoe`).
 */
const SUFFIX_RULES: readonly (readonly [RegExp, string])[] = [
  [/coe(s?)\b/g, "çõe$1"],
  [/cao\b/g, "ção"],
  [/oe(s?)\b/g, "õe$1"],
  [/ao\b/g, "ão"],
  [/encia(s?)\b/g, "ência$1"],
];

/** Forma acentuada do termo (idempotente para termos sem acento). */
export function accentuate(term: string): string {
  const byWord = term.replace(/[a-z]+/g, (word) => IRREGULAR[word] ?? word);
  return SUFFIX_RULES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    byWord,
  );
}

/** `[termo]` quando não há acento; `[termo, acentuado]` quando há. */
export function accentVariants(term: string): string[] {
  const accented = accentuate(term);
  return accented === term ? [term] : [term, accented];
}
