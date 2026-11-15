import { canonicalSha256 } from "@/src/domain/canonical-json";
import { mentionsLiveEntry } from "@/src/domain/live-score-at-tip";
import { instanteDaEntrada } from "@/src/domain/instante-da-entrada";
import { BudgetExhaustedError, ProviderCadenceDeferredError, ProviderRequestError } from "@/src/domain/provider-error";
import { decidePlayerProp, PLAYER_PROP_GRACE_MS, PLAYER_PROP_STABILITY_MS, playerPropRetryDelay, type PlayerPropRule } from "@/src/domain/settlement/player-prop-rules";
import type { PlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { propStatLabel } from "@/src/domain/settlement/player-prop-classify";
import { resolvePlayerProp, type PlayerPropRefusal } from "@/src/domain/settlement/player-props";
import { matchTeamSide } from "@/src/domain/settlement/sides";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { getFlashscoreMatchPlayerStats } from "@/src/providers/flashscore/client";
import { mergePlayerAppearances, normalizePlayerAppearances } from "@/src/providers/flashscore/lineups";
import { getFlashscorePlayerEvidence } from "@/src/providers/flashscore/player-evidence";
import { normalizeFlashscorePlayers, VERIFIED_PLAYER_STAT_KEYS } from "@/src/providers/flashscore/player-stats";
import {
  applyAutomaticBetStatusChangeTx,
  BetNotPendingError,
  insertSettlementEventTx,
  type ApplyBetStatusChangeResult,
} from "@/src/services/bets/settle";
import { finishBetStatusChange } from "@/src/services/bets/settle-effects";
import { assertBetSettlementTermsTx, BetSettlementTermsChangedError, type BetSettlementTerms } from "@/src/services/bets/settle-terms";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { resolvePlayerIdentity } from "@/src/services/players/resolve";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import {
  awaitFlashscoreDetail,
  cachedPerMatch,
  notifyFlashscoreSettlement,
  settleFlashscoreBet,
  STATS_GRACE_MS,
  type PlayerStatsCache,
} from "./settle";

/**
 * Props de jogador (finalizações, desarmes, faltas…). A aposta simples sem
 * termos persistidos liquida pela lista de jogadores da partida; a com termos
 * persistidos (`bet_player_props`) segue o contrato da regra da casa, com
 * janela de estabilidade e revisão em 24h.
 */

const log = createLogger("flashscore-player-props");

const EXPLICACAO: Record<PlayerPropRefusal, string> = {
  nao_e_prop_de_jogador: "a seleção não é uma prop de jogador reconhecida",
  selecao_sem_jogador: "a seleção não isola um nome de jogador",
  sem_jogadores: "o FlashScore não publicou a lista de jogadores desta partida",
  jogador_nao_encontrado: "nenhum jogador da partida bate com esse nome",
  jogador_ambiguo: "mais de um jogador bate com esse nome",
  stat_ausente: "o feed não publicou a estatística deste jogador — ausência não é zero",
  jogador_nao_participou: "o feed publicou zero minuto — desempenho zero não está provado",
  participacao_nao_comprovada: "o feed não provou que o jogador entrou em campo",
  periodo_nao_suportado: "o feed só publicou o agregado FT, não o período pedido",
  convencao_de_cartoes_ambigua:
    "a regra da casa para vermelho e segundo amarelo não está comprovada",
  qualificador_sem_contrato: "a seleção pede uma unidade ou condição sem prova equivalente no feed",
  missing_line: "a seleção não traz uma linha over/under utilizável",
  ambiguous_selection: "não dá para ler se a linha é over ou under",
};

export type PlayerPropEvidence =
  | { version: 1; resolvido: boolean; motivo: string; jogadoresNaPartida: number; details: Record<string, unknown> }
  | {
      resolvido: true;
      jogador: string;
      playerId: string;
      family: string;
      chave: string;
      valor: number;
      confidence: number;
      vantagem: number;
      source: "AUTO";
    }
  | {
      resolvido: false;
      motivo: PlayerPropRefusal;
      jogadoresNaPartida: number;
      candidatos?: string[];
    };

export type PlayerPropOutcome = {
  settled: boolean;
  unsupported: boolean;
  aguardando: boolean;
  settlementOutcome: string;
  evidencia: PlayerPropEvidence;
};

export async function settleFlashscorePlayerProp(params: {
  bet: BetSettlementTerms;
  matchId: string;
  cache: PlayerStatsCache;
  now: Date;
}): Promise<PlayerPropOutcome> {
  const payload = await awaitFlashscoreDetail(
    cachedPerMatch(params.cache, params.matchId, getFlashscoreMatchPlayerStats),
    "jogadores",
    params.bet.id,
  );
  const jogadores = payload ? normalizeFlashscorePlayers(payload) : [];

  const resolucao = resolvePlayerProp({
    mercado: params.bet.mercado,
    selecao: params.bet.selecao,
    evento: params.bet.evento,
    esporte: params.bet.esporte,
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
      settlementOutcome: "player_prop_pending",
      evidencia: { resolvido: false, motivo: resolucao.reason, jogadoresNaPartida: 0 },
    };
  }
  if (!resolucao.ok) {
    log.info(
      { betId: params.bet.id, motivo: resolucao.reason, jogadores: jogadores.length },
      "prop de jogador não resolvida automaticamente",
    );
    await sendOperationalAlert(
      `✋ Liquidar à mão · ${params.bet.evento}\n` +
        `${params.bet.selecao}\n` +
        `Motivo: ${EXPLICACAO[resolucao.reason]}.` +
        (resolucao.candidatos?.length
          ? `\nJogadores possíveis: ${resolucao.candidatos.join(", ")}`
          : "") +
        "\n👉 Liquide em Operações.",
      {
        source: "settlement.flashscore-player-prop",
        key: params.bet.id,
        title: `Liquidação manual (prop de jogador): ${params.bet.evento}`,
        resource: "bet",
        resourceId: params.bet.id,
        evidence: {
          motivo: resolucao.reason,
          selecao: params.bet.selecao,
          jogadoresNaPartida: jogadores.length,
          ...(resolucao.candidatos ? { candidatos: resolucao.candidatos } : {}),
        },
        autoResolve: false,
      },
    );
    return {
      settled: false,
      unsupported: true,
      aguardando: false,
      settlementOutcome: `manual_${resolucao.reason}`,
      evidencia: {
        resolvido: false,
        motivo: resolucao.reason,
        jogadoresNaPartida: jogadores.length,
        ...(resolucao.candidatos ? { candidatos: resolucao.candidatos } : {}),
      },
    };
  }

  const settled = await settleFlashscoreBet({
    bet: params.bet,
    status: resolucao.status,
    label: `${resolucao.jogador.nome} · ${resolucao.valor} ${propStatLabel(resolucao.family, resolucao.valor)}`,
  });
  return {
    settled,
    unsupported: false,
    aguardando: false,
    settlementOutcome: settled ? "settled_from_player_prop" : "already_settled",
    evidencia: {
      resolvido: true,
      jogador: resolucao.jogador.nome,
      playerId: resolucao.jogador.playerId,
      family: resolucao.family,
      chave: resolucao.chave,
      valor: resolucao.valor,
      confidence: Number(resolucao.similaridade.toFixed(3)),
      vantagem: Number(resolucao.vantagem.toFixed(3)),
      source: "AUTO",
    },
  };
}

type Observation = {
  endedAt?: string; observedAt?: string; fingerprint?: string; stableSince?: string;
  reason?: string; status?: string; proposedStatus?: string; checked24h?: boolean;
};

export async function settlePersistentPlayerProp(params: {
  bet: BetSettlementTerms; matchId: string; now: Date;
  homeId: string; awayId: string; swapped: boolean; extraTime: boolean;
  recheck?: boolean;
}): Promise<PlayerPropOutcome> {
  const stored = await prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: params.bet.id }, include: { bet: { select: { bankroll: { select: { playerPropsAutoSettlement: true } } } } } });
  if (stored.revision !== params.bet.playerPropRevision) throw new BetSettlementTermsChangedError(params.bet.id);
  const terms = stored.terms as unknown as PlayerPropTerms;
  const rule = stored.rule as unknown as PlayerPropRule;
  const before = (stored.evidence ?? {}) as Observation;
  const endedAt = before.endedAt ?? params.now.toISOString();
  const elapsed = params.now.getTime() - Date.parse(endedAt);
  const waiting = (reason: string, details: Record<string, unknown> = {}): PlayerPropOutcome => ({
    settled: false, unsupported: elapsed >= PLAYER_PROP_GRACE_MS, aguardando: elapsed < PLAYER_PROP_GRACE_MS,
    settlementOutcome: elapsed < PLAYER_PROP_GRACE_MS ? "player_prop_pending" : `manual_${reason}`,
    evidencia: { version: 1, resolvido: false, motivo: reason, jogadoresNaPartida: 0, details },
  });
  if (!params.recheck && before.observedAt && params.now.getTime() - Date.parse(before.observedAt) < playerPropRetryDelay(elapsed)) return waiting(before.reason ?? "aguardando_estatistica");
  // A janela de seis horas começa na primeira leitura do jogo encerrado,
  // mesmo que os endpoints de jogador fiquem fora do ar a janela inteira.
  if (!params.recheck && !before.endedAt) await runSerializableTransaction("playerProp.end", async (tx) => {
    await assertBetSettlementTermsTx(tx, params.bet);
    await tx.betPlayerProp.updateMany({ where: { betId: stored.betId, revision: stored.revision, bet: { status: "PENDING", deletedAt: null } }, data: { evidence: { ...before, endedAt, checked24h: false, teams: { home: params.homeId, away: params.awayId, swapped: params.swapped }, extraTime: params.extraTime } } });
  });
  let data;
  try { data = await getFlashscorePlayerEvidence(params.matchId); }
  catch (error) {
    if (params.recheck || !(error instanceof BudgetExhaustedError || error instanceof CircuitOpenError || error instanceof ProviderRequestError || error instanceof ProviderCadenceDeferredError)) throw error;
    await runSerializableTransaction("playerProp.unavailable", async (tx) => {
      await assertBetSettlementTermsTx(tx, params.bet);
      await tx.betPlayerProp.updateMany({ where: { betId: stored.betId, revision: stored.revision, bet: { status: "PENDING", deletedAt: null } }, data: { resolutionStatus: elapsed >= PLAYER_PROP_GRACE_MS ? "REVIEW" : "PENDING", evidence: { ...before, endedAt, observedAt: params.now.toISOString(), reason: "provider_indisponivel", checked24h: false, teams: { home: params.homeId, away: params.awayId, swapped: params.swapped }, extraTime: params.extraTime } } });
    });
    return waiting("provider_indisponivel");
  }
  const appearances = normalizePlayerAppearances(data.lineups, { home: params.homeId, away: params.awayId });
  let players = mergePlayerAppearances(normalizeFlashscorePlayers(data.stats), appearances);
  players = players.filter((p) => p.teamId === params.homeId || p.teamId === params.awayId);
  if (terms.time) {
    const side = matchTeamSide(terms.time, params.bet.evento);
    const providerSide = params.swapped ? (side === "home" ? "away" : side === "away" ? "home" : null) : side;
    players = providerSide ? players.filter((p) => p.teamId === (providerSide === "home" ? params.homeId : params.awayId)) : [];
  }
  const resolution = await resolvePlayerIdentity({ selection: terms.selecaoOriginal, playerName: terms.jogador, matchId: params.matchId, sport: params.bet.esporte, players, appearances, now: params.now });
  // O ID curado só vale se o mesmo jogador estiver nesta partida.
  const selected = stored.playerIdentityId
    ? await prisma.playerIdentity.findUnique({ where: { id: stored.playerIdentityId } })
    : null;
  const selectedPlayer = selected ? players.find((p) => p.playerId === selected.providerPlayerId) : null;
  const player = selectedPlayer ?? (stored.playerIdentityId ? null : resolution.ok ? resolution.jogador : null);
  const decision = player ? decidePlayerProp({ terms, rule, player, competition: params.bet.competicao, extraTime: params.extraTime, verifiedKeys: VERIFIED_PLAYER_STAT_KEYS, preMatch: !params.bet.kickoffInferido && !params.bet.liveTextAtCapture
    && params.bet.liveScoreHome == null && params.bet.liveScoreAway == null
    && ![params.bet.mercado, params.bet.selecao].some(mentionsLiveEntry)
    && instanteDaEntrada(params.bet) < params.bet.data }) : { ok: false as const, reason: stored.playerIdentityId ? "jogador_fora_da_partida" : resolution.ok ? "jogador_nao_encontrado" : resolution.reason };
  const identityId = selectedPlayer ? stored.playerIdentityId : resolution.ok && !stored.playerIdentityId ? resolution.identityId : null;
  const fingerprint = canonicalSha256({ matchId: params.matchId, playerId: player?.playerId ?? null, decision, rule, revision: stored.revision, participation: player ? { titular: player.titular, participou: player.participou, substituido: player.substituido } : null });
  const stableSince = before.fingerprint === fingerprint && before.stableSince ? before.stableSince : new Date(Math.max(data.fetchedAt.getTime(), Date.parse(endedAt))).toISOString();
  const stable = decision.ok && data.fetchedAt.getTime() - Date.parse(stableSince) >= PLAYER_PROP_STABILITY_MS;
  const reason = !decision.ok ? decision.reason : !stable ? "aguardando_confirmacao" : "validacao_do_grupo_pendente";
  const evidence = {
    teams: { home: params.homeId, away: params.awayId, swapped: params.swapped }, extraTime: params.extraTime, checked24h: params.recheck === true,
    version: 1, endedAt, observedAt: data.fetchedAt.toISOString(), stableSince, fingerprint,
    reason, matchId: params.matchId, playerId: player?.playerId ?? null,
    playerName: player?.nome ?? terms.jogador, teamId: player?.teamId ?? null,
    family: terms.family, rule, terms, decision, stable,
    source: { provider: "flashscore", endpoints: ["/matches/match/player-stats", "/matches/match/lineups"] },
    participation: player ? { titular: player.titular ?? null, participou: player.participou ?? null, substituido: player.substituido ?? null, minutosJogados: player.minutosJogados ?? null, lineup: appearances.find((a) => a.playerId === player.playerId) ?? null } : null,
    ...(decision.ok && stable ? { proposedStatus: decision.status } : {}),
    candidates: players.map((p) => ({ playerId: p.playerId, nome: p.nome, teamId: p.teamId })),
    ...(params.recheck ? { checked24h: true, previousProposal: before.proposedStatus ?? null, correctionReview: Boolean(before.proposedStatus && (!decision.ok || before.proposedStatus !== decision.status)) } : {}),
  };
  const allowAutomatic = stable && stored.bet.bankroll.playerPropsAutoSettlement && !params.recheck;
  const alreadySettled: PlayerPropOutcome = {
    settled: false, unsupported: false, aguardando: false, settlementOutcome: "already_settled",
    evidencia: { version: 1, resolvido: false, motivo: "already_settled", jogadoresNaPartida: players.length, details: evidence },
  };
  let applied: ApplyBetStatusChangeResult | null;
  try {
    applied = await runSerializableTransaction("playerProp.observe", async (tx) => {
      await assertBetSettlementTermsTx(tx, params.bet, { allowSettledTransition: !params.recheck });
      await tx.betPlayerProp.update({ where: { betId: params.bet.id }, data: {
        playerIdentityId: identityId, providerMatchId: params.matchId,
        resolutionStatus: player ? "MATCHED" : "REVIEW", evidence,
      } });
      await insertSettlementEventTx(tx, { betId: params.bet.id, type: params.recheck ? "PLAYER_PROP_RECHECK" : "PLAYER_PROP_OBSERVATION", payload: evidence });
      if (params.recheck && before.proposedStatus && (!decision.ok || before.proposedStatus !== decision.status)) {
        await tx.auditEvent.create({ data: { action: "player_prop.result_changed", resource: "bet", resourceId: params.bet.id, details: { previous: before.proposedStatus, proposed: decision.ok ? decision.status : decision.reason } } });
      }
      if (!allowAutomatic || !decision.ok) return null;
      return applyAutomaticBetStatusChangeTx(tx, { betId: params.bet.id, newStatus: decision.status, source: "flashscore", expectedTerms: params.bet });
    });
  } catch (error) {
    // Liquidada à mão durante a leitura: a decisão já é do dono.
    if (error instanceof BetNotPendingError) return alreadySettled;
    throw error;
  }
  if (applied && applied.previousStatus !== "PENDING") return alreadySettled;
  if (applied) {
    // Mesmos efeitos pós-commit de toda liquidação automática: cancela o
    // sharp.enrich pendente, avisa a liquidação sem conta e manda o resultado.
    await finishBetStatusChange(params.bet.id, applied);
    const playerName = player?.nome ?? terms.jogador;
    const value = decision.ok ? decision.value : null;
    await notifyFlashscoreSettlement(params.bet, applied, value === null
      ? `${playerName} não foi titular`
      : `${playerName} · ${value} ${propStatLabel(terms.family, value)}`);
    return { settled: true, unsupported: false, aguardando: false, settlementOutcome: "settled_from_player_prop", evidencia: { version: 1, resolvido: true, motivo: "comprovado", jogadoresNaPartida: players.length, details: evidence } };
  }
  if (stable) return { ...waiting(reason, evidence), aguardando: false, unsupported: true, settlementOutcome: "player_prop_shadow" };
  return waiting(reason, evidence);
}
