import { utcToSpParts } from "@/src/domain/dates";

/**
 * Kickoff "inferido" = horário NÃO autoritativo do tipster.
 * Casos: post sem data (caller usa postDate), ou só dia/mês sem hora
 * (parse defaulta 00:00 SP). Nesses casos o calendário BridgeOdds / match
 * Pinnacle (ou busca web Gemini se a API não listar o evento) deve corrigir
 * `Bet.data` antes do closing.
 */

/** true quando o parse não trouxe data, ou trouxe só o dia. */
export function kickoffInferidoFromParsed(bet: {
  data: Date | null;
  kickoffDateOnly?: boolean;
}): boolean {
  if (bet.data == null) return true;
  return bet.kickoffDateOnly === true;
}

/**
 * Meia-noite SP costuma ser o default de date-only: um horário assim não
 * prova kickoff real. Não usar sozinha para gravar.
 */
export function looksLikeSpMidnightKickoff(date: Date): boolean {
  const sp = utcToSpParts(date);
  return sp.getUTCHours() === 0 && sp.getUTCMinutes() === 0 && sp.getUTCSeconds() === 0;
}

/** Mudança ≥1h no kickoff invalida tentativas sharp feitas com o horário velho. */
export const KICKOFF_MATERIAL_CHANGE_MS = 60 * 60_000;

export function kickoffChangedMaterially(anterior: Date, novo: Date): boolean {
  return Math.abs(novo.getTime() - anterior.getTime()) >= KICKOFF_MATERIAL_CHANGE_MS;
}

/** O mesmo jogo em fontes diferentes: até 5 min de diferença é o mesmo kickoff. */
export const SAME_KICKOFF_TOLERANCE_MS = 5 * 60_000;

export function sameKickoff(a: Date, b: Date): boolean {
  const delta = Math.abs(a.getTime() - b.getTime());
  return Number.isFinite(delta) && delta <= SAME_KICKOFF_TOLERANCE_MS;
}
