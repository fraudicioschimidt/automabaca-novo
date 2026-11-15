/**
 * O que a comparação entre duas janelas PODE afirmar.
 *
 * Cada KPI tem base própria (lucro/ROI contam resolvidas, CLV conta fechamentos
 * confiáveis, steam conta aberturas), e a guarda tem de olhar a base do número
 * comparado, não a contagem de apostas da janela: esta deixaria passar um CLV
 * de 60 fechamentos contra 1 como "+25,6 p.p." em verde.
 */

import { AMOSTRA_MINIMA_EXIBICAO } from "@/src/domain/analyzer/shared";

/** Quantas observações sustentam o número, de cada lado da comparação. */
export type BaseDaComparacao = {
  /** Observações da métrica na janela atual — não apostas da janela. */
  readonly atual: number;
  /** As mesmas observações na janela anterior. */
  readonly anterior: number;
};

/**
 * O que a tela tem direito de dizer.
 *
 * `amostra-curta` e `anterior-vazia` são estados DIFERENTES de propósito:
 * "não apostei nada lá" e "apostei, mas quase nada fechou" pedem frases
 * distintas, e colapsá-las esconderia justamente o caso do CLV com base 1.
 */
export type FormaDoDelta =
  /** Não há janela anterior (recorte `tudo`) — nada a comparar. */
  | "sem-anterior"
  /** A janela anterior não tem observação nenhuma desta métrica. */
  | "anterior-vazia"
  /** Um dos lados não produziu valor (métrica indisponível na janela). */
  | "sem-valor"
  /** Há valor dos dois lados, mas a base não sustenta um veredito. */
  | "amostra-curta"
  /** Pode afirmar: número, sinal e cor. */
  | "delta";

/**
 * Decide fail-closed: qualquer entrada torta cai num estado que NÃO afirma.
 *
 * A ordem importa. `anterior-vazia` vem antes de `amostra-curta` porque base
 * zero tem explicação própria; e as duas vêm antes de `delta` porque um número
 * colorido é uma afirmação, não uma decoração.
 */
export function formaDoDelta(args: {
  rotuloAnterior: string | null | undefined;
  atual: number | null | undefined;
  anterior: number | null | undefined;
  base: BaseDaComparacao;
}): FormaDoDelta {
  if (!args.rotuloAnterior) return "sem-anterior";
  const atualBase = baseSanitizada(args.base.atual);
  const anteriorBase = baseSanitizada(args.base.anterior);
  if (anteriorBase === 0) return "anterior-vazia";
  if (args.atual == null || args.anterior == null) return "sem-valor";
  if (!Number.isFinite(args.atual) || !Number.isFinite(args.anterior)) return "sem-valor";
  if (atualBase < AMOSTRA_MINIMA_EXIBICAO || anteriorBase < AMOSTRA_MINIMA_EXIBICAO) {
    return "amostra-curta";
  }
  return "delta";
}

/** Base negativa, fracionária ou `NaN` vira 0 — que nunca autoriza afirmar. */
function baseSanitizada(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/**
 * A frase nomeia AS DUAS contagens, pela mesma regra do `textoDeEmCurso`:
 * "amostra curta" sozinho não diz se falta 1 ou 4, nem de que lado.
 */
export function textoDeAmostraCurta(base: BaseDaComparacao, rotuloAnterior: string): string {
  return `amostra curta: ${baseSanitizada(base.atual)} agora vs ${
    baseSanitizada(base.anterior)
  } em ${rotuloAnterior}`;
}
