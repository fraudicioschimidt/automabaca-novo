import type { BetStatus } from "@/src/domain/bet-status";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import {
  foldLegStatuses,
  isMultiFixtureTicket,
  parseBetLegs,
  parseStoredLegs,
  type BetLeg,
  type BetLegsTicket,
} from "@/src/domain/bet-legs";
import {
  ehMercadoArtilheiro,
  ehMercadoArtilheiroPorTempo,
  resolveGoalscorer,
  type JogadorDaPartida,
  type OrderedGoal,
} from "./goalscorer";
import { resolvePeriodGoalscorer } from "./goalscorer-period";
import { resolvePlayerProp } from "./player-props";
import { classificarPropDeJogador } from "./player-prop-classify";
import { resolveResultFromScore, type ScorePeriod, type ScoreResolution } from "./score-resolution";
import { declaredScorePeriod, hasNonFullTimeScorePeriod } from "./markets";
import { isRegulationTimeMarket } from "@/src/domain/mercados/compatibility";
import { expandAbbreviatedDirection } from "@/src/domain/mercados/total-direction";
import { lineSubjectIsNotEventTeam } from "./over-under-subject";
import { matchTeamSide } from "./sides";
import { mentionsLiveEntry } from "@/src/domain/live-score-at-tip";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";

/**
 * Aposta como os ciclos de fechamento e de resultado a leem: termos, placar ao
 * vivo da tip e a última observação gravada.
 */
export type EligibleBet = {
  manualSettlementVersion?: number;
  casaDeAposta?: string;
  playerPropRevision?: number;
  playerProp?: { revision: number } | null;
  id: string;
  evento: string;
  esporte: string;
  competicao: string;
  pais: string;
  mercado: string;
  selecao: string;
  legsJson?: unknown;
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
  odds: unknown;
  stake: unknown;
  status: string;
  data: Date;
  /** Necessário para `entrouAoVivo`: entrada pós-kickoff não tem CLV. */
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  kickoffInferido?: boolean;
  /** A legenda dizia ao vivo; gravado na captura porque a legenda expira. */
  liveTextAtCapture: boolean;
  sharp: {
    provider: string | null;
    providerMatchId: string | null;
    /** Só a observação do FlashScore lê: a ligação dos catálogos vale para identidade casada. */
    identityStatus?: string | null;
    priceReference?: string | null;
  } | null;
  closing: {
    fetchedAt: Date | null;
    clv: unknown;
    closingOdd: unknown;
    lateRefreshedAt?: Date | null;
  } | null;
  /**
   * O resultado externo (`bet_result`), sempre lido pela liquidação: nele moram
   * o placar já ingerido, a recusa de prorrogação já decidida e a leitura
   * ANTERIOR do FlashScore, que nos 22 esportes sem flag terminal separa
   * "acabou" de "placar parcial". Null quando ainda não há resultado.
   */
  result: {
    scoreHome: number | null;
    resultSnapshot?: unknown;
    resultCheckedAt?: Date | null;
    resultProvider?: string | null;
    resultMatchId?: string | null;
    resultFinal?: boolean | null;
  } | null;
};

/** O mercado é obrigatório: dele vem o período das pernas lidas do texto. */
export function ticketForScore(
  bet: Pick<EligibleBet, "evento" | "mercado" | "selecao" | "legsJson">,
): BetLegsTicket | null {
  return parseStoredLegs(bet.legsJson) ?? parseBetLegs(bet.evento, bet.selecao, bet.mercado);
}

/** Confrontos únicos de uma dupla/tripla. Vazio = ticket de um jogo só. */
export function ticketFixtureEventos(
  bet: Pick<EligibleBet, "evento" | "mercado" | "selecao" | "legsJson">,
): string[] {
  const ticket = ticketForScore(bet);
  if (!ticket || !isMultiFixtureTicket(ticket)) return [];
  const seen = new Set<string>();
  const eventos: string[] = [];
  for (const leg of ticket.legs) {
    const key = normalizeStr(leg.evento);
    if (seen.has(key)) continue;
    seen.add(key);
    eventos.push(leg.evento);
  }
  return eventos;
}

function sameOrderedFixture(left: string, right: string): boolean {
  const a = splitEventoTeams(left);
  const b = splitEventoTeams(right);
  if (!a || !b) return normalizeStr(left) === normalizeStr(right);
  return normalizeStr(a.home) === normalizeStr(b.home) && normalizeStr(a.away) === normalizeStr(b.away);
}

function sameFixture(left: string, right: string): boolean {
  const b = splitEventoTeams(right);
  return sameOrderedFixture(left, right) || (b !== null && sameOrderedFixture(left, `${b.away} vs ${b.home}`));
}

/** Placares por tempo do MESMO jogo, quando o fornecedor os declara. */
export type PeriodScores = {
  ht: { home: number; away: number };
  sh: { home: number; away: number };
};

