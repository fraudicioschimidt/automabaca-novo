import { spDayKey } from "@/src/domain/dates";
import {
  BudgetExhaustedError,
  ProviderRequestError,
} from "@/src/domain/provider-error";
import { ticketFixtureEventos, type EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import { splitEventoTeams } from "@/src/domain/text";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { deferFlashscoreWork } from "@/src/providers/flashscore/breaker-gate";
import { getFlashscoreCatalog } from "@/src/providers/flashscore/catalog";
import {
  flashscoreConfigured,
  listFlashscoreMatchesByDate,
} from "@/src/providers/flashscore/client";
import { flashscoreSettlesSportId, flashscoreSportId } from "@/src/providers/flashscore/sports";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";
import { BetSettlementTermsChangedError } from "@/src/services/bets/settle-terms";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { matchFlashscoreFixture, type LoadFlashscoreMatches } from "./match-identity";
import { processFlashscoreMatchOutcome } from "./match-outcome";
import {
  buildFlashscoreMatchedSnapshot,
  listFlashscoreEligibleBets,
  observacaoAnterior,
  persistFlashscoreObservation,
} from "./observation-store";
import {
  isFlashscoreContractError,
  isFlashscoreRequestRefused,
  isFlashscoreUnavailable,
  type DetailsCache,
  type PlayerStatsCache,
  type StatsCache,
  type SummaryCache,
} from "./settle";
import { observeFlashscoreTicketBet } from "./ticket";

/**
 * O ciclo de observação de resultados: agrupa as apostas pendentes por esporte
 * e dia, carrega o catálogo do FlashScore uma vez por grupo e observa cada
 * aposta. O FlashScore é o liquidador automático exclusivo por resultado
 * externo; providers sharp não validam nem complementam placar.
 */

const log = createLogger("flashscore-results");

export type FlashscoreObservationRun = {
  processed: number;
  matched: number;
  final: number;
  settled: number;
  refunded: number;
  unmatched: number;
  unsupported: number;
  failures: number;
};

type SportDayGroup = {
  sportId: number;
  day: string;
  bets: EligibleBet[];
};

/**
 * Duas contagens, porque as respostas certas são opostas: `diasSemProvider` =
 * não perguntamos (cota/breaker/recusa) e se cura no próximo ciclo;
 * `diasComErroNosso` = perguntamos e quebramos (bug, banco, payload).
 */
type CycleHealth = {
  diasSemProvider: number;
  diasComErroNosso: number;
  falhas: Array<{ betId: string; evento: string; motivo: string }>;
};

/** Caches de um ciclo por grupo: cada endpoint é chamado uma vez por partida. */
type DayCaches = {
  statsCache: StatsCache;
  playerStatsCache: PlayerStatsCache;
  summaryCache: SummaryCache;
  basketballDetailsCache: DetailsCache;
};

export async function runFlashscoreObservationOnce(
  now = new Date(),
): Promise<FlashscoreObservationRun> {
  const result: FlashscoreObservationRun = {
    processed: 0,
    matched: 0,
    final: 0,
    settled: 0,
    refunded: 0,
    unmatched: 0,
    unsupported: 0,
    failures: 0,
  };
  if (!flashscoreConfigured()) return result;

  const bets = await listFlashscoreEligibleBets({ now });
  result.processed = bets.length;
  if (bets.length === 0) return result;

  // Breaker aberto: o ciclo inteiro adia — uma leitura no topo, nenhuma chamada.
  if (await deferFlashscoreWork("settlement", { processed: result.processed })) return result;

  const bySportDay = await groupFlashscoreEligibleBets(bets, now, result);
  const health: CycleHealth = { diasSemProvider: 0, diasComErroNosso: 0, falhas: [] };
  const grupos = [...bySportDay.values()];
  const loadMatches = createFlashscoreMatchLoader();
  for (let indice = 0; indice < grupos.length; indice += 1) {
    const { sportId, day, bets: dayBets } = grupos[indice]!;
    const loaded = await loadFlashscoreSportDay(loadMatches, sportId, day);
    if (loaded.kind === "provider") {
      // Circuito aberto/cota: o próximo grupo bateria no MESMO gate. O que não
      // foi tentado conta como não resolvido nesta passada.
      health.diasSemProvider += 1;
      result.failures += grupos.slice(indice).reduce((total, grupo) => total + grupo.bets.length, 0);
      break;
    }
    if (loaded.kind === "internal") {
      result.failures += dayBets.length;
      health.diasComErroNosso += 1;
      continue;
    }
    const providerAborted = await observeSportDay({
      group: { sportId, day, bets: dayBets },
      matches: loaded.matches,
      loadMatches,
      now,
      result,
      health,
    });
    if (providerAborted) break;
  }

  await finishFlashscoreObservation({ result, health, grupos: bySportDay.size });
  return result;
}

/**
 * Observa as apostas de um grupo esporte×dia. Devolve `true` quando o
 * fornecedor caiu no meio: o restante do ciclo é adiado.
 */
async function observeSportDay(params: {
  group: SportDayGroup;
  matches: FlashscoreMatch[];
  loadMatches: LoadFlashscoreMatches;
  now: Date;
  result: FlashscoreObservationRun;
  health: CycleHealth;
}): Promise<boolean> {
  const { group, result, health } = params;
  const caches: DayCaches = {
    statsCache: new Map(),
    playerStatsCache: new Map(),
    summaryCache: new Map(),
    basketballDetailsCache: new Map(),
  };
  for (const bet of group.bets) {
    try {
      if (ticketFixtureEventos(bet).length > 0) {
        const ticketRun = await observeFlashscoreTicketBet({
          bet,
          matches: params.matches,
          sportId: group.sportId,
          day: group.day,
          now: params.now,
          loadMatches: params.loadMatches,
          summaryCache: caches.summaryCache,
        });
        if (ticketRun.matched) result.matched += 1;
        else result.unmatched += 1;
        if (ticketRun.final) result.final += 1;
        if (ticketRun.settled) result.settled += 1;
        continue;
      }
      await observeSingleBet({ ...params, bet, caches });
    } catch (error) {
      if (error instanceof BetSettlementTermsChangedError) {
        // Uma edição concorrente invalida este snapshot, não o provider: a
        // observação não fecha e a próxima passada lê os termos novos.
        log.info({ betId: bet.id }, "aposta editada durante a consulta; nova observação no próximo ciclo");
        continue;
      }
      if (isFlashscoreUnavailable(error) && !isFlashscoreContractError(error)) {
        // Não entra em `falhas`: o catálogo em cache não justifica martelar stats.
        health.diasSemProvider += 1;
        log.warn({
          eventCode: providerUnavailableEventCode(error),
          err: error,
          betId: bet.id,
          provider: "flashscore",
          actionableHint:
            "Provider FlashScore indisponível no meio do ciclo; consultas restantes adiadas.",
        }, "provider indisponível na observação; ciclo aborta consultas restantes");
        return true;
      }
      result.failures += 1;
      health.falhas.push({
        betId: bet.id,
        evento: bet.evento,
        motivo: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
      });
      log.error({ err: error, betId: bet.id }, "falha ao observar resultado; lote segue");
    }
  }
  return false;
}

async function recordMatchOutcomeMetric(labels: Record<string, string | number>): Promise<void> {
  await recordOperationalMetric({ kind: "action", name: "flashscore.match", outcome: "success", labels });
}

/**
 * O id do evento da identidade da aposta, na Pinnacle17 ou na BridgeOdds (o
 * `match_id` dela é o id do evento na Pinnacle17): a chave da ligação dos
 * catálogos. Só de identidade casada ou resolvida pelo dono.
 */
function identityEventId(bet: EligibleBet): string | null {
  const sharp = bet.sharp;
  if (!sharp?.providerMatchId || !/^\d+$/.test(sharp.providerMatchId)) return null;
  if (sharp.provider !== "pinnacle17" && sharp.provider !== "bridgeodds") return null;
  return sharp.identityStatus === "MATCHED" || sharp.identityStatus === "MANUAL" ? sharp.providerMatchId : null;
}

/** Aposta de um jogo só: casa, liquida e grava a observação. */
async function observeSingleBet(params: {
  bet: EligibleBet;
  group: SportDayGroup;
  matches: FlashscoreMatch[];
  loadMatches: LoadFlashscoreMatches;
  now: Date;
  result: FlashscoreObservationRun;
  caches: DayCaches;
}): Promise<void> {
  const { bet, group, now, result } = params;
  const teams = splitEventoTeams(bet.evento);
  if (!teams) {
    result.unmatched += 1;
    await persistFlashscoreObservation({
      bet,
      checkedAt: now,
      final: false,
      snapshot: { outcome: "invalid_event" },
    });
    return;
  }
  const fixture = await matchFlashscoreFixture({
    teams,
    bet,
    matches: params.matches,
    sportId: group.sportId,
    day: group.day,
    loadMatches: params.loadMatches,
    knownMatchId: bet.result?.resultMatchId,
    catalogLinkEventId: identityEventId(bet),
  });
  if (fixture.kind === "not_found") {
    result.unmatched += 1;
    // O jogo vinculado ficou a mais de 3 h do horário da aposta (o horário
    // velho da Bridge, ou outro jogo): soltá-lo tira a aposta da insistência de
    // 10 min, que é só de quem está casado. Nos outros motivos (catálogo vazio,
    // dia vizinho que falhou) o vínculo fica, e a próxima olhada o confirma.
    const staleLink = fixture.reason === "kickoff_mismatch" ? bet.result?.resultMatchId ?? undefined : undefined;
    const { expectedTeamIds } = fixture.search;
    await persistFlashscoreObservation({
      bet,
      checkedAt: now,
      ...(staleLink ? { releaseMatchId: staleLink } : {}),
      final: false,
      snapshot: {
        outcome: fixture.reason,
        identityResolution: {
          strategy: "not_matched",
          home: fixture.search.resolved.homeResolution.strategy,
          away: fixture.search.resolved.awayResolution.strategy,
          // Com os ids dos dois times a busca não cai para o nome: o jogo que
          // falta fica para o dono, e o casamento do dia conta esses casos.
          providerIds: Number(Boolean(expectedTeamIds.home)) + Number(Boolean(expectedTeamIds.away)),
        },
      },
    });
    await recordMatchOutcomeMetric({ result: fixture.reason });
    return;
  }
  const { candidate } = fixture;
  const match = candidate.match;

  result.matched += 1;
  const anterior = observacaoAnterior(bet.result);
  const settlement = await processFlashscoreMatchOutcome({
    bet,
    candidate,
    sportId: group.sportId,
    anterior,
    ...params.caches,
    now,
  });
  if (settlement.final) result.final += 1;
  if (settlement.settled) result.settled += 1;
  if (settlement.refunded) result.refunded += 1;
  if (settlement.unsupported) result.unsupported += 1;

  // Persiste como final somente DEPOIS da liquidação: se ela falhar, a aposta
  // continua elegível ao retry.
  await persistFlashscoreObservation({
    bet,
    checkedAt: now,
    matchId: match.match_id,
    confidence: candidate.score / 2,
    final: settlement.observationFinal,
    snapshot: {
      ...buildFlashscoreMatchedSnapshot({
        bet,
        match,
        candidate,
        identitySearch: fixture.search,
        source: fixture.source,
        settlement,
        anterior,
        now,
      }),
      sportId: group.sportId,
    },
  });

  await recordMatchOutcomeMetric({
    result: settlement.final ? "matched_final" : "matched_live",
    confidence: Number(candidate.score.toFixed(3)),
    strategy: candidate.strategy,
  });
}

async function groupFlashscoreEligibleBets(
  bets: EligibleBet[],
  now: Date,
  result: FlashscoreObservationRun,
): Promise<Map<string, SportDayGroup>> {
  const groups = new Map<string, SportDayGroup>();
  for (const bet of bets) {
    const sportId = flashscoreSportId(bet.esporte);
    if (sportId === null || !flashscoreSettlesSportId(sportId)) {
      result.unsupported += 1;
      await persistFlashscoreObservation({
        bet,
        checkedAt: now,
        final: true,
        snapshot: {
          outcome: sportId === null ? "unsupported_sport" : "sport_without_terminal_status",
          sport: bet.esporte,
          ...(sportId === null ? {} : { sportId }),
        },
      });
      continue;
    }
    const day = spDayKey(bet.data);
    const key = `${sportId}:${day}`;
    const group = groups.get(key) ?? { sportId, day, bets: [] };
    group.bets.push(bet);
    groups.set(key, group);
  }
  return groups;
}

/** Um catálogo por esporte×dia por ciclo, compartilhado entre grupos e dias vizinhos. */
function createFlashscoreMatchLoader(): LoadFlashscoreMatches {
  const matchLists = new Map<string, Promise<FlashscoreMatch[] | null>>();
  return (sportId, day) => {
    const key = `${sportId}:${day}`;
    const cached = matchLists.get(key);
    if (cached) return cached;
    const pending = getFlashscoreCatalog(day, sportId, { fetch: listFlashscoreMatchesByDate });
    matchLists.set(key, pending);
    return pending;
  };
}

function providerUnavailableEventCode(error: unknown): string {
  if (error instanceof BudgetExhaustedError) return LOG_EVENTS.PROVIDER_BUDGET_EXHAUSTED;
  if (error instanceof ProviderRequestError) return LOG_EVENTS.HTTP_REQUEST_FAILED;
  return LOG_EVENTS.PROVIDER_CIRCUIT_BLOCKED;
}

async function loadFlashscoreSportDay(
  loadMatches: LoadFlashscoreMatches,
  sportId: number,
  day: string,
): Promise<
  | { kind: "ok"; matches: FlashscoreMatch[] }
  | { kind: "provider" }
  | { kind: "internal" }
> {
  try {
    const matches = await loadMatches(sportId, day);
    if (!matches) {
      log.warn({
        eventCode: LOG_EVENTS.PROVIDER_RESPONSE_INVALID,
        provider: "flashscore",
        day,
        sportId,
        actionableHint: "Catálogo FlashScore retornou vazio para a data e esporte.",
      }, "catálogo FlashScore indisponível para o dia");
      return { kind: "provider" };
    }
    return { kind: "ok", matches };
  } catch (error) {
    // Contrato quebrado num esporte×dia é erro deste grupo: os outros seguem.
    if (isFlashscoreRequestRefused(error) && !isFlashscoreContractError(error)) {
      log.warn({
        eventCode: error instanceof CircuitOpenError
          ? LOG_EVENTS.PROVIDER_CIRCUIT_BLOCKED
          : providerUnavailableEventCode(error),
        err: error,
        provider: "flashscore",
        day,
        sportId,
        actionableHint: "Provedor Flashscore temporariamente indisponível. O próximo ciclo de agendamento tentará novamente.",
      }, "provider indisponível para o dia; próximo ciclo tenta");
      return { kind: "provider" };
    }
    log.error({
      eventCode: LOG_EVENTS.PROVIDER_RESPONSE_INVALID,
      err: error,
      provider: "flashscore",
      day,
      sportId,
      actionableHint: "Falha inesperada ao consultar resultados do dia no Flashscore. Verifique a conectividade de rede e contrato da API.",
    }, "falha ao consultar resultados do dia");
    return { kind: "internal" };
  }
}

async function finishFlashscoreObservation(params: {
  result: FlashscoreObservationRun;
  health: CycleHealth;
  grupos: number;
}): Promise<void> {
  const { falhas, diasSemProvider, diasComErroNosso } = params.health;
  log.info(params.result, "observação FlashScore concluída");
  if (falhas.length > 0) {
    const amostra = falhas.slice(0, 5).map((f) => `• ${f.evento}: ${f.motivo}`).join("\n");
    const resto = falhas.length > 5 ? `\n… e mais ${falhas.length - 5}` : "";
    await sendOperationalAlert(
      `⚠️ FlashScore: ${falhas.length} aposta(s) não foram conferidas\nAs demais seguiram normalmente.\n${amostra}${resto}\n`
        + "👉 Nada a fazer agora: o próximo ciclo tenta de novo. Se a mesma aposta voltar aqui, liquide à mão em Operações.",
      {
        source: "settlement.flashscore",
        key: "batch-failure",
        title: "Falhas na observação FlashScore",
        resource: "flashscore",
        evidence: { failed: falhas.length, betIds: falhas.slice(0, 20).map((f) => f.betId) },
        autoResolve: false,
      },
    );
  }
  if (diasComErroNosso === params.grupos && params.grupos >= 2) {
    throw new Error(
      `Observação FlashScore quebrou em todos os ${params.grupos} grupos consultados — ` +
        "erro nosso, não indisponibilidade do provider; ver o log por dia/esporte.",
    );
  }
  if (diasSemProvider > 0 || diasComErroNosso > 0) {
    log.warn(
      { diasSemProvider, diasComErroNosso, grupos: params.grupos },
      "catálogo indisponível neste ciclo; próximo ciclo tenta de novo",
    );
  }
}
