import { shiftDayKey, spDayKey } from "@/src/domain/dates";
import { ProviderRequestGateError } from "@/src/domain/provider-error";

/** Horizonte observado no endpoint list-by-date; dias no fuso solicitado. */
export const FLASHSCORE_FUTURE_DAYS = 7;

export function flashscoreDateRetryAt(day: string, now = new Date()): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (day <= shiftDayKey(spDayKey(now), FLASHSCORE_FUTURE_DAYS)) return null;
  return new Date(`${shiftDayKey(day, -FLASHSCORE_FUTURE_DAYS)}T03:00:00.000Z`);
}

export class FlashscoreDateWindowError extends ProviderRequestGateError {
  constructor(readonly day: string, readonly retryAt: Date) {
    super("FlashscoreDateWindowError", "Data fora da janela futura do FlashScore.", "flashscore", "matches/list-by-date");
  }
}

/**
 * HTTP 400 em `/matches/list-by-date` é recusa de contrato/cliente do endpoint,
 * não queda estrutural do provider. Contar como falha do breaker abriria o
 * circuito em cascata (sport.resolve → settlement/stats).
 */
export class FlashscoreListByDateClientError extends ProviderRequestGateError {
  constructor(
    readonly day: string,
    readonly sportId: number,
    readonly providerMessage: string | null,
  ) {
    super(
      "FlashscoreListByDateClientError",
      providerMessage
        ? `FlashScore list-by-date recusou a consulta: ${providerMessage}`
        : "FlashScore list-by-date recusou a consulta (HTTP 400).",
      "flashscore",
      "matches/list-by-date",
    );
  }
}

/** Mensagem conhecida de horizonte futuro; mantém retryAt via FlashscoreDateWindowError. */
export function isFlashscoreFutureHorizonMessage(message: unknown): boolean {
  return typeof message === "string"
    && /does not support fetching data more than 7 days in the future/i.test(message);
}
