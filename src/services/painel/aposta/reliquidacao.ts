import "server-only";
import { Prisma } from "@/src/generated/prisma/client";
import { rotuloDaFonteDeLiquidacao } from "@/src/domain/trilha-da-aposta";
import { prisma } from "@/src/infra/prisma";

/**
 * Aposta cujo RESULTADO trocou depois de já estar liquidada (edição do post,
 * caixa de ações, recálculo). O operador vê só o resultado final; reconciliar o
 * ledger depende de enxergar a troca sem abrir aposta por aposta.
 *
 * A regra mora no banco, na função `settlement_event_is_resettlement(type,
 * payload)`: estas consultas e a trilha da aposta (`trilha.ts`) a chamam, e
 * nenhuma linguagem a repete. Um predicado copiado em SQL e em TypeScript podia
 * divergir num caso de borda e produzir um número plausível.
 */

/**
 * Quais destas apostas foram re-liquidadas. Recebe os ids EXIBIDOS em vez de
 * varrer a tabela: a base da resposta é a mesma base da tela.
 */
export async function apostasReliquidadas(betIds: readonly string[], client: Prisma.TransactionClient = prisma): Promise<Set<string>> {
  if (betIds.length === 0) return new Set();
  const linhas = await client.$queryRaw<Array<{ betId: string }>>`
    SELECT DISTINCT "betId"
    FROM settlement_events
    WHERE settlement_event_is_resettlement(type, payload)
      AND "betId" IN (${Prisma.join([...betIds])})
  `;
  return new Set(linhas.map((l) => l.betId));
}

export type ResumoDeReliquidacao = {
  /** Apostas distintas afetadas na janela — não eventos: uma aposta pode trocar duas vezes. */
  apostas: number;
  /** Quantas trocas houve, para o caso de uma aposta oscilar. */
  eventos: number;
  /**
   * As mais recentes, para a linha poder levar direto à ficha. `fonte` já vem
   * em PROSA. O cartão é client component: importar `trilha-da-aposta` lá
   * arrastaria o registro inteiro de narração para o bundle de /operacoes e
   * /monitoramento por UMA função de rótulo. Vocabulário de liquidação é
   * conhecimento do servidor.
   */
  recentes: Array<{ betId: string; evento: string; de: string; para: string; fonte: string; em: string }>;
};

export async function getResumoDeReliquidacao(desde: Date): Promise<ResumoDeReliquidacao> {
  const linhas = await prisma.$queryRaw<Array<{
    betId: string; evento: string; de: string; para: string; fonte: string; em: Date;
  }>>`
    SELECT se."betId"          AS "betId",
           b.evento            AS evento,
           se.payload->>'from' AS de,
           se.payload->>'to'   AS para,
           coalesce(se.payload->>'source', '') AS fonte,
           se."createdAt"      AS em
    FROM settlement_events se
    JOIN bets b ON b.id = se."betId" AND b."deletedAt" IS NULL
    WHERE settlement_event_is_resettlement(se.type, se.payload)
      AND se."createdAt" >= ${desde}
    ORDER BY se."createdAt" DESC
  `;
  return {
    apostas: new Set(linhas.map((l) => l.betId)).size,
    eventos: linhas.length,
    recentes: linhas.slice(0, 8).map((l) => ({
      betId: l.betId,
      evento: l.evento,
      de: l.de,
      para: l.para,
      fonte: rotuloDaFonteDeLiquidacao(l.fonte),
      em: l.em.toISOString(),
    })),
  };
}
