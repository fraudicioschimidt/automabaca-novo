import { fmtU } from "@/src/domain/formato-de-resultado";
import { emojiStatus, rotuloStatus } from "@/src/domain/mensagem-operador";
import {
  BudgetExhaustedError,
  ProviderCadenceDeferredError,
  ProviderRequestError,
} from "@/src/domain/provider-error";
import type { BetStatus } from "@/src/generated/prisma/enums";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import {
  getFlashscoreMatchDetails,
  type getFlashscoreMatchPlayerStats,
  type getFlashscoreMatchStats,
  type getFlashscoreMatchSummary,
} from "@/src/providers/flashscore/client";
import {
  applyAutomaticBetStatusChange,
  BetNotPendingError,
  type ApplyBetStatusChangeResult,
} from "@/src/services/bets/settle";
import type { BetSettlementTerms } from "@/src/services/bets/settle-terms";
import { sendOperatorNotification } from "@/src/services/ops/alerts";

/**
 * O que todos os caminhos de liquidação pelo FlashScore compartilham: prazos,
 * marcas de `settlementOutcome`, orientação do par pelo casamento, caches por
 * ciclo e a aplicação do status com aviso ao operador.
 */

/**
 * Adiado ≠ cancelado: a regra padrão das casas mantém a aposta válida se o jogo
 * for remarcado dentro de 24–48h, e VOID imediato divergiria da casa. Cancelado
 * reembolsa na hora; adiado espera a graça (o jogo remarcado dentro da janela
 * do matcher liquida pelo resultado real).
 */
export const POSTPONED_VOID_GRACE_MS = 48 * 3_600_000;

/**
 * Até quando esperar por um dado que o feed publica com atraso (estatística de
 * time, lista de jogadores, resumo de gols). Metade das partidas devolve `[]`
 * no primeiro momento; seis horas após o kickoff dão ~8 tentativas com o jogo
 * encerrado. Depois disso o dado não vai aparecer, e o certo é chamar o
 * operador uma vez em vez de queimar cota calado.
 */
export const STATS_GRACE_MS = 6 * 3_600_000;

/**
 * Marcas de `settlementOutcome` em que quem decidiu o fim do jogo foi a DEDUÇÃO
 * do AutomaBACA, não uma afirmação do FlashScore. Produtores e consumidores (a
 * rechecagem e o relatório diário) leem a mesma lista.
 */
export const SETTLEMENT_OUTCOME_STATS_INFERIDO = "settled_from_stats_inferido";
export const OUTCOMES_INFERIDOS = [
  "settled_from_score_inferido",
  SETTLEMENT_OUTCOME_STATS_INFERIDO,
  "settled_from_goalscorer_inferido",
  "settled_from_player_prop_inferido",
  "settled_from_ordered_goalscorer_inferido",
] as const;

const INFERRED_SUFFIX = "_inferido";

/**
 * Marca a evidência como INFERIDA quando quem decidiu o fim do jogo fomos nós.
 * Só a liquidação ganha o sufixo: recusa (`manual_*`) e `already_settled` são
 * desfecho sem decisão nossa.
 */
export function marcarInferido(outcome: string, viaInferencia: boolean): string {
  return viaInferencia ? `${outcome}${INFERRED_SUFFIX}` : outcome;
}

/** O inverso de `marcarInferido`: o desfecho sem a marca e se o fim do jogo foi deduzido. */
export function splitInferredOutcome(outcome: string): { outcome: string; inferred: boolean } {
  return outcome.endsWith(INFERRED_SUFFIX)
    ? { outcome: outcome.slice(0, -INFERRED_SUFFIX.length), inferred: true }
    : { outcome, inferred: false };
}

export type FlashscorePair = { home: number; away: number };

/** Orienta um par do feed pelo casamento: `swapped` inverte mandante e visitante. */
export function orientFlashscorePair<T>(
  pair: { home: T; away: T } | null,
  swapped: boolean,
): { home: T; away: T } | null {
  if (!pair) return null;
  return swapped ? { home: pair.away, away: pair.home } : pair;
}

/** Placar listado da partida, na ordem do FEED (sem orientar). */
export function listedFlashscoreScore(
  match: { scores: { home: number | null; away: number | null } },
): FlashscorePair | null {
  return match.scores.home === null || match.scores.away === null
    ? null
    : { home: match.scores.home, away: match.scores.away };
}

export function scoredEventoFromFlashscoreMatch(
  match: { home_team: { name: string }; away_team: { name: string } },
  swapped: boolean,
): string {
  return swapped
    ? `${match.away_team.name} vs ${match.home_team.name}`
    : `${match.home_team.name} vs ${match.away_team.name}`;
}

/** Cota, breaker aberto ou recusa HTTP: não perguntamos, e o próximo ciclo tenta. */
export function isFlashscoreRequestRefused(error: unknown): boolean {
  return (
    error instanceof BudgetExhaustedError ||
    error instanceof CircuitOpenError ||
    error instanceof ProviderRequestError
  );
}

/**
 * Resposta 2xx fora do contrato: o fornecedor respondeu, então não é ele fora
 * do ar, e o próximo esporte×dia não bate no mesmo erro. Quem precisa separar
 * os dois testa isto antes de `isFlashscoreRequestRefused`.
 */
