/** Endereços novos reservam espaço para o sufixo de homônimos. */
export const MAX_BANKROLL_SLUG_LENGTH = 120;
/** Aceita também endereços já gerados com o sufixo além dos 120 caracteres. */
export const MAX_BANKROLL_SLUG_INPUT_LENGTH = 200;

type BankrollIdentity = { id: string; nome: string; slug: string };

/** O nome é livre; o slug distingue homônimos sem trocar a identidade interna. */
export function bankrollIdentityLabels(banks: readonly BankrollIdentity[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const bank of banks) counts.set(bank.nome, (counts.get(bank.nome) ?? 0) + 1);
  const used = new Set<string>();
  // O desempate independe da página e da ordem de apresentação do seletor.
  const ordered = [...banks].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  return new Map(ordered.map((bank) => {
    let label = (counts.get(bank.nome) ?? 0) > 1 ? `${bank.nome} (${bank.slug})` : bank.nome;
    // Um nome literal pode coincidir com o rótulo de um homônimo.
    while (used.has(label)) label += ` [${bank.slug}]`;
    used.add(label);
    return [bank.id, label];
  }));
}
