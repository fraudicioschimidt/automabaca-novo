import "server-only";
import type { Prisma } from "@/src/generated/prisma/client";
import { PENDENCIAS_SHARP_LIMITE } from "@/src/domain/recorte-de-lista";
import { prisma } from "@/src/infra/prisma";
import { trainingCaseDueForOwnerWhere } from "@/src/services/sharp/enrich/training-cases";

/**
 * Filas de trabalho do operador: identidade sharp pendente e casos de treino
 * abertos. Cada lista visível anda com o `count` do mesmo `where`, porque o
 * painel existe para detectar backlog e o tamanho da página não é o total. O
 * caso de treino só entra quando já é trabalho do dono
 * (`trainingCaseDueForOwnerWhere`); antes disso o revival ainda tenta sozinho.
 */

const SHARP_PENDENTE_WHERE: Prisma.BetSharpWhereInput = {
  identityStatus: { in: ["PENDING", "UNMATCHED"] },
  bet: { deletedAt: null },
};

const CASOS_ABERTOS_LIMITE = 20;

export function countSharpPendentes(): Promise<number> {
  return prisma.betSharp.count({ where: SHARP_PENDENTE_WHERE });
}

export function countCasosAbertos(now = new Date()): Promise<number> {
  return prisma.trainingCase.count({ where: trainingCaseDueForOwnerWhere(now) });
}

/**
 * Página das pendências de identidade, o jogo mais antigo primeiro. Pela
 * tentativa (`updatedAt`), reprocessar mandava a aposta para o fim da fila.
 */
export function getSharpPendentes(now = new Date()) {
  return prisma.betSharp.findMany({
    where: SHARP_PENDENTE_WHERE,
    orderBy: [{ bet: { data: "asc" } }, { betId: "asc" }],
    take: PENDENCIAS_SHARP_LIMITE,
    select: {
      betId: true,
      updatedAt: true,
      identityStatus: true,
      bet: {
        select: {
          evento: true, esporte: true, data: true,
          // Com caso de treino aberto, a sem par se resolve em Vincular.
          trainingCases: { where: trainingCaseDueForOwnerWhere(now), select: { id: true }, take: 1 },
        },
      },
    },
  });
}

/** Página dos casos de treino abertos, o jogo mais antigo primeiro; caso sem aposta vai ao fim. */
export function getCasosAbertos(now = new Date()) {
  return prisma.trainingCase.findMany({
    where: trainingCaseDueForOwnerWhere(now),
    orderBy: [{ bet: { data: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
    take: CASOS_ABERTOS_LIMITE,
    select: {
      id: true,
      betId: true,
      evento: true,
      esporte: true,
      competicao: true,
      candidatesJson: true,
      llmVerdictJson: true,
      bet: { select: { data: true } },
    },
  });
}

/**
 * A aposta que a Pinnacle não casou cai nas duas filas (caso de treino aberto e
 * `UNMATCHED`). O "Precisa de você" soma as filas menos a interseção, e só o
 * servidor vê as duas completas para medi-la.
 */
export async function getMatchingOverlap(now = new Date()): Promise<{ semMatchTotal: number; sobrepostos: number }> {
  const [semMatchTotal, sobrepostos] = await Promise.all([
    prisma.betSharp.count({ where: { identityStatus: "UNMATCHED", bet: { deletedAt: null } } }),
    prisma.betSharp.count({
      where: {
        identityStatus: "UNMATCHED",
        bet: { deletedAt: null, trainingCases: { some: trainingCaseDueForOwnerWhere(now) } },
      },
    }),
  ]);
  return { semMatchTotal, sobrepostos };
}