/**
 * O placar que responde por ESTA perna.
 *
 * Criar-aposta mistura períodos no mesmo bilhete — "Mais de 0.5 no 1º tempo" +
 * "Mais de 0.5 no 2º tempo" + "Mais de 1.5 no jogo" é uma aposta só, medida por
 * três placares diferentes. Sem os parciais, só a perna de tempo integral
 * resolve e o bilhete inteiro cai para manual.
 */
function scoreForPeriod(
  termos: { mercado: string; selecao: string; esporte?: string },
  params: {
    homeScore: number;
    awayScore: number;
    periodScores?: PeriodScores | null;
    regulationScore?: { home: number; away: number } | null;
  },
): { score: { home: number; away: number }; period: ScorePeriod } | null {
  // Mercado do tempo regulamentar só se decide com o placar sem a prorrogação,
  // que quem chama declara; o placar do jogo inteiro nunca o substitui.
  if (isRegulationTimeMarket(termos.mercado)) {
    return params.regulationScore ? { score: params.regulationScore, period: "REGULATION" } : null;
  }
  const periodo = declaredScorePeriod(termos);
  if (periodo === "FT") return { score: { home: params.homeScore, away: params.awayScore }, period: "FT" };
  if (!params.periodScores) return null;
  if (periodo === "HT") return { score: params.periodScores.ht, period: "HT" };
  if (periodo === "SECOND_HALF") return { score: params.periodScores.sh, period: "SECOND_HALF" };
  return null;
}

function resolveOneLeg(
  leg: BetLeg,
  bet: EligibleBet,
  params: {
    homeScore: number; awayScore: number; odds: number; stake: number;
    periodScores?: PeriodScores | null;
    regulationScore?: { home: number; away: number } | null;
    players?: readonly JogadorDaPartida[] | null;
    goals?: readonly OrderedGoal[] | null;
  },
): ScoreResolution {
  // Perna de artilheiro não sai do placar: sai da lista de jogadores da partida.
  // O resolvedor é o MESMO da aposta simples — recusa homônimo, nome ausente,
  // gol contra e linha negativa —, então a perna nunca vira chute.
  if (ehMercadoArtilheiro(leg.mercado, leg.selecao) || ehMercadoArtilheiroPorTempo(leg.mercado, leg.selecao)) {
    if (!params.players) return { ok: false, reason: "stat_qualifier" };
    const periodo = declaredScorePeriod({ mercado: leg.mercado, selecao: leg.selecao, esporte: bet.esporte });
    // Gol de 1º/2º tempo: a estatística do jogador é só do jogo inteiro, então
    // quem responde é o minuto de cada gol, do resumo da partida.
    const artilheiro = periodo === "HT" || periodo === "SECOND_HALF"
      ? (params.goals
        ? resolvePeriodGoalscorer({ selecao: leg.selecao, mercado: leg.mercado, jogadores: params.players, gols: params.goals, periodo })
        : { ok: false as const, reason: "sem_gols" })
      : resolveGoalscorer({ selecao: leg.selecao, mercado: leg.mercado, jogadores: params.players });
    if (!artilheiro.ok) return { ok: false, reason: "stat_qualifier" };
    return settledAs(artilheiro.status, params);
  }
  // Demais props de jogador (finalizações, desarmes, cartões por cor) usam o
  // mesmo resolvedor da aposta simples. Ele recusa "cartões" sem cor de
  // propósito: a regra de vermelho e segundo amarelo varia por casa.
  if (classificarPropDeJogador({ mercado: leg.mercado, selecao: leg.selecao, esporte: bet.esporte, evento: leg.evento })) {
    if (!params.players) return { ok: false, reason: "stat_qualifier" };
    const prop = resolvePlayerProp({
      mercado: leg.mercado, selecao: leg.selecao, evento: leg.evento,
      esporte: bet.esporte, jogadores: params.players,
    });
    if (!prop.ok) return { ok: false, reason: "stat_qualifier" };
    return settledAs(prop.status, params);
  }
  // A guarda vê o texto original: normalizar "Tatum over 25.5" para "Over 25.5"
  // apagaria o sujeito e o placar liquidaria a prop de jogador.
  if (lineSubjectIsNotEventTeam(leg.selecao, leg.evento)) {
    return { ok: false, reason: "unsupported_market" };
  }
  // Só a sigla da direção se expande: o período ("Over 0.5 1T") decide o
  // placar da perna, e o time ("Mogi O89,5") separa o total do time do total
  // do jogo. Sem os dois, a perna seria paga pelo placar final somado.
  const selecao = expandAbbreviatedDirection(leg.selecao);
  return resolveTermFromScore({ mercado: leg.mercado, selecao, evento: leg.evento }, bet, params);
}

