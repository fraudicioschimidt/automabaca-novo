/**
 * Onde cada barra começa e termina num trilho, e onde fica a régua.
 *
 * A regra: **a posição no trilho é monotônica no valor**. Desenhar o módulo e
 * deixar o sinal só na cor faz a pior casa ter a barra mais longa; o olho lê
 * comprimento antes de cor (e cor não chega a quem tem daltonismo). Negativo
 * cresce para a esquerda a partir do meio.
 *
 * A régua marca o agregado para ler cada barra contra o conjunto. Ela entra na
 * escala, nunca fica fora do trilho: marca no limite mentiria sobre a distância.
 */

/** Geometria de uma barra, em % do trilho. `esquerda + largura <= 100`. */
export type BarraGeom = {
  /** Distância da borda esquerda do trilho até o início da barra. */
  readonly esquerdaPct: number;
  /** Comprimento da barra. Zero quando o valor é nulo, zero ou não numérico. */
  readonly larguraPct: number;
  /** Cresce para a esquerda a partir do meio. Sempre `false` em trilho não centrado. */
  readonly negativa: boolean;
};

export type EscalaDeBarras = {
  /**
   * O zero está no MEIO do trilho. Só acontece quando existe algo negativo:
   * centrar sem negativo jogaria metade da largura fora, e o trilho todo
   * significaria metade da escala.
   */
  readonly centrada: boolean;
  readonly barras: readonly BarraGeom[];
  /** Posição da régua no trilho, em %. `null` quando não há régua a desenhar. */
  readonly reguaPct: number | null;
};

const numero = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * A escala do conjunto inteiro, de uma vez.
 *
 * Recebe os valores COM sinal; quem chama não tira módulo. A referência (régua)
 * é opcional e entra no cálculo do alcance, para nunca ser desenhada colada na
 * borda fingindo estar no limite.
 *
 * Recusas:
 *  - Conjunto vazio, ou tudo nulo/zero: todas as larguras ficam em 0 e a régua
 *    some. Não existe proporção sem escala, e um trilho cheio de barras de 100%
 *    afirmaria empate onde não há dado.
 *  - Valor nulo/não numérico: barra de largura zero, na posição do zero. A linha
 *    continua existindo (o rótulo dela informa), só não desenha comprimento.
 */
export function escalaDeBarras(
  valores: readonly (number | null | undefined)[],
  opts: { readonly referencia?: number | null } = {},
): EscalaDeBarras {
  const vs = (valores ?? []).map(numero);
  // Régua sobre UMA barra é a própria barra: a linha cairia colada na ponta e a
  // legenda repetiria o número que já está ao lado. Agregado só informa quando
  // há o que agregar.
  const referencia = vs.filter((v) => v != null).length > 1 ? numero(opts.referencia) : null;
  const centrada = vs.some((v) => v != null && v < 0) || (referencia != null && referencia < 0);
  const maxAbs = Math.max(
    0,
    ...vs.map((v) => (v == null ? 0 : Math.abs(v))),
    referencia == null ? 0 : Math.abs(referencia),
  );
  if (maxAbs === 0) {
    return {
      centrada,
      barras: vs.map(() => ({ esquerdaPct: centrada ? 50 : 0, larguraPct: 0, negativa: false })),
      reguaPct: null,
    };
  }
  // Centrado, cada metade vale `maxAbs`; à esquerda, o trilho inteiro vale.
  const meia = centrada ? 50 : 100;
  const barras = vs.map((v) => {
    if (v == null || v === 0) {
      return { esquerdaPct: centrada ? 50 : 0, larguraPct: 0, negativa: false };
    }
    const larguraPct = (Math.abs(v) / maxAbs) * meia;
    const negativa = v < 0;
    return { esquerdaPct: negativa ? 50 - larguraPct : centrada ? 50 : 0, larguraPct, negativa };
  });
  return {
    centrada,
    barras,
    reguaPct: referencia == null ? null : centrada ? 50 + (referencia / maxAbs) * 50 : (referencia / maxAbs) * 100,
  };
}

/** A régua e a legenda que a explica. */
export type Regua = { readonly v: number; readonly rotulo: string };

/**
 * A régua, fail-closed.
 *
 * `descricao` é escrita por quem chama porque só ele sabe sobre qual base o
 * número foi tirado, e a base tem de aparecer no texto ("ROI agregado" sozinho
 * não diz de quantas linhas). Devolve `null`, e o gráfico fica sem régua,
 * quando falta valor ou base: uma linha em zero para dizer "não sei" é pior.
 */
export function regua(args: {
  readonly valor: number | null | undefined;
  readonly texto: string;
  readonly descricao: string;
}): Regua | null {
  const v = numero(args.valor);
  if (v == null || !args.descricao || !args.texto) return null;
  return { v, rotulo: `${args.descricao}: ${args.texto}` };
}
