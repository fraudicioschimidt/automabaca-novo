/** Contrato vigente no RapidAPI. */
export const FLASHSCORE_PLAN_NAME = "Ultra";
export const FLASHSCORE_DAILY_CONTRACTED_REQUESTS = 10_000;
export const FLASHSCORE_CONTRACTED_REQUESTS_PER_MINUTE = 240;

/**
 * Guarda-corpos operacionais.
 *
 * A reserva diária absorve diferença de janela/contabilidade e deixa espaço
 * para uma sonda operacional sem encostar no hard limit. O teto por minuto é
 * global entre web e worker e preserva 20 slots/min para jitter do fornecedor.
 */
export const FLASHSCORE_DAILY_OPERATIONAL_CAP = 9_500;
export const FLASHSCORE_OPERATIONAL_REQUESTS_PER_MINUTE = FLASHSCORE_CONTRACTED_REQUESTS_PER_MINUTE - 20;
export const FLASHSCORE_TRANSIENT_RETRIES = 1;
export const FLASHSCORE_REQUEST_COOLDOWN_MS = Math.ceil(
  60_000 / FLASHSCORE_OPERATIONAL_REQUESTS_PER_MINUTE,
);