/** O termo (a aposta ou uma perna) pelo placar do período que ele declara. */
function resolveTermFromScore(
  termo: { mercado: string; selecao: string; evento: string },
  bet: EligibleBet,
  params: Parameters<typeof scoreForPeriod>[1] & { odds: number; stake: number },
): ScoreResolution {
  const doPeriodo = scoreForPeriod({ mercado: termo.mercado, selecao: termo.selecao, esporte: bet.esporte }, params);
  if (!doPeriodo) return { ok: false, reason: "wrong_period" };
  return resolveResultFromScore({
    ...termo,
    esporte: bet.esporte,
    homeScore: doPeriodo.score.home,
    awayScore: doPeriodo.score.away,
    scorePeriod: doPeriodo.period,
    liveScoreHome: bet.liveScoreHome,
    liveScoreAway: bet.liveScoreAway,
    liveTextAtCapture: bet.liveTextAtCapture,
    odds: params.odds,
    stake: params.stake,
  });
}


/** Resultado da perna quando ele não depende da ordem dos times; senão, recusa. */
function orderIndependentLegResult(one: ScoreResolution, other: ScoreResolution): ScoreResolution {
  const same = one.ok && other.ok
    ? one.status === other.status
    : !one.ok && !other.ok && one.reason === other.reason;
  return same ? one : { ok: false, reason: "ambiguous_selection" };
}

function settledAs(status: BetStatus, params: { stake: number; odds: number }): ScoreResolution {
  return { ok: true, status, lucro: computeLucroFromStatus({ status, stake: params.stake, odds: params.odds }) };
}

const PARLAY_FRACTIONAL_OR_VOID = new Set<BetStatus>([
  "VOID",
  "HALF_WON",
  "HALF_LOST",
]);

/** Perna VOID/meio-ganho/meio-perda em múltipla exige ajuste manual da odd paga. */
function hasParlayFractionalOrVoid(statuses: readonly (BetStatus | null)[]): boolean {
  return statuses.some((status) => status !== null && PARLAY_FRACTIONAL_OR_VOID.has(status));
}

export type FixtureScore = {
  evento: string;
  home: number;
  away: number;
  /**
   * Placar do tempo regulamentar DESTE confronto, quando quem olhou o jogo o
   * conhece (terminou no tempo normal, ou os 90' foram reconstruídos).
   */
  regulation?: { home: number; away: number } | null;
};

function scoreForLeg(
  leg: BetLeg,
  bet: EligibleBet,
  params: {
    homeScore: number;
    awayScore: number;
    scoresByEvento?: readonly FixtureScore[];
  },
): { home: number; away: number; regulation?: { home: number; away: number } | null } | null {
  if (params.scoresByEvento && params.scoresByEvento.length > 0) {
    // Placar gravado com o evento da própria perna: só a mesma ordem vale. A
    // ordem inversa pagaria a volta pelo placar da ida.
    const hit = params.scoresByEvento.find((score) => sameOrderedFixture(score.evento, leg.evento));
    return hit ? { home: hit.home, away: hit.away, regulation: hit.regulation ?? null } : null;
  }
  if (sameFixture(leg.evento, bet.evento)) {
    return { home: params.homeScore, away: params.awayScore };
  }
  return null;
}

