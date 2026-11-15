import "server-only";
import type { LinhaSemOdds } from "@/src/domain/lacuna-de-cobertura";
import { prisma } from "@/src/infra/prisma";

/**
 * Apostas sem odds por MOTIVO, nos três lados da ausência: `identidade`
 * (`bet_sharp`), `abertura` (`bet_opening`) e `fechamento` (`bet_closing`, onde
 * mora a perda de CLV). O `lado` vem na linha porque o mesmo motivo pede
 * conserto diferente em cada um.
 *
 * Agrupa só por motivo: por motivo × país × competição os grupos estilhaçavam e
 * qualquer corte escondia apostas. O segmento mais pesado de cada motivo segue
 * alcançável em `topoSegmento`.
 *
 * Só os jogos (`data`, o kickoff) desde `desde`: o motivo fica gravado na
 * aposta, e sem janela um defeito já consertado seguiria no cartão para sempre
 * e uma piora recente se diluiria no acumulado.
 */
export function getSemOddsPorMotivo(desde: Date): Promise<LinhaSemOdds[]> {
  return prisma.$queryRaw<LinhaSemOdds[]>`
    WITH grupos AS (
      SELECT 'identidade' AS lado, s."noOddsReason" AS reason, b.pais, b.competicao, count(*)::int AS n
      FROM bet_sharp s
      JOIN bets b ON b.id = s."betId"
      WHERE s."noOddsReason" IS NOT NULL AND b."deletedAt" IS NULL AND b.data >= ${desde}
      GROUP BY 1, 2, 3, 4
      UNION ALL
      SELECT 'abertura', o."noOpeningReason", b.pais, b.competicao, count(*)::int
      FROM bet_opening o
      JOIN bets b ON b.id = o."betId"
      WHERE o."noOpeningReason" IS NOT NULL AND b."deletedAt" IS NULL AND b.data >= ${desde}
      GROUP BY 1, 2, 3, 4
      UNION ALL
      SELECT 'fechamento', c."noOddsReason", b.pais, b.competicao, count(*)::int
      FROM bet_closing c
      JOIN bets b ON b.id = c."betId"
      WHERE c."noOddsReason" IS NOT NULL AND b."deletedAt" IS NULL AND b.data >= ${desde}
      GROUP BY 1, 2, 3, 4
    )
    SELECT lado, reason, sum(n)::int AS n, count(*)::int AS segmentos,
           (array_agg(
             NULLIF(concat_ws(' · ', NULLIF(pais, ''), NULLIF(competicao, '')), '')
             ORDER BY n DESC
           ))[1] AS "topoSegmento",
           (array_agg(n ORDER BY n DESC))[1]::int AS "topoN"
    FROM grupos
    GROUP BY 1, 2
    ORDER BY 3 DESC
  `;
}

/** Políticas de segmento (esporte × mercado) em probation ou ativas, as mais recentes primeiro. */
export function getSegmentPolicies() {
  return prisma.marketSegmentPolicy.findMany({
    orderBy: [{ phase: "desc" }, { updatedAt: "desc" }],
    take: 40,
  });
}
