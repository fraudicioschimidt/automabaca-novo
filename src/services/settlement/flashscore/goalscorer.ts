import {
  ehMercadoArtilheiroPorTempo,
  hasUnsupportedGoalQualifier,
  resolveGoalscorer,
  resolveOrderedGoalscorer,
  type OrderedGoalscorerOrder,
  type OrderedGoalscorerRefusal,
} from "@/src/domain/settlement/goalscorer";
import { type GoalscorerRefusal, type JogadorDaPartida } from "@/src/domain/settlement/goalscorer-matching";
import { resolvePeriodGoalscorer } from "@/src/domain/settlement/goalscorer-period";
import { declaredScorePeriod } from "@/src/domain/settlement/markets";
import { createLogger } from "@/src/infra/logger";
import {
  getFlashscoreMatchPlayerStats,
  getFlashscoreMatchSummary,
} from "@/src/providers/flashscore/client";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";
import { normalizeFlashscorePlayers } from "@/src/providers/flashscore/player-stats";
import {
  orderedGoalsFromFlashscoreSummary,
  type FlashscoreOrderedGoalsRefusal,
} from "@/src/providers/flashscore/summary";
import type { BetSettlementTerms } from "@/src/services/bets/settle-terms";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import {
  awaitFlashscoreDetail,
  cachedPerMatch,
  listedFlashscoreScore,
  settleFlashscoreBet,
  STATS_GRACE_MS,
  type FlashscorePair,
  type PlayerStatsCache,
  type SummaryCache,
} from "./settle";

/**
 * Artilheiro pelo `player-stats` e pelo resumo de gols do FlashScore: "marcar a
 * qualquer momento", gol por tempo e primeiro/último a marcar.
 *
 * Nome de jogador é mais ambíguo que nome de time: tudo que não é casamento
 * folgado vira liquidação manual COM alerta, nunca um chute. O resolvedor puro
 * (`domain/settlement/goalscorer.ts`) recusa homônimo, nome ausente e gol
 * contra; aqui a recusa vira ação para o operador.
 */

const log = createLogger("flashscore-goalscorer");
const orderedLog = createLogger("flashscore-ordered-goalscorer");

const QUALIFICADOR_SEM_CONTRATO =
  "o mercado pede mais que o gol do jogador (assistência, cabeça, fora da área, " +
  "dois tempos ou combinação), e o FlashScore só diz quantos gols ele fez";

/** Texto do alerta por motivo — cada recusa diz ao operador o que conferir. */
const EXPLICACAO: Record<GoalscorerRefusal, string> = {
  selecao_sem_jogador: "a seleção não isola um nome de jogador",
  sem_jogadores: "o FlashScore não publicou a lista de jogadores desta partida",
  jogador_nao_encontrado: "nenhum jogador da partida bate com esse nome",
  jogador_ambiguo: "mais de um jogador bate com esse nome",
  gol_contra_envolvido: "o jogador casado marcou GOL CONTRA — a convenção da casa decide",
  polaridade_negativa:
    "a linha NEGA o gol (\"Não\"/\"No\") — liquidar pelo gol do jogador inverteria o resultado",
  participacao_nao_comprovada: "o feed não publicou os minutos nem a escalação — sem gol, não dá para saber se o atleta entrou",
  quantidade_de_gols_desconhecida: "não consegui ler quantos gols a aposta pede (use 2+, 3+, hat-trick…)",
  periodo_nao_suportado: "o período do mercado/seleção não é tempo integral (FT)",
  qualificador_sem_contrato: QUALIFICADOR_SEM_CONTRATO,
};

/** Motivos que só existem no caminho por TEMPO, onde a prova é o minuto do gol. */
const EXPLICACAO_PERIODO: Record<"periodo_nao_reconhecido" | "gols_inconsistentes", string> = {
  periodo_nao_reconhecido: "o período pedido não é 1º nem 2º tempo",
  gols_inconsistentes:
    "o resumo da partida não explica todos os gols que a estatística dá ao jogador",
};

/**
 * Evidência que vai para o `resultSnapshot`, com confiança e fonte em tipo
 * (um `Record<string, unknown>` não é JSON válido para o Prisma).
 */
export type GoalscorerEvidence =
  | {
      resolvido: true;
      jogador: string;
      playerId: string;
      gols: number;
      confidence: number;
      vantagem: number;
      source: "AUTO";
    }
  | {
      resolvido: false;
      motivo: GoalscorerRefusal;
      jogadoresNaPartida: number;
      candidatos?: string[];
    };

