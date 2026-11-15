/** Retomadas de capacidade precisam ceder ao fallback e ao backoff normal. */
export const MAX_SPORT_CAPACITY_CONTINUATIONS = 3;

/** Backoff do resolvedor de esporte: 30 s, 2 min, 30 min e depois de 2 em 2 h por 24 h. */
export const SPORT_FAST_RETRY_DELAYS_SECONDS = [30, 120, 1_800] as const;
export const SPORT_EXTENDED_RETRY_DELAY_SECONDS = 7_200;
export const SPORT_EXTENDED_RETRY_COUNT = 12;

/**
 * Da captura ao fim do backoff, quando o dono é avisado de que a busca não
 * achou o esporte (~24,5 h).
 */
export const SPORT_RESOLUTION_BACKOFF_MS =
  (SPORT_FAST_RETRY_DELAYS_SECONDS.reduce((total, seconds) => total + seconds, 0) +
    SPORT_EXTENDED_RETRY_DELAY_SECONDS * SPORT_EXTENDED_RETRY_COUNT) * 1_000;

/**
 * Vezes da busca web do resolvedor de esporte, contadas do kickoff: a primeira
 * na tentativa 1 (30 s depois da captura), uma com menos de 3 h para o jogo e
 * a última com menos de 45 min, quando a web já tem prévia e escalação. Kickoff
 * inferido não tem relógio: só a primeira. A vez só se gasta com um veredito
 * da busca; falha, cota ou trava fechada deixam a mesma vez para a próxima
 * tentativa.
 */
export type WebSportSearchTurn = "first" | "pre_3h" | "pre_45m";

/** Da mais tardia para a mais cedo: a primeira que o relógio alcançou vale. */
const KICKOFF_TURNS: ReadonlyArray<{ turn: WebSportSearchTurn; beforeKickoffMs: number }> = [
  { turn: "pre_45m", beforeKickoffMs: 45 * 60_000 },
  { turn: "pre_3h", beforeKickoffMs: 3 * 3_600_000 },
];

/** Grava a memória da busca web por aposta em `provider_caches`. */
export const WEB_SPORT_MEMORY_PROVIDER = "sport-web";

/** A vez da busca web em que a aposta está agora; null antes da tentativa 1. */
export function webSportSearchTurn(params: {
  attempt: number;
  kickoff: Date;
  kickoffInferido: boolean;
  now: Date;
}): WebSportSearchTurn | null {
  if (params.attempt < 1) return null;
  if (!params.kickoffInferido) {
    const untilKickoff = params.kickoff.getTime() - params.now.getTime();
    const reached = KICKOFF_TURNS.find(({ beforeKickoffMs }) => untilKickoff <= beforeKickoffMs);
    if (reached) return reached.turn;
  }
  return "first";
}

/** Quando abre a próxima vez da web ainda não gasta; null sem kickoff conhecido ou sem vez. */
export function nextWebSportSearchAt(params: {
  kickoff: Date;
  kickoffInferido: boolean;
  now: Date;
  spent: readonly WebSportSearchTurn[];
}): Date | null {
  if (params.kickoffInferido) return null;
  const opening = [...KICKOFF_TURNS]
    .reverse()
    .map(({ turn, beforeKickoffMs }) => ({ turn, at: params.kickoff.getTime() - beforeKickoffMs }))
    .find(({ turn, at }) => at > params.now.getTime() && !params.spent.includes(turn));
  return opening ? new Date(opening.at) : null;
}

export function canSearchSportOnWeb(params: {
  turn: WebSportSearchTurn | null;
  spent: readonly WebSportSearchTurn[];
  continuation: number;
  outsideWindow: boolean;
  capacityDeferred: boolean;
  force?: boolean;
}): boolean {
  if (params.outsideWindow) return false;
  if (params.force) return true;
  if (!params.turn || params.spent.includes(params.turn)) return false;
  if (params.capacityDeferred) return params.continuation >= MAX_SPORT_CAPACITY_CONTINUATIONS;
  return true;
}
