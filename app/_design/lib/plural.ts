/** Concordância de número em PT-BR para textos de contagem ("1 conta", "2 contas"). */

/** Só a palavra, sem o número: "1 → aposta", "0/2 → apostas". */
export function plural(n: number, singular: string, pluralForma?: string): string {
  return Math.abs(n) === 1 ? singular : (pluralForma ?? `${singular}s`);
}

/** Número + palavra concordados: "1 aposta", "12 apostas". */
export function contagem(n: number, singular: string, pluralForma?: string): string {
  return `${n} ${plural(n, singular, pluralForma)}`;
}
