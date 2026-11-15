/**
 * Onde um valor cai no desenho e, quando há DUAS séries no mesmo retângulo,
 * onde cai o zero das duas.
 *
 * A regra: **duas séries só dividem um desenho se dividirem o zero.** Com
 * escalas independentes, a régua de zero vale para a primeira série e a segunda
 * tem um zero invisível em outro pixel; o leitor conclui "ponto acima da linha =
 * positivo" e erra. Quando não dá para dividir, `compartilhandoOZero` devolve
 * `null` e quem chama não desenha régua.
 *
 * A fórmula de escala mora só aqui, para os gráficos não a reescreverem à mão,
 * e as marcas dos eixos também: valores redondos no y (`marcasRedondas`) e só
 * os rótulos de x que cabem na largura (`rotulosQueCabem`).
 */

/**
 * Onde ficam, em pixels, as duas pontas do alcance.
 *
 * Eixo vertical inverte (`inicio` embaixo, `fim` em cima); eixo horizontal não.
 * É por isso que a faixa é dada em pixels e não como "altura + padding": o
 * mesmo helper serve o x do `Scatter` sem uma segunda fórmula.
 */
export type Faixa = { readonly inicio: number; readonly fim: number };

export type Escala = {
  readonly lo: number;
  readonly hi: number;
  /** O pixel de um valor. Não recorta: valor fora de [lo, hi] sai fora da faixa. */
  readonly px: (v: number) => number;
  /** O pixel do zero, ou `null` quando o zero está fora de [lo, hi]. */
  readonly pxDoZero: number | null;
};

const numeros = (vs: readonly (number | null | undefined)[]): number[] =>
  vs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

/** Faixa vertical de um gráfico com os paddings de sempre. */
export function faixaVertical(altura: number, padT: number, padB: number): Faixa {
  return { inicio: altura - padB, fim: padT };
}

/**
 * A escala linear de `[lo, hi]` sobre a faixa.
 *
 * Alcance degenerado (`hi <= lo`) não vira divisão por zero: tudo cai no meio
 * da faixa, que é o desenho honesto de "não há o que distinguir".
 */
export function escala(lo: number, hi: number, faixa: Faixa): Escala {
  const { inicio, fim } = faixa;
  const vao = hi - lo;
  const px = (v: number): number =>
    vao > 0 ? inicio + (fim - inicio) * ((v - lo) / vao) : (inicio + fim) / 2;
  return { lo, hi, px, pxDoZero: lo <= 0 && hi >= 0 ? px(0) : null };
}

/**
 * Que fatia do alcance está ACIMA do zero — `null` quando o zero não está
 * dentro dele.
 *
 * É o número que as duas séries precisam ter igual: se o zero divide o alcance
 * na mesma proporção, ele cai no mesmo pixel, e aí uma régua só serve às duas.
 */
export function fracaoDoZero(lo: number, hi: number): number | null {
  if (!(hi > lo) || lo > 0 || hi < 0) return null;
  return hi / (hi - lo);
}

export type OpcoesDeCompartilhamento = {
  /**
   * Alcance mínimo do lado que domina. Sem ele, uma série inteira de ROI de
   * 0,1% encostaria no topo e o desenho exageraria ruído como se fosse sinal.
   */
  readonly minimoAbs?: number;
  /** Folga acima do maior valor, para o ponto extremo não colar na borda. */
  readonly folga?: number;
};

/**
 * A escala da SEGUNDA série, com o zero no mesmo pixel do zero da primeira.
 *
 * Devolve `null` — e quem chama NÃO desenha régua compartilhada — quando o zero
 * da primária está fora do alcance dela ou numa das pontas: colado na borda não
 * existe proporção que a segunda série possa acompanhar sem jogar metade dos
 * próprios valores para fora do desenho.
 *
 * A conta: fixada a fatia `f` acima do zero, `lo = -hi (1 − f) / f`, e daí
 * `hi / (hi − lo) = f` de volta — o pixel do zero sai idêntico por construção,
 * não por coincidência de dado. `tests/painel/eixo-secundario.test.tsx` varre a igualdade.
 */
