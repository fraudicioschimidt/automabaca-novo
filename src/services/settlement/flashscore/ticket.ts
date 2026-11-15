import type { BetLegsTicket } from "@/src/domain/bet-legs";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";
import {
  ticketFixtureEventos,
  ticketForScore,
  type EligibleBet,
  type FixtureScore,
} from "@/src/domain/settlement/ticket-resolution";
import {
  chavePlacar,
  decidirTerminal,
  interruptedFinishOf,
  type ObservacaoAnterior,
} from "@/src/providers/flashscore/terminal";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { matchFlashscoreFixture, type LoadFlashscoreMatches } from "./match-identity";
import { reportIaCrossCheck, ticketCrossCheckVerdict, type CrossCheckResult } from "./ia-crosscheck";
import {
  persistFlashscoreObservation,
  placarEstavelDesde,
  previousTicketReadings,
} from "./observation-store";
import {
  betsOnRegulationResult,
  decidedInExtraTime,
  loadFlashscoreRegulationScore,
  ticketFixtureExtraTimeNeed,
} from "./regulation";
import { settleFromFlashscoreScore } from "./score-settle";
import {
  listedFlashscoreScore,
  marcarInferido,
  orientFlashscorePair,
  POSTPONED_VOID_GRACE_MS,
  refundFlashscorePostponedOrCancelled,
  STATS_GRACE_MS,
  type SummaryCache,
} from "./settle";

/**
 * Dupla/tripla: cada perna é casada no próprio confronto. O evento amassado
 * "A vs B | C vs D" nunca é partido ao meio — o away viraria "B | C vs D".
 */

/** Uma olhada por confronto: o match_id vale mesmo com o jogo ainda rolando. */
export type TicketFixtureLook = {
  matchId?: string;
  state: "score" | "cancelled" | "postponed_waiting" | "unresolved";
  /** Distingue falha terminal sem placar de confronto ainda não concluído. */
  terminal: boolean;
  score?: { home: number; away: number };
  /**
   * Placar lido e desde quando está parado: a leitura anterior da próxima
   * olhada. `inferido` marca o confronto cujo fim foi deduzido, o que a
   * rechecagem confere; o jogo que ainda rolava quando outra perna decidiu, não.
   */
  reading?: TicketFixtureReading;
};

/**
 * Chaves como gravadas no snapshot do bilhete (`placares[matchId]`), por isso
 * em português: `inferido` é o mesmo `inferred` da olhada, já gravado.
 */
type TicketFixtureReading = { placar: string; placarDesde: string; inferido?: true };

/** Cancelado é terminal já; adiado só vira VOID depois da graça de 48 horas. */
export function ticketExceptionalLook(params: {
  cancelled: boolean;
  postponed: boolean;
  kickoff: Date;
  now: Date;
}): Pick<TicketFixtureLook, "state" | "terminal"> | null {
  if (params.cancelled) return { state: "cancelled", terminal: true };
  if (!params.postponed) return null;
  const graceElapsed =
    params.now.getTime() - params.kickoff.getTime() >= POSTPONED_VOID_GRACE_MS;
  return graceElapsed
    ? { state: "cancelled", terminal: true }
    : { state: "postponed_waiting", terminal: false };
}

/**
 * Mercado E seleção das pernas daquele confronto — a promessa que o placar deve
 * pagar. A frase "incluindo prorrogação" também chega pela seleção.
 */
export function fixtureMercados(ticket: BetLegsTicket | null, evento: string): string[] {
  return fixtureLegs(ticket, evento).map((leg) => `${leg.mercado} ${leg.selecao}`);
}

function fixtureLegs(ticket: BetLegsTicket | null, evento: string): BetLegsTicket["legs"] {
  if (!ticket) return [];
  const alvo = normalizeStr(evento);
  return ticket.legs.filter((leg) => normalizeStr(leg.evento) === alvo);
}

/**
 * Decide o que gravar depois de olhar cada confronto da dupla.
 * Sem match_id a lista usa o ritmo de 6h; com ele, o retry de 10min.
 */
