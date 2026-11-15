import { identityEventName } from "@/src/domain/live-score-at-tip";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { canonicalCompetition, canonicalCountry } from "@/src/domain/national-teams";
import { isDelegatedActor } from "@/src/domain/production-write-actors";
import { splitEventoTeams } from "@/src/domain/text";
import { IdentityStatus, Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { parseBridgeLeague } from "@/src/providers/bridgeodds/types";
import { orientPinnacle17Selection, selectionFollowsEventOrder } from "@/src/providers/pinnacle17/sharp";
import { bridgeMatchGameStart } from "@/src/services/sharp/enrich/apply-identity";
import { runSerializableTransaction, type TransactionWriteGuard } from "@/src/services/shared/transaction";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import {
  teachTipsterNamesFromChoice,
  type ChosenGameTeaching,
  type TeachFromChoiceInput,
} from "@/src/services/teams/tipster-names";

export class TrainingCaseConflictError extends RecusaDeNegocioError {
  constructor() { super("Os candidatos do caso mudaram; atualize a lista e escolha novamente."); }
}

export const TRAINING_REVIEW_DEFER_MS = 2 * 3_600_000;
export const TRAINING_REVIEW_COOLDOWN_KEY = (betId: string) => `training-review:${betId}`;

export async function trainingReviewCooldownsActive(
  betIds: string[],
  now: Date,
): Promise<Set<string>> {
  if (betIds.length === 0) return new Set();
  const keyToBetId = new Map(betIds.map((id) => [TRAINING_REVIEW_COOLDOWN_KEY(id), id]));
  const rows = await prisma.iaJudgeCooldown.findMany({
    where: { key: { in: [...keyToBetId.keys()] }, expiresAt: { gt: now } },
    select: { key: true },
  });
  return new Set(rows.flatMap((row) => {
    const betId = keyToBetId.get(row.key);
    return betId ? [betId] : [];
  }));
}

/**
 * Resolução de um TrainingCase pelo dono ou pelo agente dele. A aposta passa a
 * carregar os nomes, o país e o campeonato da Pinnacle, como no casamento
 * automático: é por eles que o fechamento e a liquidação reencontram o jogo
 * sem depender de tradução. A escolha vale como a do dono: os nomes do tipster
 * entram já confirmados nas fichas dos times do jogo escolhido
 * (`teachTipsterNamesFromChoice`), na mesma transação.
 */

export type CaseCandidate = {
  matchId: number;
  home: string;
  away: string;
  league: string;
  matchDate: string;
  score: number;
  swapped: boolean;
};

export type PlanoResolucao = {
  pais: string;
  competicao: string;
  localHome: string;
  localAway: string;
  pinnacleHome: string;
  pinnacleAway: string;
  /** O jogo da Pinnacle tem o mando trocado em relação ao post. */
  swapped: boolean;
  providerMatchId: string;
  /** Horário do jogo escolhido: o da Pinnacle17 ou, sem ela, o da lista; null quando nenhum é válido. */
  kickoff: Date | null;
};

/**
 * Deriva (sem I/O) o que a resolução grava na aposta. Lança erro acionável
 * quando o evento local não tem formato "A vs B".
 */
export function planResolucaoCase(
  tcase: { id: string; evento: string; esporte: string },
  cand: CaseCandidate,
  /** Horário atual do jogo na Pinnacle17 (`chosenGameStart`); sem ele vale o da lista. */
  gameStart: Date | null = null,
): PlanoResolucao {
  const teams = splitEventoTeams(tcase.evento);
  if (!teams) throw new Error(`Evento local sem formato A vs B no caso ${tcase.id}.`);
  const league = parseBridgeLeague(cand.league);
  const kickoff = gameStart ?? new Date(cand.matchDate);
  return {
    pais: canonicalCountry(league.pais),
    competicao: canonicalCompetition(league.competicao),
    localHome: cand.swapped ? teams.away : teams.home,
    localAway: cand.swapped ? teams.home : teams.away,
    pinnacleHome: cand.home,
    pinnacleAway: cand.away,
    swapped: cand.swapped,
    providerMatchId: String(cand.matchId),
    kickoff: Number.isNaN(kickoff.getTime()) ? null : kickoff,
  };
}

type OpenCase = { id: string; betId: string | null; evento: string; esporte: string; candidatesJson: unknown; status: string };

type ChosenGameStart = { matchId: number; gameStart: Date | null };

async function readOpenCase(tx: Prisma.TransactionClient, caseId: string, candidateIndex: number, start?: ChosenGameStart) {
  const tcase: OpenCase = await tx.trainingCase.findUniqueOrThrow({
    where: { id: caseId },
    select: { id: true, betId: true, evento: true, esporte: true, candidatesJson: true, status: true },
  });
  if (tcase.status !== "OPEN") {
    throw new RecusaDeNegocioError(`Caso ${caseId} não está aberto (status ${tcase.status}).`);
  }
  const candidates = (tcase.candidatesJson ?? []) as CaseCandidate[];
  const cand = candidates[candidateIndex];
  if (!cand) throw new RecusaDeNegocioError(`Candidato ${candidateIndex} inválido no caso ${caseId}.`);
  // O horário consultado antes da transação é o deste candidato, ou a lista mudou.
  if (start && start.matchId !== cand.matchId) throw new TrainingCaseConflictError();
  return { tcase, cand, plano: planResolucaoCase(tcase, cand, start?.gameStart) };
}

/**
 * O horário atual do jogo escolhido, na Pinnacle17 pelo mesmo id: o da lista é
 * o `match_date` da Bridge, que não acompanha remarcação. É consulta de rede,
 * feita antes da transação que grava.
 */
async function chosenGameStart(caseId: string, candidateIndex: number): Promise<ChosenGameStart> {
  const { tcase, cand } = await readOpenCase(prisma, caseId, candidateIndex);
  const bet = tcase.betId
    ? await prisma.bet.findUnique({ where: { id: tcase.betId }, select: { data: true } })
    : null;
  const gameStart = await bridgeMatchGameStart(
    { match_id: cand.matchId, match_date: cand.matchDate, sport: tcase.esporte },
    bet?.data ?? new Date(cand.matchDate),
  );
  return { matchId: cand.matchId, gameStart };
}

function teachingInput(tcase: OpenCase & { betId: string }, cand: CaseCandidate, plano: PlanoResolucao, actor: string): TeachFromChoiceInput {
  return {
    betId: tcase.betId,
    pinnacleEventId: plano.providerMatchId,
    sport: tcase.esporte,
    tipster: { home: plano.localHome, away: plano.localAway },
    pinnacle: { home: plano.pinnacleHome, away: plano.pinnacleAway },
    league: cand.league,
    country: plano.pais,
    competition: plano.competicao,
    kickoff: plano.kickoff,
    actor,
  };
}

export type TrainingCasePreview = {
  caseId: string;
  betId: string | null;
  candidate: CaseCandidate;
  eventoDepois: string;
  plano: PlanoResolucao;
  /** O que o Vincular ensinaria às fichas, sem gravar. */
  nomes: ChosenGameTeaching[];
};

/** O que `resolverTrainingCase` faria com este candidato, sem gravar nada: o plano do agente. */
export async function previewTrainingCaseResolution(params: {
  caseId: string;
  candidateIndex: number;
  actor: string;
}): Promise<TrainingCasePreview> {
  const start = await chosenGameStart(params.caseId, params.candidateIndex);
  const { tcase, cand, plano } = await readOpenCase(prisma, params.caseId, params.candidateIndex, start);
  const nomes = tcase.betId
    ? await teachTipsterNamesFromChoice(prisma, teachingInput({ ...tcase, betId: tcase.betId }, cand, plano, params.actor), { apply: false })
    : [];
  const bet = tcase.betId ? await prisma.bet.findUnique({
    where: { id: tcase.betId }, select: { evento: true, mercado: true, selecao: true, liveScoreHome: true, liveScoreAway: true },
  }) : null;
  const eventoDepois = bet
    ? chosenGameTerms(bet, plano).evento
    : identityEventName({ providerHome: plano.pinnacleHome, providerAway: plano.pinnacleAway, swapped: plano.swapped });
  return { caseId: tcase.id, betId: tcase.betId, candidate: cand, eventoDepois, plano, nomes };
}

export async function resolverTrainingCase(params: {
  caseId: string;
  candidateIndex: number;
  actor: string;
  /** O que o agente conferiu para escolher o candidato; o painel não pede. */
  evidence?: string;
  /** Hash do candidato exibido/aprovado, conferido junto da gravação. */
  expectedCandidateHash?: string;
}, options?: { beforeWrite?: TransactionWriteGuard }): Promise<{ betId: string | null; nomes: ChosenGameTeaching[] }> {
  const start = await chosenGameStart(params.caseId, params.candidateIndex);
  return runSerializableTransaction("resolverTrainingCase", async (tx) => {
    const { tcase, cand, plano } = await readOpenCase(tx, params.caseId, params.candidateIndex, start);
    if (params.expectedCandidateHash && canonicalSha256(cand) !== params.expectedCandidateHash) {
      throw new TrainingCaseConflictError();
    }
    if (tcase.betId) await tx.$queryRaw`SELECT id FROM bets WHERE id = ${tcase.betId} FOR UPDATE`;
    const resolvedAt = new Date();
    const claimed = await tx.trainingCase.updateMany({
      where: { id: tcase.id, status: "OPEN" },
      data: {
        status: "RESOLVED_MANUAL",
        resolution: "MANUAL",
        resolvedAt,
        resolutionEvidence: {
          version: 1,
          source: isDelegatedActor(params.actor) ? "agent" : "human",
          candidateIndex: params.candidateIndex,
          matchId: cand.matchId,
          score: cand.score,
          ...(params.evidence ? { evidence: params.evidence } : {}),
        },
      },
    });
    if (claimed.count !== 1) {
      throw new Error(`Caso ${params.caseId} foi alterado por outra execução.`);
    }

    // O claim e todos os efeitos ficam na mesma transação: falha parcial volta a OPEN.
    const applied = tcase.betId ? await applyChosenGameToBetTx(tx, tcase.betId, plano, params.actor) : false;
    const nomes = applied && tcase.betId
      ? await teachTipsterNamesFromChoice(tx, teachingInput({ ...tcase, betId: tcase.betId }, cand, plano, params.actor), { apply: true })
      : [];
    if (tcase.betId) {
      await tx.betSharp.upsert({
        where: { betId: tcase.betId },
        update: {
          identityStatus: IdentityStatus.MANUAL,
          confidence: 100,
          provider: "bridgeodds",
          providerMatchId: plano.providerMatchId,
          // O motivo e a referência eram da identidade anterior; o enrich que
          // segue o Vincular grava os do jogo escolhido.
          priceReference: null,
          noOddsReason: null,
          identityResolvedAt: resolvedAt,
        },
        create: {
          betId: tcase.betId,
          identityStatus: IdentityStatus.MANUAL,
          confidence: 100,
          provider: "bridgeodds",
          providerMatchId: plano.providerMatchId,
          identityResolvedAt: resolvedAt,
        },
      });
    }

    await tx.auditEvent.create({
      data: {
        actor: params.actor,
        action: "training_case.resolve",
        resource: "training_case",
        resourceId: tcase.id,
        details: {
          betId: tcase.betId, candidateIndex: params.candidateIndex, providerMatchId: plano.providerMatchId,
          ...(params.evidence ? { evidence: params.evidence } : {}),
          nomes: nomes.map((n) => ({ lado: n.lado, nome: n.nome, resultado: n.resultado, cardId: n.cardId })),
        },
      },
    });

    return { betId: tcase.betId, nomes };
  }, options);
}

type OrientedBet = { evento: string; mercado: string; selecao: string; liveScoreHome: number | null; liveScoreAway: number | null };

/** O evento e a seleção da aposta com os nomes do jogo escolhido. */
function chosenGameTerms(bet: OrientedBet, plano: PlanoResolucao): { evento: string; selecao: string } {
  const tipster = splitEventoTeams(bet.evento);
  const selecao = tipster
    ? orientPinnacle17Selection({
        mercado: bet.mercado, selecao: bet.selecao, home: tipster.home, away: tipster.away,
        providerHome: plano.pinnacleHome, providerAway: plano.pinnacleAway, swapped: plano.swapped,
      })
    : bet.selecao;
  const evento = identityEventName({
    providerHome: plano.pinnacleHome, providerAway: plano.pinnacleAway, swapped: plano.swapped,
    liveScoreHome: bet.liveScoreHome, liveScoreAway: bet.liveScoreAway,
    selectionFollowsOrder: selectionFollowsEventOrder(bet.mercado, selecao),
  });
  return { evento, selecao };
}

/**
 * Grava na aposta o jogo escolhido: nomes da Pinnacle no evento e na seleção,
 * país e campeonato da liga, com o antes e o depois na trilha da aposta. A
 * seleção que só diz o lado ("Casa") vira o nome do time antes da troca, para o
 * mando trocado não inverter a aposta. O horário do jogo só corrige a aposta
 * ainda aberta, que também perde a observação do FlashScore feita com o nome
 * antigo; a liquidada já foi conferida contra o que tinha.
 */
async function applyChosenGameToBetTx(
  tx: Prisma.TransactionClient,
  betId: string,
  plano: PlanoResolucao,
  actor: string,
): Promise<boolean> {
  const bet = await tx.bet.findUnique({
    where: { id: betId },
    select: {
      evento: true, mercado: true, selecao: true, pais: true, competicao: true, data: true, kickoffInferido: true,
      status: true, deletedAt: true, liveScoreHome: true, liveScoreAway: true,
    },
  });
  if (!bet || bet.deletedAt) return false;
  const aberta = bet.status === "PENDING";
  const depois = {
    ...chosenGameTerms(bet, plano),
    pais: plano.pais || bet.pais,
    competicao: plano.competicao || bet.competicao,
    ...(aberta && plano.kickoff ? { data: plano.kickoff, kickoffInferido: false } : { data: bet.data, kickoffInferido: bet.kickoffInferido }),
  };
  await tx.bet.update({ where: { id: betId }, data: depois });
  if (aberta) {
    // O placar final e a evidência da prop também pertencem à identidade antiga.
    await tx.betResult.deleteMany({ where: { betId } });
    await tx.betPlayerProp.updateMany({ where: { betId }, data: {
      providerMatchId: null, playerIdentityId: null, resolutionStatus: "PENDING",
      evidence: Prisma.DbNull, revision: { increment: 1 },
    } });
  }
  await tx.auditEvent.create({
    data: {
      actor,
      action: "identidade_vinculada",
      resource: "bet",
      resourceId: betId,
      details: {
        match: depois.evento,
        providerMatchId: plano.providerMatchId,
        antes: {
          evento: bet.evento, selecao: bet.selecao, pais: bet.pais, competicao: bet.competicao,
          data: bet.data.toISOString(), kickoffInferido: bet.kickoffInferido,
        },
        depois: { ...depois, data: depois.data.toISOString() },
      },
    },
  });
  return true;
}

/**
 * Fecha a revisão por agora e mantém a identidade elegível a novas tentativas.
 * O adiamento é decisão do operador e fica na trilha com ele, como a resolução.
 */
export async function ignorarTrainingCase(caseId: string, actor: string, reason?: string, options?: { beforeWrite?: TransactionWriteGuard }): Promise<void> {
  await runSerializableTransaction("ignorarTrainingCase", async (tx) => {
    const atual = await tx.trainingCase.findUniqueOrThrow({
      where: { id: caseId },
      select: { status: true, betId: true },
    });
    if (atual.status !== "OPEN") {
      throw new RecusaDeNegocioError(`Caso ${caseId} não está aberto (status ${atual.status}).`);
    }
    if (atual.betId) await tx.$queryRaw`SELECT id FROM bets WHERE id = ${atual.betId} FOR UPDATE`;
    const resolvedAt = new Date();
    const retryAfter = new Date(resolvedAt.getTime() + TRAINING_REVIEW_DEFER_MS);
    const claimed = await tx.trainingCase.updateMany({
      where: { id: caseId, status: "OPEN" },
      data: {
        status: "REJECTED",
        resolvedAt,
        resolutionEvidence: {
          version: 1,
          source: isDelegatedActor(actor) ? "agent" : "human",
          action: "deferred",
          retryAfter: retryAfter.toISOString(),
        },
      },
    });
    if (claimed.count !== 1) throw new Error(`Caso ${caseId} foi alterado por outra execução.`);
    if (atual.betId) {
      await tx.betSharp.updateMany({
        where: { betId: atual.betId, identityStatus: { in: ["PENDING", "UNMATCHED"] } },
        data: { identityStatus: "PENDING", identityResolvedAt: null },
      });
      await tx.iaJudgeCooldown.upsert({
        where: { key: TRAINING_REVIEW_COOLDOWN_KEY(atual.betId) },
        create: {
          key: TRAINING_REVIEW_COOLDOWN_KEY(atual.betId),
          reason: "training_review_deferred",
          expiresAt: retryAfter,
        },
        update: { reason: "training_review_deferred", expiresAt: retryAfter },
      });
    }
    await tx.auditEvent.create({
      data: {
        actor,
        action: "training_case.defer",
        resource: "training_case",
        resourceId: caseId,
        details: { betId: atual.betId, retryAfter: retryAfter.toISOString(), ...(reason ? { reason } : {}) },
      },
    });
  }, options);
}
