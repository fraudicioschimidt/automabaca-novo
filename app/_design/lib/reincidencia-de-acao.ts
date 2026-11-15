/**
 * Há quanto tempo este problema existe e quantas vezes ele já voltou.
 *
 * Uma ação reaberta mantém o `openedAt` original e soma `reopenCount`; sem
 * dizer isso na tela, um problema crônico pareceria mais novo e menos grave a
 * cada retorno. A reincidência não é status: é fato ortogonal, e uma ação pode
 * estar reaberta E assumida pelo operador ao mesmo tempo.
 */

import { contagem } from "./plural";

export type FormaDoHistorico =
  /** Nasceu agora, ou a idade não acrescenta nada ao que a linha já diz. */
  | { readonly forma: "nada" }
  /** Existe há mais tempo do que a última ocorrência sugere. */
  | { readonly forma: "desde"; readonly texto: string }
  /** Já foi encerrada e voltou — pelo menos uma vez. */
  | { readonly forma: "reincidente"; readonly texto: string; readonly vezes: number };

/**
 * A frase sai dos instantes já formatados pelo adapter, não de `Date`: fuso e
 * formato de data são de `src/domain/dates`.
 *
 * Na reincidência vai o `desdeAbsoluto` de propósito: "voltou 7 vezes desde há
 * 35 dias" faz o operador calcular; "desde 13/07 10:00" ele lê.
 */
export function formaDoHistorico(args: {
  vezesQueVoltou: number | null | undefined;
  desdeRelativo: string | null | undefined;
  desdeAbsoluto: string | null | undefined;
  ultimaVezRelativo: string | null | undefined;
}): FormaDoHistorico {
  const vezes = Math.max(0, Math.trunc(Number(args.vezesQueVoltou) || 0));

  if (vezes > 0 && args.desdeAbsoluto) {
    return {
      forma: "reincidente",
      texto: `voltou ${contagem(vezes, "vez", "vezes")} desde ${args.desdeAbsoluto}`,
      vezes,
    };
  }

  // Sem a data não dá para afirmar reincidência com número; a marca some, mas
  // a linha não passa a mentir por isso — apenas para de dizer.
  if (vezes > 0) return { forma: "nada" };

  // "desde há 26 min" ao lado de "há 26 min" é ruído, não informação.
  if (args.desdeRelativo && args.desdeRelativo !== args.ultimaVezRelativo) {
    return { forma: "desde", texto: `desde ${args.desdeRelativo}` };
  }

  return { forma: "nada" };
}

/** Normaliza os contadores persistidos da ação sem permitir NaN na tela. */
export function contagemDaAcao(
  principal: { occurrences?: number | null; reopenCount?: number | null },
): { ocorrencias: number; vezesQueVoltou: number } {
  const inteiro = (valor: number | null | undefined) => Math.max(0, Math.trunc(Number(valor) || 0));
  return {
    ocorrencias: inteiro(principal.occurrences),
    vezesQueVoltou: inteiro(principal.reopenCount),
  };
}