export function ticketObservationPersist(looks: readonly TicketFixtureLook[]): {
  matchId?: string;
  final: boolean;
  snapshot: {
    outcome: "matched" | "no_candidate";
    ticket: true;
    unfinished: boolean;
    fixtures: number;
    scored: number;
    cancelled: number;
    postponedWaiting: number;
    /** Confrontos casados que o FlashScore ainda não deu como encerrados. */
    live: number;
    /** Nos esportes inferidos, a estabilidade de cada confronto vem daqui. */
    placares?: Record<string, TicketFixtureReading>;
  };
} {
  const matchId = looks.find((look) => look.matchId)?.matchId;
  const scored = looks.filter((look) => look.state === "score").length;
  const cancelled = looks.filter((look) => look.state === "cancelled").length;
  const postponedWaiting = looks.filter((look) => look.state === "postponed_waiting").length;
  const live = looks.filter((look) => look.matchId && look.state === "unresolved" && !look.terminal).length;
  const unfinished = looks.some((look) =>
    look.state === "postponed_waiting" ||
    (look.state === "unresolved" && !look.terminal)
  );
  const readingsByMatch = Object.fromEntries(looks.flatMap((look) =>
    look.matchId && look.reading ? [[look.matchId, look.reading]] : []));
  return {
    ...(matchId ? { matchId } : {}),
    final: looks.length > 0 && !unfinished,
    snapshot: {
      outcome: matchId ? "matched" : "no_candidate",
      ticket: true,
      unfinished,
      fixtures: looks.length,
      scored,
      cancelled,
      postponedWaiting,
      live,
      ...(Object.keys(readingsByMatch).length > 0 ? { placares: readingsByMatch } : {}),
    },
  };
}

export type FlashscoreTicketObservation = {
  matched: boolean;
  final: boolean;
  settled: boolean;
  unmatched: boolean;
  identityBlocked: Array<{ evento: string; reason: string }>;
};

type TicketCycle = {
  bet: EligibleBet;
  matches: FlashscoreMatch[];
  sportId: number;
  day: string;
  now: Date;
  loadMatches: LoadFlashscoreMatches;
  ticket: BetLegsTicket | null;
  summaryCache: SummaryCache;
  /** Confrontos já casados neste bilhete: dois eventos no mesmo jogo não valem. */
  seenMatchIds: Set<string>;
  /** Leitura anterior de cada confronto: confirma o fim nos esportes inferidos. */
  previousReadings: Map<string, ObservacaoAnterior>;
};

type FixtureLookResult = {
  look: TicketFixtureLook;
  score?: FixtureScore;
  identityBlocked?: string;
  extraTimeBlocked?: boolean;
  /** Abandono, W.O., resultado administrativo: o placar listado não decide a perna. */
  interrupted?: boolean;
  /** O fim deste confronto foi deduzido (esporte sem flag), não afirmado pelo feed. */
  inferred?: boolean;
};

const UNRESOLVED: TicketFixtureLook = { state: "unresolved", terminal: false };

/** Olha UM confronto do bilhete: casa, confere o fim e escolhe o placar que vale. */
async function lookAtFixture(cycle: TicketCycle, evento: string): Promise<FixtureLookResult> {
  const teams = splitEventoTeams(evento);
  if (!teams) return { look: UNRESOLVED };
  const fixture = await matchFlashscoreFixture({
    teams,
    bet: cycle.bet,
    matches: cycle.matches,
    sportId: cycle.sportId,
    day: cycle.day,
    loadMatches: cycle.loadMatches,
    // A competição do bilhete não é a de cada perna: a categoria vem só dos nomes.
    competition: "",
    ticketLeg: true,
  });
  if (fixture.kind === "not_found") return { look: UNRESOLVED };
  const { candidate } = fixture;
  const match = candidate.match;
  const matchId = match.match_id;
  // Ida e volta ("A vs B" e "B vs A") procuradas perto da data da aposta acham
  // as duas a ida. Pagar a volta pelo placar da ida é inventar resultado.
  if (cycle.seenMatchIds.has(matchId)) {
    return { look: UNRESOLVED, identityBlocked: "mesmo_jogo_de_outra_perna" };
  }
  cycle.seenMatchIds.add(matchId);
  const previous = cycle.previousReadings.get(matchId) ?? null;
  const decisao = decidirTerminal({ match, sportId: cycle.sportId, agora: cycle.now, anterior: previous });
  const listedKey = chavePlacar(match);
  const reading = listedKey === null
    ? undefined
    : { placar: listedKey, placarDesde: placarEstavelDesde(listedKey, previous, cycle.now)! };
  const terminal =
    decisao.terminal ||
    match.match_status.is_cancelled ||
    match.match_status.is_postponed;
  if (!terminal) return { look: { matchId, state: "unresolved", terminal: false, reading } };
  // O `data` do bilhete não é o de cada jogo: as esperas desta perna contam do
  // começo dela, quando ele é mais tarde.
  const kickoffMs = Math.max(cycle.bet.data.getTime(), match.timestamp * 1_000);
  const exceptional = ticketExceptionalLook({
    cancelled: match.match_status.is_cancelled,
    postponed: match.match_status.is_postponed,
    kickoff: new Date(kickoffMs),
    now: cycle.now,
  });
  if (exceptional) return { look: { matchId, ...exceptional } };
  if (interruptedFinishOf(match.match_status.stage)) {
    return { look: { matchId, state: "unresolved", terminal: true }, interrupted: true };
  }
  const score = orientFlashscorePair(listedFlashscoreScore(match), candidate.swapped);
  if (!score) return { look: { matchId, state: "unresolved", terminal: true } };
  const need = ticketFixtureExtraTimeNeed({
    status: match.match_status,
    mercados: fixtureMercados(cycle.ticket, evento),
    sportId: cycle.sportId,
    regulationOnly: fixtureLegs(cycle.ticket, evento).some(betsOnRegulationResult),
  });
  // `loadFlashscoreRegulationScore` já orienta pelo `swapped` do candidato.
  const regulation =
    need === "regulation"
      ? await loadFlashscoreRegulationScore({ candidate, cache: cycle.summaryCache })
      : null;
  if (need === "regulation" && !regulation && cycle.now.getTime() - kickoffMs < STATS_GRACE_MS) {
    // O resumo de gols sai com atraso: o confronto espera, e o bilhete volta no próximo ciclo.
    return { look: { matchId, state: "unresolved", terminal: false, reading } };
  }
  if (need !== "aggregate" && !regulation) {
    return { look: { matchId, state: "unresolved", terminal: true }, extraTimeBlocked: true };
  }
  const fixtureScore = regulation?.score ?? score;
  // O tempo regulamentar deste confronto: o reconstruído, ou o listado quando
  // o jogo terminou no tempo normal. Com prorrogação e sem reconstrução, não
  // há, e a perna de tempo regulamentar vai para o operador.
  const regulationScore = regulation?.score ?? (decidedInExtraTime(match.match_status) ? null : score);
  const inferred = decisao.terminal && decisao.via === "inferencia";
  return {
    look: {
      matchId, state: "score", terminal: true, score: fixtureScore,
      reading: inferred && reading ? { ...reading, inferido: true } : reading,
    },
    score: { evento, home: fixtureScore.home, away: fixtureScore.away, regulation: regulationScore },
    inferred,
  };
}

