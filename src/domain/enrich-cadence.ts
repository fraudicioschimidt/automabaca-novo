/**
 * Cadência de revive/retry do enrich — SSOT.
 * O job inicial continua imediato. Revival existe só para reaprender informação
 * que ainda não estava disponível; repetir a cada 5min consumiu a cota inteira
 * com as mesmas apostas. A cadência acompanha o cache de identidade de 30min.
 * Recuperação de aposta já liquidada é manutenção de histórico e roda, no
 * máximo, a cada 6h. Os modos que revivem (CLV_ONLY e IDENTITY_ONLY) só
 * buscam identidade, então a cadência é uma só para todos.
 */

export const CADENCIA_PERTO_MS = 60 * 60_000;
export const CADENCIA_LONGE_MS = 2 * 60 * 60_000;
export const CADENCIA_HISTORICAL_MS = 6 * 60 * 60_000;

export function reviveCadenciaMs(pertoDoKickoff: boolean, historical = false): number {
  if (historical) return CADENCIA_HISTORICAL_MS;
  return pertoDoKickoff ? CADENCIA_PERTO_MS : CADENCIA_LONGE_MS;
}

/** Kickoff provisório (`data` é a meia-noite SP do dia): a busca vale até o dia acabar. */
export const PROVISIONAL_KICKOFF_DAY_MS = 24 * 3_600_000;
/** Depois do jogo a busca segue por 24 h; aí a identidade vira UNMATCHED. */
export const PAST_EVENT_TERMINAL_DELAY_MS = 24 * 3_600_000;