type GoalscorerOutcome = {
  /** Liquidou de fato (mudou o status da aposta). */
  settled: boolean;
  /** Precisa de decisão humana — o caller marca a observação como final. */
  unsupported: boolean;
  /**
   * A resposta ainda pode mudar: a observação fica ABERTA para o próximo ciclo,
   * sem alertar ninguém. O feed publica a escalação com atraso, e a primeira
   * leitura terminal costuma chegar antes dela.
   */
  aguardando: boolean;
  settlementOutcome: string;
  evidencia: GoalscorerEvidence;
};

export async function settleFlashscoreGoalscorer(params: {
  bet: BetSettlementTerms;
  matchId: string;
  /** Reaproveita a resposta entre apostas da MESMA partida. */
  cache: PlayerStatsCache;
  now: Date;
  /** Resumo da partida e placar listado: só o caminho por TEMPO usa. */
  summaryCache?: SummaryCache;
  listedScore?: FlashscorePair;
}): Promise<GoalscorerOutcome> {
  // O qualificador só depende do texto da aposta: vai ao dono sem buscar a lista.
  if (hasUnsupportedGoalQualifier(params.bet.mercado, params.bet.selecao)) {
    return goalscorerManual(params.bet, { reason: "qualificador_sem_contrato" }, 0);
  }
  // Provider fora do ar não é "não marcou": a falha sobe e a observação fica aberta.
  const payload = await awaitFlashscoreDetail(
    cachedPerMatch(params.cache, params.matchId, getFlashscoreMatchPlayerStats),
    "jogadores",
    params.bet.id,
  );
  const jogadores = payload ? normalizeFlashscorePlayers(payload) : [];

  const periodo = ehMercadoArtilheiroPorTempo(params.bet.mercado, params.bet.selecao)
    ? declaredScorePeriod({ mercado: params.bet.mercado, selecao: params.bet.selecao, esporte: params.bet.esporte })
    : "FT";
  // Gol de 1º/2º tempo: a estatística do jogador é só do jogo inteiro, então
  // quem responde é o minuto de cada gol, do resumo da partida.
  if (periodo === "HT" || periodo === "SECOND_HALF") {
    return resolverPorPeriodo({ ...params, jogadores, periodo });
  }
  const resolucao = resolveGoalscorer({
    selecao: params.bet.selecao,
    mercado: params.bet.mercado,
    jogadores,
  });
  if (
    !resolucao.ok &&
    resolucao.reason === "sem_jogadores" &&
    params.now.getTime() - params.bet.data.getTime() < STATS_GRACE_MS
  ) {
    log.info(
      { betId: params.bet.id, matchId: params.matchId },
      "escalação ainda não publicada; aguardando o próximo ciclo",
    );
    return {
      settled: false,
      unsupported: false,
      aguardando: true,
      settlementOutcome: "goalscorer_pending",
      evidencia: { resolvido: false, motivo: resolucao.reason, jogadoresNaPartida: 0 },
    };
  }
  if (!resolucao.ok) return goalscorerManual(params.bet, resolucao, jogadores.length);

  const settled = await settleFlashscoreBet({
    bet: params.bet,
    status: resolucao.status,
    label: resolucao.status === "VOID"
      ? `${resolucao.jogador.nome} não entrou em campo`
      : `${resolucao.jogador.nome} · ${resolucao.jogador.gols} gol(s)`,
  });
  return {
    settled,
    unsupported: false,
    aguardando: false,
    settlementOutcome: settled ? "settled_from_goalscorer" : "already_settled",
    evidencia: {
      resolvido: true,
      jogador: resolucao.jogador.nome,
      playerId: resolucao.jogador.playerId,
      gols: resolucao.jogador.gols,
      confidence: Number(resolucao.similaridade.toFixed(3)),
      vantagem: Number(resolucao.vantagem.toFixed(3)),
      source: "AUTO",
    },
  };
}

