import type { Prisma } from "@/src/generated/prisma/client";
import { toNumber } from "@/src/domain/money";
import { prisma } from "@/src/infra/prisma";

/**
 * O resultado externo da aposta mora em `bet_result`: placar, o jogo casado no
 * FlashScore e a última leitura dele. O preço de fechamento fica em
 * `bet_closing`, cujas colunas de resultado não são mais escritas nem lidas.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Grava o placar uma vez só. A linha nasce se a aposta existe, não foi removida
 * e tem o esporte confirmado; o placar entra só onde ainda não há um, e o
 * UPDATE condicional re-checa o filtro depois do lock, então de duas escritas
 * concorrentes só uma grava.
 */
export async function writeScoreOnce(
  betId: string,
  score: { scoreHome: number; scoreAway: number },
  opts: {
    /** Só grava com a aposta já liquidada: o placar não reabre corrida com a reabertura. */
    requireNotPending?: boolean;
    client?: Db;
  } = {},
): Promise<boolean> {
  const db = opts.client ?? prisma;
  await db.$executeRaw`
    INSERT INTO bet_result ("betId", "updatedAt")
    SELECT b.id, now()
    FROM bets b
    WHERE b.id = ${betId}
      AND b."deletedAt" IS NULL
      AND b."sportResolutionStatus" = 'CONFIRMED'
    ON CONFLICT ("betId") DO NOTHING
  `;
  const updated = await db.betResult.updateMany({
    where: {
      betId,
      scoreHome: null,
      bet: {
        deletedAt: null,
        sportResolutionStatus: "CONFIRMED",
        ...(opts.requireNotPending ? { status: { not: "PENDING" } } : {}),
      },
    },
    data: score,
  });
  return updated.count > 0;
}

/** Vincula o jogo do FlashScore antes do resultado: enrich e prop de jogador. */
export async function linkFlashscoreMatch(db: Db, betId: string, matchId: string): Promise<void> {
  await db.betResult.upsert({
    where: { betId },
    create: { betId, resultProvider: "flashscore", resultMatchId: matchId },
    update: { resultProvider: "flashscore", resultMatchId: matchId },
  });
}

/** Preserva a prova normalizada antes de invalidar a leitura operacional. */
export async function readSettlementEvidenceTx(tx: Prisma.TransactionClient, betId: string): Promise<Prisma.InputJsonObject> {
  const result = await tx.betResult.findUnique({ where: { betId }, select: {
    scoreHome: true, scoreAway: true, resultProvider: true, resultMatchId: true,
    resultMatchConfidence: true, resultSnapshot: true, resultCheckedAt: true, resultFinal: true,
  } });
  const playerProp = await tx.betPlayerProp.findUnique({ where: { betId }, select: {
    terms: true, rule: true, revision: true, evidence: true, playerIdentityId: true,
    providerMatchId: true, resolutionStatus: true,
  } });
  return {
    result: result ? {
      ...result,
      resultMatchConfidence: result.resultMatchConfidence === null ? null : toNumber(result.resultMatchConfidence),
      resultCheckedAt: result.resultCheckedAt?.toISOString() ?? null,
    } : null,
    playerProp,
  };
}
