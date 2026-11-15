import { splitEventoTeams } from "@/src/domain/text";
import type { PriceSnapshot } from "@/src/domain/price-provenance";
import {
  encodePinnacle17PriceReference,
  parsePinnacle17PriceReference,
  pinnacle17SportId,
  type Pinnacle17Event,
} from "@/src/providers/pinnacle17/types";
import { fetchPinnacle17Odds, type Pinnacle17Deadline } from "@/src/providers/pinnacle17/client";
import {
  pinnacle17ClosingReservedAttempt,
  reservePinnacle17Closing,
  releasePinnacle17ClosingReservation,
} from "@/src/providers/pinnacle17/sharp";
import { resolvePinnacle17CurrentOdds } from "@/src/providers/pinnacle17/odds";

type Pinnacle17Reference = NonNullable<ReturnType<typeof parsePinnacle17PriceReference>>;

/**
 * Referência a gravar para o preço resolvido agora. Referência v1 (sem unidade)
 * continua v1; as novas fixam a unidade. Quem já tinha referência exige que a
 * nova seja idêntica.
 */
export function pinnedPinnacle17Reference(previous: Pinnacle17Reference | null, resolved: Pinnacle17Reference): string {
  return encodePinnacle17PriceReference(previous && !previous.unit ? { ...resolved, unit: undefined } : resolved);
}

/** O evento persistido na aposta, no formato que o resolvedor de odds da Pinnacle17 espera. */
export function persistedPinnacle17Event(
  bet: { evento: string; esporte: string; data: Date },
  eventId: number,
): Pinnacle17Event | null {
  const teams = splitEventoTeams(bet.evento);
  const sportId = pinnacle17SportId(bet.esporte);
  if (!teams || sportId === null) return null;
  return {
    id: eventId,
    name: bet.evento,
    startTime: bet.data.toISOString(),
    status: { isStarted: false, isInProgress: false, isInterrupted: false },
    sport: { id: sportId, name: bet.esporte },
    league: { id: 1, name: "persisted", country: null },
    homeTeam: { name: teams.home },
    awayTeam: { name: teams.away },
    units: "Regular",
  };
}

export type Pinnacle17ClosingCapture = {
  raw: number;
  fair: number;
  maxBet: number | null;
  snapshot: PriceSnapshot;
  reference: string;
  observedAt: Date;
  gameStartAt: Date | null;
};

/** Antes de cada tentativa (`validate`) e depois de a cota dela ser paga (`charged`). */
type ClosingAttemptHooks = { validate?: () => Promise<void>; charged?: () => Promise<void> };

/**
 * Consulta de fechamento paga pela reserva de fechamento da aposta. A reserva
 * que a identidade fez só serve no mesmo dia de São Paulo, porque o orçamento
 * é diário; em outro dia a reserva sai aqui, do orçamento geral do dia. A
 * retentativa paga uma cota comum. `deadline` limita a espera e as tentativas.
 */
export async function capturePinnacle17Closing(bet: {
  evento: string;
  esporte: string;
  mercado: string;
  selecao: string;
  data: Date;
  sharp: { priceReference?: string | null; providerMatchId?: string | null } | null;
}, hooks?: ClosingAttemptHooks,
deadline?: Pinnacle17Deadline): Promise<Pinnacle17ClosingCapture | null> {
  const rawReference = bet.sharp?.priceReference?.trim() || null;
  const reference = parsePinnacle17PriceReference(rawReference);
  // Identidade já confirmada permite procurar a linha que abriu depois da tip.
  // Uma referência presente mas inválida continua sendo erro, sem fallback.
  if (rawReference && !reference) return null;
  const identityId = bet.sharp?.providerMatchId;
  const eventId = identityId && /^\d+$/.test(identityId) ? Number(identityId) : null;
  // A referência fixa o preço dentro do evento confirmado, nunca escolhe
  // outro evento para a consulta nem substitui uma identidade ausente.
  if (reference && reference.eventId !== eventId) return null;
  const event = eventId == null ? null : persistedPinnacle17Event(bet, eventId);
  if (eventId == null || !event || !Number.isSafeInteger(eventId) || eventId <= 0) return null;
  const reservationKey = rawReference ?? `pinnacle17:closing:${eventId}:${JSON.stringify([bet.esporte, bet.mercado, bet.selecao])}`;
  const reservation = await reservePinnacle17Closing(reservationKey);
  if (!reservation.ok) return null;
  const beforeAttempt = pinnacle17ClosingReservedAttempt(reservationKey);
  try {
    const attempt = async () => {
      await hooks?.validate?.();
      await beforeAttempt();
      await hooks?.charged?.();
    };
    const observed = await fetchPinnacle17Odds(eventId, attempt, event, deadline);
    if (!observed) return null;
    const resolved = resolvePinnacle17CurrentOdds({
      event,
      markets: observed.data,
      esporte: bet.esporte,
      mercado: bet.mercado,
      selecao: bet.selecao,
      observedAt: observed.observedAt,
    });
    if (!resolved.ok) return null;
    const resolvedReference = pinnedPinnacle17Reference(reference, resolved.value.reference);
    if (rawReference && resolvedReference !== rawReference) {
      return null;
    }
    return {
      ...resolved.value.current,
      reference: resolvedReference,
      observedAt: observed.observedAt,
      gameStartAt: resolved.value.gameStartAt,
    };
  } finally {
    await releasePinnacle17ClosingReservation(reservationKey);
  }
}