/** Recusa do artilheiro que o feed não muda: vai ao dono e fecha a observação. */
async function goalscorerManual(
  bet: BetSettlementTerms,
  refusal: { reason: GoalscorerRefusal; candidatos?: string[] },
  jogadoresNaPartida: number,
): Promise<GoalscorerOutcome> {
  log.info(
    { betId: bet.id, motivo: refusal.reason, jogadores: jogadoresNaPartida },
    "artilheiro não resolvido automaticamente",
  );
  const candidatos: { candidatos?: string[] } = refusal.candidatos ? { candidatos: refusal.candidatos } : {};
  await sendOperationalAlert(
    `✋ Liquidar à mão · ${bet.evento}\n` +
      `${bet.selecao}\n` +
      `Motivo: ${EXPLICACAO[refusal.reason]}.` +
      (refusal.candidatos?.length ? `\nJogadores possíveis: ${refusal.candidatos.join(", ")}` : "") +
      "\n👉 Liquide em Operações.",
    {
      source: "settlement.flashscore-goalscorer",
      key: bet.id,
      title: `Liquidação manual (artilheiro): ${bet.evento}`,
      resource: "bet",
      resourceId: bet.id,
      evidence: { motivo: refusal.reason, selecao: bet.selecao, jogadoresNaPartida, ...candidatos },
      autoResolve: false,
    },
  );
  return {
    settled: false,
    unsupported: true,
    aguardando: false,
    settlementOutcome: `manual_${refusal.reason}`,
    evidencia: { resolvido: false, motivo: refusal.reason, jogadoresNaPartida, ...candidatos },
  };
}

/**
 * "Fulano marcar no 1º tempo" numa aposta SIMPLES. Sem o resumo, sem prova: a
 * aposta vai para manual com o motivo. E o resumo precisa explicar TODOS os
 * gols que a estatística atribui ao jogador; se faltar um, o "não marcou no 1º
 * tempo" não está provado.
 */
async function resolverPorPeriodo(params: {
  bet: BetSettlementTerms;
  matchId: string;
  now: Date;
  jogadores: readonly JogadorDaPartida[];
  periodo: "HT" | "SECOND_HALF";
  summaryCache?: SummaryCache;
  listedScore?: FlashscorePair;
}): Promise<GoalscorerOutcome> {
  const manual = (motivo: string): GoalscorerOutcome => ({
    settled: false, unsupported: true, aguardando: false,
    settlementOutcome: `manual_${motivo}`,
    evidencia: { resolvido: false, motivo: motivo as never, jogadoresNaPartida: params.jogadores.length },
  });
  if (!params.listedScore) return manual("sem_placar_listado");
  const summary = await cachedPerMatch(params.summaryCache ?? new Map(), params.matchId, getFlashscoreMatchSummary);
  if (!summary) return manual("summary_vazio");
  const gols = orderedGoalsFromFlashscoreSummary({ summary, listedScore: params.listedScore });
  if (!gols.ok) {
    log.info({ betId: params.bet.id, motivo: gols.reason }, "resumo não explica os gols da partida");
    return manual(gols.reason);
  }
  const resolucao = resolvePeriodGoalscorer({
    selecao: params.bet.selecao, mercado: params.bet.mercado,
    jogadores: params.jogadores, gols: gols.gols, periodo: params.periodo,
  });
  if (!resolucao.ok) {
    const explicacao = resolucao.reason in EXPLICACAO_PERIODO
      ? EXPLICACAO_PERIODO[resolucao.reason as keyof typeof EXPLICACAO_PERIODO]
      : EXPLICACAO[resolucao.reason as GoalscorerRefusal] ?? resolucao.reason;
    await sendOperationalAlert(
      `✋ Liquidar à mão · ${params.bet.evento}\n` +
        `${params.bet.selecao}\n` +
        `Motivo: ${explicacao}.\n👉 Liquide em Operações.`,
      {
        source: "settlement.flashscore-goalscorer",
        key: params.bet.id,
        title: `Liquidação manual (gol por tempo): ${params.bet.evento}`,
        resource: "bet",
        resourceId: params.bet.id,
        evidence: { motivo: resolucao.reason, selecao: params.bet.selecao, periodo: params.periodo },
        autoResolve: false,
      },
    );
    return manual(resolucao.reason);
  }
  const settled = await settleFlashscoreBet({
    bet: params.bet,
    status: resolucao.status,
    label: resolucao.status === "VOID"
      ? `${resolucao.jogador.nome} não entrou em campo`
      : `${resolucao.jogador.nome} · ${resolucao.golsNoPeriodo} gol(s) no ${params.periodo === "HT" ? "1º" : "2º"} tempo`,
  });
  return {
    settled, unsupported: false, aguardando: false,
    settlementOutcome: settled ? "settled_from_goalscorer_period" : "already_settled",
    evidencia: {
      resolvido: true,
      jogador: resolucao.jogador.nome,
      playerId: resolucao.jogador.playerId,
      gols: resolucao.golsNoPeriodo,
      confidence: 1,
      vantagem: 1,
      source: "AUTO",
    },
  };
}

