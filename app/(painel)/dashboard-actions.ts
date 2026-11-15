"use server";

import { markVisit } from "@/src/services/painel/queries/dashboard";
import { refusalAsResult, type ActionResult } from "@/src/services/shared/recusa";
import { actor } from "./_auth";

/** Folga para relógios: o instante da leitura vem do servidor, pela tela. */
const CLOCK_SKEW_MS = 60_000;

/**
 * A tela mostrou o resumo "desde a última visita": a visita avança para o
 * instante daquela leitura (não para agora), para o que mudou entre a leitura
 * e esta chamada entrar no próximo resumo.
 */
export async function markDashboardVisitAction(readAt: string): Promise<ActionResult> {
  const who = await actor();
  const seenAt = new Date(readAt);
  // Instante malformado ou no futuro é defeito do cliente: erro, não recusa.
  if (typeof readAt !== "string" || !Number.isFinite(seenAt.getTime()) || seenAt.getTime() > Date.now() + CLOCK_SKEW_MS) {
    throw new Error("Instante da leitura inválido.");
  }
  return refusalAsResult(async () => {
    await markVisit(who, seenAt);
    return {};
  });
}
