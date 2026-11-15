import { spDayKey } from "@/src/domain/dates";
import { classifySettlementSource } from "@/src/domain/production-write-actors";
import { Prisma } from "@/src/generated/prisma/client";
import { DAILY_METRIC } from "@/src/infra/operational-metrics";
import { prisma } from "@/src/infra/prisma";
import { TRAINING_CASE_ACTION } from "@/src/services/ops/action-sources";
import { FLASHSCORE_UNCOVERED_OUTCOMES } from "@/src/services/settlement/flashscore/observation-store";
import { readCatalogDay, type CatalogDaySummary } from "@/src/services/teams/catalog-links";

/**
 * O casamento de jogos de um dia de São Paulo: o bloco "Casamento" do resumo
 * das 00:05 e a série diária em `operational_metrics`, que compara semanas antes
 * e depois de uma mudança nos aliases. Cada número conta pelo instante já
 * gravado do que mede: no FlashScore cada aposta entra em um dia só, o da
 * primeira olhada; no Vincular, o caso conta quando entra na caixa e quando
 * volta a ela. A consulta está em `docs/OBSERVABILIDADE.md` ("Casamento do dia").
 */

type Day = { start: Date; end: Date };

export type MatchingDay = {
  /** Apostas cujo caso de treino entrou na fila Vincular do dono no dia. */
  trainingQueueBets: number;
  /** Apostas liquidadas no dia, por quem as tirou de pendente. */
  settled: { automatic: number; manual: number };
  flashscore: {
    /** Apostas que o FlashScore olhou pela primeira vez no dia. */
    looked: number;
    /** Das olhadas, as que ele não achou, pelo desfecho da última leitura. */
    notFoundByReason: Record<string, number>;
    /** Das não achadas, as que ele não achou mesmo com o id dos dois times. */
    notFoundWithBothTeamIds: number;
    /**
     * Das olhadas, as sem evidência na hora do resumo: a correção, o Vincular
     * ou a reabertura apagou a leitura, e ele ainda não olhou de novo.
     */
    evidenceErased: number;
  };
  /**
   * O pareamento dos catálogos (só gravando): jogos do dia ligados 1:1 e as
   * fichas de time, as que existem ao fim do dia e as que nasceram nele.
   */
  catalog: CatalogDaySummary;
};

const MATCHING_SERIES = "matching";

/**
 * Com os ids dos dois times, "sem candidato" e "nome pouco parecido" querem
 * dizer que o par não está no catálogo (ou que o id do store está errado). Em
 * `kickoff_mismatch` e `ambiguous` ele achou o par: a falha é de horário ou de
 * rodada dupla, não de identidade.
 */
const PAIR_MISSING_OUTCOMES: readonly string[] = ["no_candidate", "below_threshold"];

/**
 * O caso entra na fila Vincular quando a reconciliação de 5 min da caixa o vê
 * pela regra da tela (`trainingCaseDueForOwnerWhere`) e abre a ação dele, ou a
 * reabre quando ele volta. O instante fica gravado na ação: candidato que chega
 * depois ou kickoff que muda não desfazem a conta, e o caso resolvido antes de
 * virar ação, que o dono não chegou a ver, fica de fora.
 */
async function readTrainingQueueBets(day: Day, tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ bets: number }>>`
    SELECT count(DISTINCT t."betId")::int AS bets
    FROM operational_actions a
    JOIN training_cases t ON t.id = a."resourceId"
    WHERE a.resource = ${TRAINING_CASE_ACTION.resource}
      AND a."actionType" = ${TRAINING_CASE_ACTION.actionType}
      AND (
        (a."openedAt" >= ${day.start} AND a."openedAt" < ${day.end})
        OR (a."reopenedAt" >= ${day.start} AND a."reopenedAt" < ${day.end})
      )
  `;
  return row?.bets ?? 0;
}

/**
 * Liquidadas no dia pela mesma régua do "liquidada(s)" do resumo (`settledAt`).
 * O autor é quem tirou a aposta de pendente pela última vez: a correção depois
 * disso não troca o autor, e o IA-Judge aprovado pelo dono no painel é à mão.
 */
async function readSettled(day: Day, tx: Prisma.TransactionClient): Promise<MatchingDay["settled"]> {
  const rows = await tx.$queryRaw<Array<{ source: string | null; bets: number }>>`
    SELECT settling.source, count(*)::int AS bets
    FROM bets b
    LEFT JOIN LATERAL (
      SELECT e.payload->>'source' AS source
      FROM settlement_events e
      WHERE e."betId" = b.id AND e.type = 'STATUS_CHANGED'
        AND e.payload->>'from' = 'PENDING' AND e.payload->>'to' <> 'PENDING'
      ORDER BY e."createdAt" DESC, e.id DESC
      LIMIT 1
    ) settling ON true
    WHERE b."deletedAt" IS NULL AND b.status <> 'PENDING'
      AND b."settledAt" >= ${day.start} AND b."settledAt" < ${day.end}
    GROUP BY settling.source
  `;
  // A fonte automática não depende de quem é usuário do painel.
  const automatic = (source: string | null) =>
    source !== null && classifySettlementSource(source, new Set()) === "automatic";
  return {
    automatic: rows.filter((row) => automatic(row.source)).reduce((total, row) => total + row.bets, 0),
    manual: rows.filter((row) => !automatic(row.source)).reduce((total, row) => total + row.bets, 0),
  };
}