type OrderedRefusal =
  | FlashscoreOrderedGoalsRefusal
  | OrderedGoalscorerRefusal
  | "placar_ausente";

const EXPLICACAO_ORDENADO: Record<OrderedRefusal, string> = {
  summary_vazio: "o summary veio vazio",
  summary_incompleto: "os eventos do summary não explicam o placar final inteiro",
  sem_gols: "não há evento de gol ordenado",
  gols_nao_ordenados: "os minutos dos gols não formam uma ordem inequívoca",
  gol_sem_jogador: "um evento de gol não identifica o jogador",
  gol_contra_envolvido: "há gol contra e a convenção da casa decide a ordem elegível",
  selecao_sem_jogador: "a seleção não isola um nome de jogador",
  sem_jogadores: "o FlashScore não publicou o roster da partida",
  jogador_nao_encontrado: "o jogador da seleção não aparece no roster da partida",
  jogador_ambiguo: "mais de um jogador do roster bate com a seleção",
  jogador_do_gol_ausente: "o autor do gol ordenado não aparece no roster da partida",
  mercado_sem_ordem: "o mercado não declara First ou Last de forma inequívoca",
  polaridade_negativa: "a seleção nega o evento e inverteria o resultado",
  placar_ausente: "o resultado final não trouxe placar comparável",
  participacao_nao_comprovada: "o feed não publicou os minutos nem a escalação — sem gol, não dá para saber se o atleta entrou",
  quantidade_de_gols_desconhecida: "primeiro/último a marcar não combina com quantidade de gols",
  periodo_nao_suportado: "o período do mercado/seleção não é tempo integral (FT)",
  qualificador_sem_contrato: QUALIFICADOR_SEM_CONTRATO,
  entrada_apos_primeiro_gol_nao_descartada:
    "o jogador não foi titular e não consegui provar que entrou antes do primeiro gol — " +
    "se entrou depois, a casa anula a aposta (VOID)",
};

export type OrderedGoalscorerEvidence =
  | {
      resolvido: true;
      ordem: OrderedGoalscorerOrder;
      jogadorSelecionado: string;
      jogadorDoGol: string;
      playerIdDoGol: string;
      minuto: string;
      golsOrdenados: number;
      confidence: number;
      vantagem: number;
      source: "AUTO";
    }
  | {
      resolvido: false;
      motivo: OrderedRefusal;
      jogadoresNaPartida: number;
      golsOrdenados: number;
      candidatos?: string[];
    };

type OrderedGoalscorerOutcome = {
  settled: boolean;
  unsupported: boolean;
  aguardando: boolean;
  settlementOutcome: string;
  evidencia: OrderedGoalscorerEvidence;
};

type OrderedRefusalParams = {
  bet: { id: string; evento: string; selecao: string; data: Date };
  motivo: OrderedRefusal;
  jogadoresNaPartida: number;
  golsOrdenados: number;
  candidatos?: string[];
};

function orderedRefusalEvidence(params: OrderedRefusalParams): OrderedGoalscorerEvidence {
  return {
    resolvido: false,
    motivo: params.motivo,
    jogadoresNaPartida: params.jogadoresNaPartida,
    golsOrdenados: params.golsOrdenados,
    ...(params.candidatos ? { candidatos: params.candidatos } : {}),
  };
}

/** Até a carência, a recusa pode ser dado ainda não publicado: espera sem alertar. */
async function orderedPendingOrManual(
  params: OrderedRefusalParams & { now: Date },
): Promise<OrderedGoalscorerOutcome> {
  if (params.now.getTime() - params.bet.data.getTime() < STATS_GRACE_MS) {
    orderedLog.info(
      { betId: params.bet.id, motivo: params.motivo },
      "summary/roster ainda insuficiente para First/Last; aguardando",
    );
    return {
      settled: false,
      unsupported: false,
      aguardando: true,
      settlementOutcome: "ordered_goalscorer_pending",
      evidencia: orderedRefusalEvidence(params),
    };
  }
  return orderedManual(params);
}