export async function observeFlashscoreTicketBet(params: {
  bet: EligibleBet;
  matches: FlashscoreMatch[];
  sportId: number;
  day: string;
  now: Date;
  loadMatches: LoadFlashscoreMatches;
  /** Mesmo cache do caminho simples: uma chamada de summary por partida. */
  summaryCache?: SummaryCache;
}): Promise<FlashscoreTicketObservation> {
  const cycle: TicketCycle = {
    ...params,
    ticket: ticketForScore(params.bet),
    summaryCache: params.summaryCache ?? new Map(),
    seenMatchIds: new Set(),
    previousReadings: previousTicketReadings(params.bet.result),
  };
  const looks: TicketFixtureLook[] = [];
  const scoresByEvento: FixtureScore[] = [];
  const identityBlocked: Array<{ evento: string; reason: string }> = [];
  const extraTimeBlocked: string[] = [];
  const interrupted: string[] = [];
  let inferred = false;

  for (const evento of ticketFixtureEventos(params.bet)) {
    const result = await lookAtFixture(cycle, evento);
    looks.push(result.look);
    if (result.score) scoresByEvento.push(result.score);
    if (result.identityBlocked) identityBlocked.push({ evento, reason: result.identityBlocked });
    if (result.extraTimeBlocked) extraTimeBlocked.push(evento);
    if (result.interrupted) interrupted.push(evento);
    if (result.inferred) inferred = true;
  }

  const persist = ticketObservationPersist(looks);
  let settled = false;
  let crossCheck: CrossCheckResult | null = null;
  if (params.bet.status === "PENDING") {
    settled = await settleTicket(params.bet, {
      looks, scoresByEvento, extraTimeBlocked, interrupted, final: persist.final,
    });
  } else {
    // Múltipla que a IA liquidou: só confere. Passar pela liquidação religaria
    // a conta e moveria dinheiro de uma aposta já decidida.
    crossCheck = await reportIaCrossCheck(params.bet, ticketCrossCheckVerdict(params.bet, {
      final: persist.final,
      allCancelled: looks.length > 0 && looks.every((look) => look.state === "cancelled"),
      partiallyCancelled: looks.some((look) => look.state === "cancelled") && looks.some((look) => look.state !== "cancelled"),
      scoresByEvento,
      extraTimeBlocked,
      interrupted,
    }), params.now);
  }

  await persistFlashscoreObservation({
    bet: params.bet,
    checkedAt: params.now,
    ...persist,
    final: persist.final && crossCheck?.observationFinal !== false,
    // O IA-Judge lê estas contagens: bilhete com perna na prorrogação,
    // interrompida ou ainda sem fim não pode ser liquidado por ele sem
    // homologação. O esporte diz se "sem fim" é afirmação do FlashScore.
    snapshot: {
      ...persist.snapshot,
      sportId: params.sportId,
      extraTimeBlocked: extraTimeBlocked.length,
      interrupted: interrupted.length,
      // Liquidada por dedução: a rechecagem e o resumo diário leem esta marca.
      ...(settled && inferred ? { settlementOutcome: marcarInferido("settled_from_score", true) } : {}),
      ...(crossCheck ? { settlementOutcome: crossCheck.settlementOutcome } : {}),
    },
  });

  return {
    matched: persist.snapshot.outcome === "matched",
    final: persist.final,
    settled,
    unmatched: persist.snapshot.outcome === "no_candidate",
    identityBlocked,
  };
}