export function isFlashscoreContractError(error: unknown): boolean {
  return error instanceof ProviderRequestError && !error.blocked &&
    error.status !== undefined && error.status >= 200 && error.status < 300;
}

/** Indisponibilidade do fornecedor (breaker, cota, HTTP, cadência): não é falha nossa. */
export function isFlashscoreUnavailable(error: unknown): boolean {
  return (
    isFlashscoreRequestRefused(error) ||
    error instanceof ProviderCadenceDeferredError ||
    (error instanceof Error && error.name === "CircuitOpenError")
  );
}

/**
 * Consulta de detalhe (jogadores, resumo) cuja falha não é "o dado não saiu":
 * a observação não é gravada e a aposta volta no próximo ciclo. A
 * indisponibilidade sobe tipada, para o ciclo abortar as consultas restantes
 * sem alerta; o resto sobe com a aposta no texto, para o alerta de falha.
 */
export async function awaitFlashscoreDetail<T>(pending: Promise<T>, what: string, betId: string): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    if (isFlashscoreUnavailable(error)) throw error;
    throw new Error(`Falha ao consultar ${what} do FlashScore para a aposta ${betId}.`, { cause: error });
  }
}

export type StatsCache = Map<string, ReturnType<typeof getFlashscoreMatchStats>>;
/** `player-stats` é outro endpoint e outra cota: cache separado. */
export type PlayerStatsCache = Map<string, ReturnType<typeof getFlashscoreMatchPlayerStats>>;
export type SummaryCache = Map<string, ReturnType<typeof getFlashscoreMatchSummary>>;

/**
 * Uma chamada por partida por ciclo: duas apostas do mesmo jogo reaproveitam
 * a mesma Promise.
 */
export function cachedPerMatch<T>(
  cache: Map<string, Promise<T>>,
  matchId: string,
  request: (matchId: string) => Promise<T>,
): Promise<T> {
  const pending = cache.get(matchId) ?? request(matchId);
  cache.set(matchId, pending);
  return pending;
}

export type DetailsObservation = {
  body: Record<string, unknown> | null;
  requestStartedAt: string;
  observedAt: string;
};

export type DetailsCache = Map<string, Promise<DetailsObservation>>;

/**
 * `/matches/details` é uma chamada por partida, e mais de um caminho precisa
 * dela no mesmo ciclo (1º tempo de basquete, parciais de futebol). A Promise
 * rejeitada sai do mapa para que a próxima chamada do ciclo tente de novo.
 */
export function fetchMatchDetails(matchId: string, cache: DetailsCache): Promise<DetailsObservation> {
  let pending = cache.get(matchId);
  if (!pending) {
    pending = (async () => {
      const requestStartedAt = new Date().toISOString();
      const body = await getFlashscoreMatchDetails(matchId);
      return { body, requestStartedAt, observedAt: new Date().toISOString() };
    })();
    cache.set(matchId, pending);
    pending.catch(() => {
      cache.delete(matchId);
    });
  }
  return pending;
}

/** O aviso ao operador de uma liquidação pelo FlashScore, com o rótulo da evidência. */
export async function notifyFlashscoreSettlement(
  bet: Pick<BetSettlementTerms, "id" | "manualSettlementVersion" | "evento" | "selecao">,
  applied: ApplyBetStatusChangeResult,
  label: string,
): Promise<void> {
  // O VOID que cai aqui tem lucro zero: o sinal vem do lucro formatado.
  await sendOperatorNotification(
    `${emojiStatus(applied.status)} ${rotuloStatus(applied.status)} (${fmtU(applied.lucro)}) · ${bet.evento}\n` +
      `${bet.selecao}\n` +
      `Resultado: ${label} (FlashScore)`,
    { key: `settlement:${bet.id}:${bet.manualSettlementVersion ?? 0}` },
  );
}

/** Aplica o status decidido e avisa o operador com o rótulo da evidência. */
export async function settleFlashscoreBet(params: {
  bet: BetSettlementTerms;
  status: BetStatus;
  label: string;
}): Promise<boolean> {
  try {
    const applied = await applyAutomaticBetStatusChange({
      betId: params.bet.id,
      newStatus: params.status,
      source: "flashscore",
      expectedTerms: params.bet,
    });
    if (applied.previousStatus !== "PENDING") return false;
    await notifyFlashscoreSettlement(params.bet, applied, params.label);
    return true;
  } catch (error) {
    if (error instanceof BetNotPendingError) return false;
    throw error;
  }
}

export async function refundFlashscorePostponedOrCancelled(
  bet: BetSettlementTerms,
): Promise<boolean> {
  try {
    const applied = await applyAutomaticBetStatusChange({
      betId: bet.id,
      newStatus: "VOID",
      source: "flashscore",
      expectedTerms: bet,
    });
    const reembolsou = applied.previousStatus === "PENDING";
    if (reembolsou) {
      await sendOperatorNotification(
        `↩️ Reembolso${bet.evento ? ` · ${bet.evento}` : ""}\n`
          + "O FlashScore dá o jogo como cancelado ou adiado, então a aposta foi anulada (lucro 0).",
        { key: `settlement:${bet.id}:${bet.manualSettlementVersion ?? 0}` },
      );
    }
    return reembolsou;
  } catch (error) {
    if (error instanceof BetNotPendingError) return false;
    throw error;
  }
}
