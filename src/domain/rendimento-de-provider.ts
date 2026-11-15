/**
 * O que cada provider ENTREGA — e em que janela isso é medido.
 *
 * A autoria não mora numa coluna só: identidade e fechamento ficam em
 * `provider`, mas o RESULTADO fica em `bet_result.resultProvider` (é o
 * trabalho do flashscore). Contar só `bet_sharp.provider` mostra quem mais
 * trabalha como custo puro. Por isso a lista abaixo é de COLUNAS, não de
 * apelidos de provider: coluna de autoria nova em BetSharp, BetClosing ou
 * BetResult precisa ser classificada aqui.
 *
 * As duas janelas são DIFERENTES de propósito — o custo é do período do teto
 * (é o que diz se a cota vai estourar), o rendimento é de 7 dias (a hora
 * corrente do bridgeodds renderia ruído). A tela declara as duas, porque não
 * são um delta.
 */

/** Período do TETO de cada provider — o mesmo vocabulário do budget. */
export type PeriodoDeCusto = "month" | "day" | "hour";

/**
 * Janela do rendimento. É a MESMA que decide se o provider aparece na tela
 * ("some quem não consome há 7 dias"): o card já chamava 7 dias de "recente"
 * para existir, e usar outro número para medir seria uma segunda definição.
 */
export const JANELA_DE_RENDIMENTO_DIAS = 7;
export const JANELA_DE_RENDIMENTO_MS = JANELA_DE_RENDIMENTO_DIAS * 24 * 3_600_000;

export type TipoDeTrabalho = "identidade" | "fechamento" | "resultado";

/** Onde a autoria de cada trabalho é gravada, e o que a data. */
export type AutoriaDeTrabalho = {
  /** Modelo do schema que guarda a autoria (1:1 com a aposta). */
  readonly modelo: "BetSharp" | "BetClosing" | "BetResult";
  /** Coluna que grava QUEM entregou. */
  readonly autoria: string;
  /** Coluna que data QUANDO o trabalho aconteceu — recorta a janela. */
  readonly instante: string;
};

export const AUTORIA_DO_TRABALHO: Readonly<Record<TipoDeTrabalho, AutoriaDeTrabalho>> = {
  // `identityResolvedAt` não muda em refresh de odds: é o instante do trabalho.
  identidade: { modelo: "BetSharp", autoria: "provider", instante: "identityResolvedAt" },
  fechamento: { modelo: "BetClosing", autoria: "provider", instante: "fetchedAt" },
  resultado: { modelo: "BetResult", autoria: "resultProvider", instante: "resultCheckedAt" },
};

export const TIPOS_DE_TRABALHO = Object.keys(AUTORIA_DO_TRABALHO) as readonly TipoDeTrabalho[];

export type RendimentoDeProvider = Readonly<Partial<Record<TipoDeTrabalho, number>>>;

/** Soma do que o provider entregou na janela — 0 é ausência, não falta de dado. */
export function totalEntregue(rendimento: RendimentoDeProvider): number {
  return TIPOS_DE_TRABALHO.reduce((soma, tipo) => soma + (rendimento[tipo] ?? 0), 0);
}
