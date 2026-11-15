import { sumMoneyBy } from "@/src/domain/money";

type Chave<T> = (keyof T & string) | ((linha: T) => unknown);

/**
 * As linhas de um agregado, ordenadas pela métrica que o cartão promete no
 * título ("Top casas por lucro", "Ranking por lucro"). Num ranking a posição
 * carrega significado; entregar em ordem de encontro ou de contagem desenha a
 * pior casa em primeiro.
 *
 * Nulo vai para o fim, sempre, e nunca vira sentinela numérica: um `-1e9`
 * como "sem valor" participa da conta e some no meio dos outros.
 */
export function ranking<T extends Record<string, unknown>>(
  linhas: readonly T[] | null | undefined,
  chave: Chave<T>,
): T[] {
  const valor = typeof chave === "function" ? chave : (l: T) => l?.[chave];
  const numero = (l: T): number | null => {
    const v = valor(l);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return [...(linhas ?? [])].sort((a, b) => {
    const va = numero(a), vb = numero(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return vb - va;
  });
}

type LinhaComStake = {
  stake: number;
  n?: number | null;
  k?: string | null;
  l?: string | null;
  label?: string | null;
};

type Concentracao = {
  n: number;
  pedidos: number;
  parcial: boolean;
  gruposTotal: number;
  stakeTop: number;
  stakeTotal: number;
  pct: number | null;
  /** Fração do MAIOR grupo sozinho: o que resta dizer quando o top-N cobre tudo. */
  pctMaior: number | null;
  rotuloMaior: string | null;
  apostasTop: number;
  apostasTotal: number;
};

/**
 * Quanto do stake está nos N maiores grupos. Um top-5 sem a fração é
 * curiosidade; com ela vira risco de carteira (61% do dinheiro em cinco ligas).
 *
 * Base: o mesmo `stake` que a tabela mostra, o das apostas liquidadas
 * (`agregaGrupo` só soma resolvidas), somado em BigInt-cents.
 *
 * Recusas:
 *  - Menos grupos que `n`: `parcial`, e o texto diz o número real em vez de
 *    anunciar um "top 5" que são 3.
 *  - Stake total zero: `pct` fica `null`. 0% sugeriria concentração nenhuma.
 *  - Um grupo só: 100% é verdade e é o que mais importa dizer.
 */
export function concentracao(
  linhas: readonly (LinhaComStake | null | undefined)[] | null | undefined,
  n = 5,
): Concentracao {
  const grupos = (linhas ?? []).filter((l): l is LinhaComStake => !!l && Number.isFinite(l.stake));
  const gruposTotal = grupos.length;
  const stakeTotal = sumMoneyBy(grupos, (l) => l.stake);
  const topN = Math.min(n, gruposTotal);
  const ordenados = ranking(grupos, "stake");
  const maiores = ordenados.slice(0, topN);
  const stakeTop = sumMoneyBy(maiores, (l) => l.stake);
  const maior = ordenados[0];
  return {
    n: topN,
    pedidos: n,
    parcial: gruposTotal > 0 && gruposTotal <= n,
    gruposTotal,
    stakeTop,
    stakeTotal,
    pct: stakeTotal > 0 ? (stakeTop / stakeTotal) * 100 : null,
    pctMaior: stakeTotal > 0 && maior ? (maior.stake / stakeTotal) * 100 : null,
    rotuloMaior: maior?.k ?? maior?.l ?? maior?.label ?? null,
    apostasTop: maiores.reduce((s, l) => s + (l.n ?? 0), 0),
    apostasTotal: grupos.reduce((s, l) => s + (l.n ?? 0), 0),
  };
}

/**
 * A frase pronta. `substantivo` no plural ("ligas", "casas", "mercados").
 * `null` quando não há o que afirmar: a tira some.
 *
 * Com menos grupos que o corte, o top-N cobriria 100% e a frase seria vazia;
 * aí o que informa é o maior sozinho ("a maior das 4 concentra 73%").
 */
export function fraseDeConcentracao(c: Concentracao | null | undefined, substantivo: string): string | null {
  if (!c || c.gruposTotal === 0 || c.pct == null) return null;
  const singular = substantivo.replace(/ções$/, "ção").replace(/ses$/, "s").replace(/s$/, "");
  if (c.gruposTotal === 1) {
    return `Todo o stake liquidado está em uma ${singular} só${c.rotuloMaior ? ` (${c.rotuloMaior})` : ""}.`;
  }
  if (c.parcial) {
    return `São ${c.gruposTotal} ${substantivo} ao todo, e a maior concentra ${Math.round(c.pctMaior ?? 0)}% do stake liquidado.`;
  }
  return `As ${c.n} maiores ${substantivo} concentram ${Math.round(c.pct)}% do stake liquidado.`;
}