export function resolveTicketFromScore(
  bet: EligibleBet,
  params: {
    homeScore: number;
    awayScore: number;
    odds: number;
    stake: number;
    scoresByEvento?: readonly FixtureScore[];
    /** Parciais do MESMO jogo; sem eles, só perna de tempo integral resolve. */
    periodScores?: PeriodScores | null;
    /**
     * Placar do tempo regulamentar do MESMO jogo, quando quem chama sabe que
     * ele não teve prorrogação (ou o reconstruiu); sem ele, mercado do tempo
     * regulamentar cai para manual.
     */
    regulationScore?: { home: number; away: number } | null;
    /** Jogadores da partida; sem eles, perna de artilheiro cai para manual. */
    players?: readonly JogadorDaPartida[] | null;
    /** Gols com minuto, do resumo; sem eles, perna de gol por tempo cai para manual. */
    goals?: readonly OrderedGoal[] | null;
  },
): ScoreResolution {
  const ticket = ticketForScore(bet);
  // O rótulo do bilhete inteiro declarando outro período (e não as pernas) só
  // faz sentido quando temos o placar daquele período para responder.
  // O tempo regulamentar não é outra fase: cada perna o responde com o placar
  // regulamentar do confronto dela.
  if (
    ticket &&
    !params.periodScores &&
    !isRegulationTimeMarket(bet.mercado) &&
    hasNonFullTimeScorePeriod({
      mercado: bet.mercado,
      selecao: bet.selecao,
      esporte: bet.esporte,
    })
  ) {
    return { ok: false, reason: "wrong_period" };
  }
  if (ticket && isMultiFixtureTicket(ticket)) {
    // O par live da Bet não diz a qual jogo pertence. Não pode ser subtraído
    // de todos os confrontos; o contrato de pernas não guarda placar por jogo.
    if (bet.liveScoreHome != null || bet.liveScoreAway != null || bet.liveTextAtCapture
      || [bet.mercado, bet.selecao, ...ticket.legs.flatMap((leg) => [leg.mercado, leg.selecao])].some(mentionsLiveEntry)) {
      return { ok: false, reason: "unsupported_live_score" };
    }
    const statuses: Array<BetStatus | null> = ticket.legs.map((leg) => {
      const score = scoreForLeg(leg, bet, params);
      if (!score) return null;
      const legResult = resolveOneLeg(leg, bet, {
        homeScore: score.home,
        awayScore: score.away,
        odds: params.odds,
        stake: params.stake,
        // Parciais valem para o jogo de onde vieram; numa múltipla de jogos
        // diferentes, só a perna daquele confronto pode usá-los.
        periodScores: sameFixture(leg.evento, bet.evento) ? params.periodScores : null,
        // O regulamentar de cada confronto vem da olhada dele; o do jogo da
        // aposta, de quem chamou.
        regulationScore: score.regulation ?? (sameFixture(leg.evento, bet.evento) ? params.regulationScore : null),
        players: sameFixture(leg.evento, bet.evento) ? params.players : null,
        goals: sameFixture(leg.evento, bet.evento) ? params.goals : null,
      });
      return legResult.ok ? legResult.status : null;
    });
    if (hasParlayFractionalOrVoid(statuses)) {
      return { ok: false, reason: "parlay_fractional_or_void_requires_manual" };
    }
    if (statuses.some((status) => status === "LOST")) return settledAs("LOST", params);
    if (statuses.length > 0 && statuses.every((status) => status === "WON")) {
      return settledAs("WON", params);
    }
    return { ok: false, reason: "incomplete_legs" };
  }
  if (ticket?.kind === "same_game") {
    const statuses: BetStatus[] = [];
    let primeiraFalha: ScoreResolution | null = null;
    for (const leg of ticket.legs) {
      // A identidade pode pôr o evento na ordem do provider sem reescrever
      // as pernas capturadas. Todos os placares devem seguir a ordem da perna.
      const legTeams = splitEventoTeams(leg.evento);
      const homeSide = legTeams ? matchTeamSide(legTeams.home, bet.evento) : null;
      const awaySide = legTeams ? matchTeamSide(legTeams.away, bet.evento) : null;
      const direct = sameOrderedFixture(leg.evento, bet.evento) || (homeSide === "home" && awaySide === "away");
      const reversed = !direct && homeSide === "away" && awaySide === "home";
      const inLegOrder = () => resolveOneLeg(leg, bet, params);
      const inOppositeOrder = () => resolveOneLeg(leg, {
        ...bet, liveScoreHome: bet.liveScoreAway, liveScoreAway: bet.liveScoreHome,
      }, {
        ...params, homeScore: params.awayScore, awayScore: params.homeScore,
        periodScores: params.periodScores ? {
          ht: { home: params.periodScores.ht.away, away: params.periodScores.ht.home },
          sh: { home: params.periodScores.sh.away, away: params.periodScores.sh.home },
        } : null,
        regulationScore: params.regulationScore
          ? { home: params.regulationScore.away, away: params.regulationScore.home }
          : null,
      });
      // Sem prova de quem é o mandante (apelido do tipster contra o nome do
      // provider), a perna só vale se as duas ordens dão a mesma resposta:
      // total do jogo, ambas marcam, perna de jogador. A que depende do mando
      // fica para o dono.
      const legResult = direct
        ? inLegOrder()
        : reversed
          ? inOppositeOrder()
          : orderIndependentLegResult(inLegOrder(), inOppositeOrder());
      // Continua mesmo após LOST: VOID/HALF_* em qualquer perna exige revisão.
      // Uma perna irresolvível, sozinha, não impede outra perdida de decidir.
      if (!legResult.ok) {
        primeiraFalha ??= legResult;
        continue;
      }
      statuses.push(legResult.status);
    }
    if (hasParlayFractionalOrVoid(statuses)) {
      return { ok: false, reason: "parlay_fractional_or_void_requires_manual" };
    }
    if (statuses.includes("LOST")) return settledAs("LOST", params);
    if (primeiraFalha) return primeiraFalha;
    const folded = foldLegStatuses(statuses);
    if (!folded.ok) {
      return { ok: false, reason: "ambiguous_selection" };
    }
    return settledAs(folded.status, params);
  }
  return resolveTermFromScore({ mercado: bet.mercado, selecao: bet.selecao, evento: bet.evento }, bet, params);
}