/** Com as olhadas em mãos: reembolsa, liquida pelo placar de cada perna ou pede a mão. */
async function settleTicket(
  bet: EligibleBet,
  params: {
    looks: readonly TicketFixtureLook[];
    scoresByEvento: readonly FixtureScore[];
    extraTimeBlocked: readonly string[];
    interrupted: readonly string[];
    final: boolean;
  },
): Promise<boolean> {
  const { looks, scoresByEvento, extraTimeBlocked, interrupted } = params;
  const blockedWithOwnAlert = extraTimeBlocked.length + interrupted.length;
  let settled = false;
  const allCancelled = looks.length > 0 && looks.every((look) => look.state === "cancelled");
  if (params.final && allCancelled) {
    settled = await refundFlashscorePostponedOrCancelled(bet);
  } else if (looks.some((look) => look.state === "cancelled")) {
    // Como VOID numa perna asiática, cancelamento parcial exige conferir a
    // odd efetiva e a regra do bilhete, mesmo quando outra perna perdeu.
    if (params.final) {
      await sendOperationalAlert(
        `✋ Liquidar à mão · ${bet.evento}\n${bet.selecao}\n` +
          "Há perna anulada nesta múltipla. Confira a regra e a odd paga pela casa antes de liquidar em Operações.",
        { source: "settlement.ticket-incomplete", key: bet.id, title: `Liquidação manual necessária: ${bet.evento}`,
          resource: "bet", resourceId: bet.id, autoResolve: false },
      );
    }
  } else if (scoresByEvento.length > 0) {
    const first = scoresByEvento[0]!;
    settled = await settleFromFlashscoreScore(
      bet,
      { homeScore: first.home, awayScore: first.away },
      {
        scoresByEvento,
        // Com todas as pernas terminais, a múltipla que o motor não dobra não
        // pode sumir da fila sem ação. Confronto travado na prorrogação tem o
        // alerta próprio abaixo, que nomeia o jogo e a causa.
        alertIncompleteLegs: params.final && blockedWithOwnAlert === 0,
      },
    );
  } else if (params.final && bet.status === "PENDING" && blockedWithOwnAlert === 0) {
    await sendOperationalAlert(
      `✋ Liquidar à mão · ${bet.evento}\n` +
        `${bet.selecao}\n` +
        "Todos os jogos da múltipla acabaram, mas faltam placares para decidir.\n👉 Liquide em Operações.",
      {
        source: "settlement.ticket-incomplete",
        key: bet.id,
        title: `Liquidação manual necessária: ${bet.evento}`,
        resource: "bet",
        resourceId: bet.id,
        autoResolve: false,
      },
    );
  }

  if (!settled && extraTimeBlocked.length > 0 && bet.status === "PENDING") {
    await sendOperationalAlert(
      `✋ Liquidar à mão · ${bet.evento}\n` +
        `${bet.selecao}\n` +
        `${extraTimeBlocked.join(", ")} foi para a prorrogação ou pênaltis, e não consegui decidir sozinho qual placar vale para cada perna.\n` +
        "👉 Confira na casa se cada mercado conta prorrogação e pênaltis e liquide em Operações.",
      {
        source: "settlement.ticket-extra-time",
        key: bet.id,
        title: `Liquidação manual (prorrogação): ${bet.evento}`,
        resource: "bet",
        resourceId: bet.id,
        autoResolve: false,
      },
    );
  }
  if (!settled && interrupted.length > 0 && bet.status === "PENDING") {
    await sendOperationalAlert(
      `✋ Liquidar à mão · ${bet.evento}\n` +
        `${bet.selecao}\n` +
        `${interrupted.join(", ")} não foi jogado até o fim (abandono, W.O. ou resultado decidido fora de campo), ` +
        "e o placar listado não decide a perna.\n" +
        "👉 Confira a regra da casa para cada perna e liquide em Operações.",
      {
        source: "settlement.ticket-interrupted",
        key: bet.id,
        title: `Liquidação manual (jogo não concluído): ${bet.evento}`,
        resource: "bet",
        resourceId: bet.id,
        autoResolve: false,
      },
    );
  }
  return settled;
}