async function orderedManual(params: OrderedRefusalParams): Promise<OrderedGoalscorerOutcome> {
  const evidencia = orderedRefusalEvidence(params);
  await sendOperationalAlert(
    `✋ Liquidar à mão · ${params.bet.evento}\n` +
      `${params.bet.selecao}\n` +
      `Motivo: ${EXPLICACAO_ORDENADO[params.motivo]}.\n👉 Liquide em Operações.`,
    {
      source: "settlement.flashscore-ordered-goalscorer",
      key: params.bet.id,
      title: `Liquidação manual (First/Last Goalscorer): ${params.bet.evento}`,
      resource: "bet",
      resourceId: params.bet.id,
      evidence: evidencia,
      autoResolve: false,
    },
  );
  return {
    settled: false,
    unsupported: true,
    aguardando: false,
    settlementOutcome: `manual_${params.motivo}`,
    evidencia,
  };
}

/** Primeiro/último a marcar: a ordem sai do resumo, o jogador do roster. */
export async function settleFlashscoreOrderedGoalscorer(params: {
  bet: BetSettlementTerms;
  candidate: FlashscoreMatchCandidate;
  playerStatsCache: PlayerStatsCache;
  summaryCache: SummaryCache;
  now: Date;
}): Promise<OrderedGoalscorerOutcome> {
  // O qualificador só depende do texto da aposta: vai ao dono sem esperar o feed.
  if (hasUnsupportedGoalQualifier(params.bet.mercado, params.bet.selecao)) {
    return orderedManual({
      bet: params.bet, motivo: "qualificador_sem_contrato", jogadoresNaPartida: 0, golsOrdenados: 0,
    });
  }
  const match = params.candidate.match;
  const listedScore = listedFlashscoreScore(match);
  if (!listedScore) {
    return orderedPendingOrManual({
      bet: params.bet,
      now: params.now,
      motivo: "placar_ausente",
      jogadoresNaPartida: 0,
      golsOrdenados: 0,
    });
  }
  const summaryPending = cachedPerMatch(params.summaryCache, match.match_id, getFlashscoreMatchSummary);
  const playersPending = cachedPerMatch(params.playerStatsCache, match.match_id, getFlashscoreMatchPlayerStats);

  const [summaryPayload, playerPayload] = await Promise.all([summaryPending, playersPending]);
  const jogadores = playerPayload ? normalizeFlashscorePlayers(playerPayload) : [];
  const summary = orderedGoalsFromFlashscoreSummary({
    summary: summaryPayload ?? [],
    listedScore,
  });
  if (!summary.ok) {
    return orderedPendingOrManual({
      bet: params.bet,
      now: params.now,
      motivo: summary.reason,
      jogadoresNaPartida: jogadores.length,
      golsOrdenados: 0,
    });
  }

  const resolucao = resolveOrderedGoalscorer({
    mercado: params.bet.mercado,
    selecao: params.bet.selecao,
    jogadores,
    gols: summary.gols,
  });
  if (!resolucao.ok) {
    return orderedPendingOrManual({
      bet: params.bet,
      now: params.now,
      motivo: resolucao.reason,
      jogadoresNaPartida: jogadores.length,
      golsOrdenados: summary.gols.length,
      ...(resolucao.candidatos ? { candidatos: resolucao.candidatos } : {}),
    });
  }

  const settled = await settleFlashscoreBet({
    bet: params.bet,
    status: resolucao.status,
    label: resolucao.status === "VOID"
      ? `${resolucao.jogadorSelecionado.nome} não entrou em campo`
      : `${resolucao.ordem === "first" ? "primeiro" : "último"} gol: ` +
        `${resolucao.jogadorDoGol.nome} aos ${resolucao.jogadorDoGol.minuto}'`,
  });
  return {
    settled,
    unsupported: false,
    aguardando: false,
    settlementOutcome: settled ? "settled_from_ordered_goalscorer" : "already_settled",
    evidencia: {
      resolvido: true,
      ordem: resolucao.ordem,
      jogadorSelecionado: resolucao.jogadorSelecionado.nome,
      jogadorDoGol: resolucao.jogadorDoGol.nome,
      playerIdDoGol: resolucao.jogadorDoGol.playerId,
      minuto: resolucao.jogadorDoGol.minuto,
      golsOrdenados: summary.gols.length,
      confidence: Number(resolucao.similaridade.toFixed(3)),
      vantagem: Number(resolucao.vantagem.toFixed(3)),
      source: "AUTO",
    },
  };
}