/**
 * Pela primeira olhada do FlashScore, gravada na aposta uma vez só
 * (`flashscoreFirstCheckedAt`): a aposta conta no dia em que ele a olhou pela
 * primeira vez, mesmo que isso tenha vindo tarde (esporte confirmado depois,
 * breaker aberto, fila cheia), com a última leitura até o resumo. A aposta cuja
 * evidência foi apagada e ainda não foi relida continua olhada, sem desfecho.
 * Esporte que ele não liquida fica de fora.
 */
async function readFlashscore(day: Day, tx: Prisma.TransactionClient): Promise<MatchingDay["flashscore"]> {
  const rows = await tx.$queryRaw<Array<{ outcome: string | null; bets: number; bothTeamIds: number }>>`
    SELECT r."resultSnapshot"->>'outcome' AS outcome,
      count(*)::int AS bets,
      count(*) FILTER (
        WHERE r."resultSnapshot"->'identityResolution'->>'providerIds' = '2'
      )::int AS "bothTeamIds"
    FROM bets b
    LEFT JOIN bet_result r ON r."betId" = b.id
    WHERE b."deletedAt" IS NULL
      AND b."flashscoreFirstCheckedAt" >= ${day.start} AND b."flashscoreFirstCheckedAt" < ${day.end}
      AND (
        r."resultSnapshot"->>'outcome' IS NULL
        OR r."resultSnapshot"->>'outcome' NOT IN (${Prisma.join(FLASHSCORE_UNCOVERED_OUTCOMES)})
      )
    GROUP BY 1
  `;
  const notFound = rows.flatMap((row) =>
    row.outcome !== null && row.outcome !== "matched" ? [{ ...row, outcome: row.outcome }] : []);
  return {
    looked: rows.reduce((total, row) => total + row.bets, 0),
    notFoundByReason: Object.fromEntries(notFound.map((row) => [row.outcome, row.bets])),
    notFoundWithBothTeamIds: notFound
      .filter((row) => PAIR_MISSING_OUTCOMES.includes(row.outcome))
      .reduce((total, row) => total + row.bothTeamIds, 0),
    evidenceErased: rows.find((row) => row.outcome === null)?.bets ?? 0,
  };
}

export async function readMatchingDay(day: Day): Promise<MatchingDay> {
  return prisma.$transaction(async (tx) => {
    const trainingQueueBets = await readTrainingQueueBets(day, tx);
    const settled = await readSettled(day, tx);
    const flashscore = await readFlashscore(day, tx);
    const catalog = await readCatalogDay(day, tx);
    return { trainingQueueBets, settled, flashscore, catalog };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}

/**
 * Grava o dia uma vez só, com `occurredAt` no início do dia que a linha
 * descreve: a retentativa do resumo não duplica a linha nem troca os números
 * das 00:05. Vai junto a taxa de jogos casados antes do início, do resumo.
 */
export async function recordMatchingDay(
  day: Day,
  matching: MatchingDay,
  identityBeforeKickoff: { casadas: number; total: number },
): Promise<void> {
  const labels = {
    day: spDayKey(day.start),
    ...matching,
    provenance: { version: 1, recordedAt: new Date().toISOString(), start: day.start.toISOString(), end: day.end.toISOString(),
      releaseSha: process.env.AUTOMABACA_RELEASE_SHA ?? "development" },
    identityBeforeKickoff: { matched: identityBeforeKickoff.casadas, total: identityBeforeKickoff.total },
  };
  await prisma.$transaction(async (tx) => {
    // Comandos separados: depois de esperar o lock, o INSERT lê um snapshot novo.
    // NOT EXISTS sozinho deixa dois workers gravarem a mesma linha.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'daily:matching:' + day.start.toISOString()}, 0))`;
    await tx.$executeRaw`
      INSERT INTO operational_metrics (kind, name, outcome, labels, "occurredAt")
      SELECT ${DAILY_METRIC.kind}, ${MATCHING_SERIES}, ${DAILY_METRIC.outcome}, ${JSON.stringify(labels)}::jsonb, ${day.start}
      WHERE NOT EXISTS (
        SELECT 1 FROM operational_metrics
        WHERE kind = ${DAILY_METRIC.kind} AND name = ${MATCHING_SERIES} AND "occurredAt" = ${day.start}
      )
    `;
  });
}
