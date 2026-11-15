/**
 * Pendência e base financeira são contagens distintas. VOID e CANCELED já
 * terminaram, mas não entram em stake/lucro/ROI. Só PENDING pode mudar o balde.
 */

import { contagem } from "./plural";

/** A parcela do agregado que ainda não liquidou. */
export type EmCurso = {
  /** Apostas do grupo sem resultado: o valor do balde ainda vai mudar. */
  readonly pendentes: number;
  /** Total de apostas do grupo, incluindo reembolsos encerrados. */
  readonly total: number;
};

/** Usa a contagem explícita de PENDING do agregado canônico. */
export function emCursoDoGrupo(g: { bets: number; pendingBets: number }): EmCurso {
  const total = Math.max(0, Math.trunc(g.bets));
  const pendentes = Math.min(total, Math.max(0, Math.trunc(g.pendingBets)));
  return { pendentes, total };
}

/** A mesma pendência sobre a linha remapeada pelo `tested-analyzer`. */
export function emCursoDaLinha(r: { n: number; pendingN: number }): EmCurso {
  return emCursoDoGrupo({ bets: r.n, pendingBets: r.pendingN });
}

/** O balde ainda se move? Sem pendente não há marca — senão ela vira decoração. */
export function aindaSeMove(e: EmCurso): boolean {
  return e.pendentes > 0;
}

/** O balde é INTEIRAMENTE futuro: nenhuma aposta dele liquidou ainda. */
export function totalmenteEmAberto(e: EmCurso): boolean {
  return e.total > 0 && e.pendentes === e.total;
}

/**
 * A frase nomeia as duas bases ("3 de 12"), nunca "3 pendentes" solto: "3" pode
 * ser irrelevante em 300 e decisivo em 4. Vazio quando não há o que declarar.
 */
export function textoDeEmCurso(e: EmCurso): string {
  if (!aindaSeMove(e)) return "";
  if (totalmenteEmAberto(e)) {
    return `${contagem(e.total, "aposta")} — nenhuma liquidada ainda`;
  }
  return `${e.pendentes} de ${contagem(e.total, "aposta")} ainda não ${
    e.pendentes === 1 ? "liquidou" : "liquidaram"
  }`;
}

/**
 * A ressalva do comparativo, sobre a janela ATUAL: sem ela o delta confunde
 * "o canal piorou" com "ainda não terminou de liquidar".
 */
export function ressalvaDoComparativo(e: EmCurso): string {
  if (!aindaSeMove(e)) return "";
  return `${e.pendentes} ${
    e.pendentes === 1 ? "aposta ainda não liquidou" : "apostas ainda não liquidaram"
  } — o número ainda vai mudar`;
}