export function compartilhandoOZero(
  valores: readonly (number | null | undefined)[],
  primaria: Escala,
  faixa: Faixa,
  opcoes: OpcoesDeCompartilhamento = {},
): Escala | null {
  const f = fracaoDoZero(primaria.lo, primaria.hi);
  if (f == null || f <= 0 || f >= 1) return null;
  const vs = numeros(valores);
  const { minimoAbs = 0, folga = 1.1 } = opcoes;
  const acima = Math.max(0, ...vs);
  const abaixo = Math.max(0, ...vs.map((v) => -v));
  // O lado que domina define o alcance; o outro sai da proporção do zero.
  const bruto = Math.max(acima, (abaixo * f) / (1 - f), minimoAbs);
  // Tudo zero (ou nada a desenhar): um alcance simbólico põe todo mundo na
  // régua, que é exatamente onde os valores estão.
  const hi = bruto > 0 ? bruto * folga : 1;
  return escala(-(hi * (1 - f)) / f, hi, faixa);
}

/** Passos "redondos" dentro de cada potência de dez. */
const PASSOS_REDONDOS = [1, 2, 2.5, 5, 10] as const;

/**
 * As marcas do eixo y: múltiplos de um passo redondo (1, 2, 2,5 ou 5 × 10ⁿ)
 * dentro de `[lo, hi]`, com o zero entre elas quando o alcance o cruza.
 *
 * O passo é o menor redondo que não passa de `alvo` intervalos, então as
 * marcas nunca ficam mais apertadas que `(hi − lo) / alvo`. O alcance não é
 * esticado até a marca: o gráfico continua usando a altura para os dados, e a
 * ponta sem marca fica sem rótulo.
 */
export function marcasRedondas(lo: number, hi: number, alvo = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return lo === 0 || hi === 0 ? [0] : [];
  const bruto = (hi - lo) / Math.max(1, alvo);
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const passo = PASSOS_REDONDOS.map((m) => m * potencia).find((p) => p >= bruto * (1 - 1e-9)) ?? 10 * potencia;
  const marcas: number[] = [];
  for (let k = Math.ceil(lo / passo - 1e-9); k * passo <= hi + passo * 1e-9; k++) {
    // `toPrecision` tira o resíduo de ponto flutuante (0.30000000000000004); `+ 0` tira o -0.
    marcas.push(Number((k * passo).toPrecision(12)) + 0);
  }
  return marcas;
}

/**
 * Quais rótulos do eixo x desenhar sem que um encavale no outro: índices
 * espaçados por igual, sempre com o último (o dado mais recente) e, se couber,
 * o primeiro.
 *
 * A conta supõe o desenho de todos os gráficos: primeiro rótulo ancorado no
 * início, último no fim e os do meio centrados. Por isso o vão mínimo entre
 * dois vizinhos é 1,5 rótulo (meio do centrado + o inteiro da ponta), e com
 * só as duas pontas, dois rótulos. A largura sai do rótulo mais longo em fonte
 * mono (0,62 em por caractere) mais um em de respiro.
 */
export function rotulosQueCabem(rotulos: readonly string[], largura: number, tamanhoDaFonte: number): number[] {
  const n = rotulos.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const maisLongo = Math.max(0, ...rotulos.map((r) => r.length));
  const rotulo = maisLongo * tamanhoDaFonte * 0.62 + tamanhoDaFonte;
  if (largura < 2 * rotulo) return [n - 1];
  const vizinho = largura / (n - 1);
  const passo = Math.max(1, Math.ceil((1.5 * rotulo) / vizinho - 1e-9));
  const indices: number[] = [];
  for (let i = 0; i < n - 1; i += passo) indices.push(i);
  // O último entra sempre; sai o vizinho que ficaria colado nele.
  while (indices.length > 1 && (n - 1 - indices[indices.length - 1]!) * vizinho < 1.5 * rotulo) indices.pop();
  indices.push(n - 1);
  return indices;
}
