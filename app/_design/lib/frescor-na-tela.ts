import type { Frescor } from "@/src/domain/frescor";

/**
 * Como a idade de um dado se escreve, em um lugar só (como `cobertura-na-tela`
 * faz com a base). `tests/painel/frescor-na-tela.test.ts` impede as telas de
 * montarem a frase por conta própria.
 */

/**
 * "captura há 1 h" — ou a frase inteira da fonte ("sem heartbeat") quando o
 * instante nunca existiu, caso em que `texto` já é o `textoSemDado`.
 */
export function textoDeFrescor(f: Frescor): string {
  if (f.idadeMin == null) return f.texto;
  return `${f.rotulo} ${f.texto}`;
}

/**
 * A tira: várias fontes numa linha só.
 *
 * O sufixo "· atrasado" vai no TEXTO, não só na cor, porque a cor não chega ao
 * leitor de tela — e porque é o único sinal que distingue "não teve jogo" de "o
 * motor parou". Só fonte COM cadência pode chegar aqui com `atrasada`: o tipo
 * de `frescorDaFonte` não deixa o relógio do mundo alarmar.
 */
export function textoDaTiraDeFrescor(fontes: readonly Frescor[]): string {
  return fontes.map((f) => (f.atrasada ? `${textoDeFrescor(f)} · atrasado` : textoDeFrescor(f))).join(" · ");
}

/** Alguma fonte da tira passou da tolerância da própria cadência? */
export function algumaFonteAtrasada(fontes: readonly Frescor[]): boolean {
  return fontes.some((f) => f.atrasada);
}
