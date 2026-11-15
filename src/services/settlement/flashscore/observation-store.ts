import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import type { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";
import { chavePlacar, type ObservacaoAnterior } from "@/src/providers/flashscore/terminal";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";
import { assertBetSettlementTermsTx, type BetSettlementTerms } from "@/src/services/bets/settle-terms";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import type { FlashscoreIdentitySearch, FlashscoreMatchSource } from "./match-identity";
import type { FlashscoreSettlementOutcome } from "./match-outcome";
import { POSTPONED_VOID_GRACE_MS, type FlashscorePair } from "./settle";

/**
 * A observação FlashScore de cada aposta em `bet_result`: quem está na fila,
 * como a leitura é gravada e como o snapshot gravado é lido de volta.
 */

/** Ritmo econômico para evento que ainda não casou no FlashScore. */
const OBSERVATION_THROTTLE_MS = 6 * 60 * 60_000;
/** Quanto tempo depois do jogo a aposta ainda é olhada. */
const MAX_LOOKBACK_MS = 30 * 86_400_000;
/** Primeira olhada: cedo o bastante para ver o fim de jogos curtos. */
const FINISH_GRACE_MS = 90 * 60_000;
/**
 * Ritmo ATENTO enquanto o FlashScore já casou o evento e falta só o placar: a
 * população é pequena por definição, e cada ciclo perdido atrasa a única fonte
 * externa de resultado.
 */
const OBSERVATION_RETRY_MS = 10 * 60_000;

/**
 * Janela da conferência das liquidações do IA-Judge. Depois de uma semana o
 * dono já revisou a aposta, e cada dia a mais na fila gasta cota à toa.
 */
const IA_CROSSCHECK_WINDOW_MS = 7 * 86_400_000;
const IA_CROSSCHECK_STATUSES = ["WON", "LOST", "HALF_WON", "HALF_LOST", "VOID"] as const;

export async function listFlashscoreEligibleBets(params: {
  now: Date;
}): Promise<EligibleBet[]> {
  const staleBefore = new Date(params.now.getTime() - OBSERVATION_THROTTLE_MS);
  const retryBefore = new Date(params.now.getTime() - OBSERVATION_RETRY_MS);
  const settledByIa = await lastSettledByIaJudge(new Date(params.now.getTime() - IA_CROSSCHECK_WINDOW_MS));
  const rows = await prisma.bet.findMany({
    where: {
      deletedAt: null,
      sportResolutionStatus: "CONFIRMED",
      kickoffInferido: false,
      data: {
        gte: new Date(params.now.getTime() - MAX_LOOKBACK_MS),
        lte: new Date(params.now.getTime() - FINISH_GRACE_MS),
      },
      AND: [{
        OR: [
          { status: "PENDING" },
          // Liquidada pelo IA-Judge antes de o FlashScore fechar a observação:
          // segue na fila para conferência (`crossCheckSettledBet`), só alerta.
          { status: { in: [...IA_CROSSCHECK_STATUSES] }, id: { in: settledByIa } },
        ],
      }],
      OR: [
        { result: null },
        {
          result: {
            is: {
              resultFinal: false,
              OR: [
                { resultCheckedAt: null },
                // JÁ CASADO e ainda sem placar final: insiste a cada 10min.
                {
                  AND: [
                    { resultMatchId: { not: null } },
                    { resultCheckedAt: { lte: retryBefore } },
                  ],
                },
                // Sem casar (nome divergente, evento fora do catálogo): ritmo
                // econômico — um nome que não vai se corrigir sozinho queima cota.
                { resultCheckedAt: { lte: staleBefore } },
              ],
            },
          },
        },
        // Múltipla sem match_id: a olhada de um bilhete não pode esperar 6h.
        {
          AND: [
            {
              OR: [
                { legsJson: { path: ["kind"], equals: "parlay" } },
                { evento: { contains: " | " } },
              ],
            },
            {
              result: {
                is: {
                  resultFinal: false,
                  resultMatchId: null,
                  resultCheckedAt: { lte: retryBefore },
                },
              },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      manualSettlementVersion: true,
      casaDeAposta: true,
      playerProp: { select: { revision: true } },
      evento: true,
      esporte: true,
      competicao: true,
      pais: true,
      mercado: true,
      selecao: true,
      legsJson: true,
      liveScoreHome: true,
      liveScoreAway: true,
      odds: true,
      stake: true,
      status: true,
      data: true,
      registradoEm: true, sourcePostedAt: true,
      kickoffInferido: true,
      liveTextAtCapture: true,
      sharp: { select: { provider: true, providerMatchId: true, identityStatus: true } },
      closing: {
        select: {
          fetchedAt: true,
          clv: true,
          closingOdd: true,
          lateRefreshedAt: true,
        },
      },
      result: {
        select: {
          scoreHome: true,
          // Leitura ANTERIOR: nos esportes sem flag terminal é a comparação
          // entre duas observações que separa "acabou" de "placar parcial".
          resultSnapshot: true,
          resultCheckedAt: true,
          resultProvider: true,
          resultMatchId: true,
          resultFinal: true,
        },
      },
    },
    orderBy: [{ data: "asc" }, { id: "asc" }],
    take: 250,
  });
  return rows.map((row) => ({ ...row, playerPropRevision: row.playerProp?.revision }));
}

/**
 * Apostas com sugestão aprovada desde `since` cuja ÚLTIMA mudança de status
 * veio do IA-Judge. Se o dono corrigiu depois, a decisão já é dele e não há o
 * que conferir. Sai antes do `take` da fila: filtradas depois dele, as
 * corrigidas ocupavam o lote e as pendentes mais novas não entravam.
 */
async function lastSettledByIaJudge(since: Date): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ betId: string }>>`
    SELECT DISTINCT s."betId"
    FROM "ia_judge_suggestions" s
    CROSS JOIN LATERAL (
      SELECT e.payload->>'source' AS source
      FROM "settlement_events" e
      WHERE e."betId" = s."betId" AND e.type = 'STATUS_CHANGED'
      ORDER BY e."createdAt" DESC, e.id DESC
      LIMIT 1
    ) last
    WHERE s.status = 'APPROVED' AND s."resolvedAt" >= ${since} AND last.source LIKE 'ia-judge:%'
  `;
  return rows.map((row) => row.betId);
}

/**
 * Apostas de jogo adiado que o FlashScore ainda espera remarcar (48 h desde o
 * apito): não falta liquidá-las, e anular à mão divergiria da casa se o jogo
 * acontecer. O bilhete conta a perna adiada em `postponedWaiting`; a graça dela
 * conta do começo da perna, e a lista, do `data` do bilhete. A busca é positiva porque `NOT (json.path = valor)`
 * é trivalente e esconderia junto os snapshots sem a chave.
 */
export async function listPostponedWaitingBetIds(now: Date): Promise<string[]> {
  const rows = await prisma.betResult.findMany({
    where: {
      bet: { is: { data: { gt: new Date(now.getTime() - POSTPONED_VOID_GRACE_MS) } } },
      OR: [
        { resultSnapshot: { path: ["settlementOutcome"], equals: "postponed_waiting" } },
        { resultSnapshot: { path: ["postponedWaiting"], gt: 0 } },
      ],
    },
    select: { betId: true },
  });
  return rows.map((row) => row.betId);
}

/**
 * Grava na aposta a primeira olhada do FlashScore, uma vez só, na transação de
 * quem grava a observação, antes de gravar a leitura nova: o casamento do dia
 * conta a aposta por ela. A aposta que já estava em observação quando a coluna
 * nasceu fica com a leitura anterior. SQL direto porque o `update` do Prisma
 * trocaria o `updatedAt` da aposta, e a sugestão do IA-Judge feita antes
 * ficaria desatualizada sem os termos mudarem.
 */
export async function recordFlashscoreFirstCheckTx(
  tx: Prisma.TransactionClient,
  betId: string,
  checkedAt: Date,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE bets b SET "flashscoreFirstCheckedAt" = COALESCE(
      (SELECT r."resultCheckedAt" FROM bet_result r WHERE r."betId" = b.id),
      ${checkedAt}
    )
    WHERE b.id = ${betId} AND b."flashscoreFirstCheckedAt" IS NULL
  `;
}

export async function persistFlashscoreObservation(params: {
  bet: BetSettlementTerms;
  checkedAt: Date;
  matchId?: string;
  /**
   * Solta o jogo vinculado antes, se ele ainda for este: a olhada o recusou
   * pelo horário. Vínculo gravado por outro caminho no meio fica.
   */
  releaseMatchId?: string;
  confidence?: number;
  final: boolean;
  snapshot: Prisma.InputJsonValue;
}): Promise<void> {
  await runSerializableTransaction("flashscoreObservation", async (tx) => {
    await assertBetSettlementTermsTx(tx, params.bet, { allowSettledTransition: true });
    const release = params.releaseMatchId !== undefined
      && (await tx.betResult.findUnique({ where: { betId: params.bet.id }, select: { resultMatchId: true } }))
        ?.resultMatchId === params.releaseMatchId;
    // Esporte fora da cobertura não é olhada de jogo: não entra no casamento do dia.
    const outcome = jsonObject(params.snapshot)?.outcome;
    if (typeof outcome !== "string" || !FLASHSCORE_UNCOVERED_OUTCOMES.includes(outcome)) {
      await recordFlashscoreFirstCheckTx(tx, params.bet.id, params.checkedAt);
    }
    await tx.betResult.upsert({
      where: { betId: params.bet.id },
      create: {
        betId: params.bet.id,
        resultProvider: "flashscore",
        resultMatchId: params.matchId,
        resultMatchConfidence: params.confidence,
        resultSnapshot: params.snapshot,
        resultCheckedAt: params.checkedAt,
        resultFinal: params.final,
      },
      update: {
        resultProvider: "flashscore",
        ...(params.matchId !== undefined ? { resultMatchId: params.matchId } : {}),
        resultMatchConfidence: params.confidence,
        ...(release ? { resultMatchId: null, resultMatchConfidence: null } : {}),
        resultSnapshot: params.snapshot,
        resultCheckedAt: params.checkedAt,
        resultFinal: params.final,
      },
    });
  });
}

export function buildFlashscoreMatchedSnapshot(params: {
  bet: { esporte: string };
  match: FlashscoreMatch;
  candidate: FlashscoreMatchCandidate;
  identitySearch: FlashscoreIdentitySearch;
  /** De onde veio o jogo: o vínculo anterior, a ligação dos catálogos ou a busca. */
  source: FlashscoreMatchSource;
  settlement: FlashscoreSettlementOutcome;
  anterior: ObservacaoAnterior | null;
  now: Date;
}): Record<string, unknown> {
  const { match, settlement } = params;
  return {
    outcome: "matched",
    settlementOutcome: settlement.settlementOutcome,
    sport: params.bet.esporte,
    stage: match.match_status.stage,
    cancelled: match.match_status.is_cancelled,
    postponed: match.match_status.is_postponed,
    finished: match.match_status.is_finished,
    placar: chavePlacar(match),
    placarDesde: placarEstavelDesde(chavePlacar(match), params.anterior, params.now),
    providerKickoff: new Date(match.timestamp * 1_000).toISOString(),
    providerTeams: {
      home: match.home_team.name,
      away: match.away_team.name,
      homeId: match.home_team.team_id,
      awayId: match.away_team.team_id,
      swapped: params.candidate.swapped,
    },
    identityResolution: {
      strategy: params.candidate.strategy,
      home: params.identitySearch.resolved.homeResolution.strategy,
      away: params.identitySearch.resolved.awayResolution.strategy,
      source: params.source,
    },
    score: settlement.score,
    ...(settlement.basketballFirstHalf ? { basketballFirstHalf: settlement.basketballFirstHalf } : {}),
    ...(settlement.regulationScore
      ? {
          regulationScore: settlement.regulationScore,
          regulationEvidence: settlement.regulationEvidence,
        }
      : {}),
    stats: settlement.stats,
    ...(settlement.stats ? { statsPeriod: settlement.statsPeriod } : {}),
    ...(settlement.goalscorer ? { goalscorer: settlement.goalscorer } : {}),
    ...(settlement.orderedGoalscorer
      ? { orderedGoalscorer: settlement.orderedGoalscorer }
      : {}),
    ...(settlement.playerProp ? { playerProp: settlement.playerProp } : {}),
  };
}

/**
 * Desfechos gravados para a aposta de esporte que o FlashScore não liquida: ele
 * não deixou de achar o jogo, o jogo está fora da cobertura dele. Os demais
 * desfechos sem `matched` são jogo que ele não achou.
 */
export const FLASHSCORE_UNCOVERED_OUTCOMES: readonly string[] = ["unsupported_sport", "sport_without_terminal_status"];

/** Objeto JSON comum (não array, não nulo) lido do `resultSnapshot`. */
export function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Leitura anterior gravada: nos esportes inferidos, a estabilidade vem dela. */
export function observacaoAnterior(
  result: { resultSnapshot?: unknown; resultCheckedAt?: Date | null } | null | undefined,
): ObservacaoAnterior | null {
  const checkedAt = result?.resultCheckedAt;
  if (!checkedAt) return null;
  return readStoredScore(jsonObject(result?.resultSnapshot), checkedAt);
}

/** `placar`/`placarDesde` de uma leitura gravada; sem `placarDesde` válido, vale a hora da leitura. */
function readStoredScore(reading: Record<string, unknown> | null, checkedAt: Date): ObservacaoAnterior | null {
  if (!reading || typeof reading.placar !== "string") return null;
  const marked = typeof reading.placarDesde === "string" ? new Date(reading.placarDesde) : null;
  const since = marked && Number.isFinite(marked.getTime()) ? marked : checkedAt;
  return { placar: reading.placar, desde: since };
}

/**
 * A leitura anterior de cada confronto de uma múltipla, pelo `match_id`: o
 * snapshot do bilhete guarda `placares: { [matchId]: { placar, placarDesde } }`.
 */
export function previousTicketReadings(
  result: { resultSnapshot?: unknown; resultCheckedAt?: Date | null } | null | undefined,
): Map<string, ObservacaoAnterior> {
  const readings = new Map<string, ObservacaoAnterior>();
  const checkedAt = result?.resultCheckedAt;
  const byMatch = jsonObject(jsonObject(result?.resultSnapshot)?.placares);
  if (!checkedAt || !byMatch) return readings;
  for (const [matchId, stored] of Object.entries(byMatch)) {
    const previous = readStoredScore(jsonObject(stored), checkedAt);
    if (previous) readings.set(matchId, previous);
  }
  return readings;
}

export function placarEstavelDesde(
  placarAgora: string | null,
  anterior: ObservacaoAnterior | null,
  agora: Date,
): string | null {
  if (placarAgora === null) return null;
  return anterior && anterior.placar === placarAgora
    ? anterior.desde.toISOString()
    : agora.toISOString();
}

export function regulationScoreFromSnapshot(
  resultSnapshot: unknown,
): FlashscorePair | null {
  const score = jsonObject(jsonObject(resultSnapshot)?.regulationScore);
  if (
    !score ||
    !Number.isInteger(score.home) ||
    !Number.isInteger(score.away) ||
    (score.home as number) < 0 ||
    (score.away as number) < 0
  ) {
    return null;
  }
  return { home: score.home as number, away: score.away as number };
}

/** O placar/estatísticas gerais podem incluir prorrogação ou pênaltis. */
export function isNonRegulationFlashscoreSnapshot(resultSnapshot: unknown): boolean {
  const snapshot = jsonObject(resultSnapshot);
  if (!snapshot) return false;
  if (snapshot.settlementOutcome === "manual_extra_time") return true;
  return (
    typeof snapshot.stage === "string" &&
    /extra\s*time|after\s+penalt|penalt|prorroga/i.test(snapshot.stage)
  );
}
