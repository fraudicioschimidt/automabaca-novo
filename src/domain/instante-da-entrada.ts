import { kickoffInferidoFromParsed } from "./kickoff-infer";

/** Horário original da origem; a aposta digitada no painel não tem um e usa o do registro. */
export function instanteDaEntrada(bet: {
  registradoEm: Date;
  sourcePostedAt?: Date | null;
}): Date {
  return bet.sourcePostedAt ?? bet.registradoEm;
}

/**
 * O rascunho completado numa edição chegou depois do kickoff lido do texto?
 * Kickoff inferido (post sem hora) não prova nada: aí vale só a janela da
 * edição.
 */
export function editedAfterKickoff(editedAt: Date, bet: { data: Date | null; kickoffDateOnly?: boolean }): boolean {
  return bet.data !== null && !kickoffInferidoFromParsed(bet) && editedAt.getTime() >= bet.data.getTime();
}
