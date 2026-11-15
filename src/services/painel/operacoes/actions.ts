import {
  OperationalActionStatus,
  type Prisma,
} from "@/src/generated/prisma/client";
import {
  ACTIVE_OPERATIONAL_ACTION_STATUSES,
  isActiveOperationalActionStatus,
} from "@/src/domain/operational-action-status";
import {
  ACOES_POR_ABA,
  ordemDaAba,
  ORDEM_POR_CRITERIO,
  type CriterioDeRecorte,
} from "@/src/domain/recorte-da-caixa-de-acoes";
import { prisma } from "@/src/infra/prisma";

const actionSelect = {
  id: true,
  area: true,
  actionType: true,
  fingerprint: true,
  title: true,
  description: true,
  priority: true,
  risk: true,
  status: true,
  owner: true,
  resource: true,
  resourceId: true,
  evidence: true,
  occurrenceCount: true,
  openedAt: true,
  reopenCount: true,
  lastSeenAt: true,
  resolvedAt: true,
  resolutionNote: true,
} satisfies Prisma.OperationalActionSelect;

/**
 * A ordem sai do critério da aba (`domain/recorte-da-caixa-de-acoes`), nunca de
 * um literal aqui: com teto de linhas, ordenar é escolher o que existe. O
 * `satisfies` é a prova, neste lado, de que aquilo é um `orderBy` válido.
 */
ORDEM_POR_CRITERIO satisfies Record<
  CriterioDeRecorte,
  ReadonlyArray<Prisma.OperationalActionOrderByWithRelationInput>
>;

async function getActionPage() {
  const pages = await Promise.all([
    prisma.operationalAction.findMany({
      where: { status: OperationalActionStatus.OPEN },
      orderBy: [...ordemDaAba("OPEN")],
      take: ACOES_POR_ABA,
      select: actionSelect,
    }),
    prisma.operationalAction.findMany({
      where: {
        status: {
          in: [OperationalActionStatus.ACKED, OperationalActionStatus.RUNNING],
        },
      },
      orderBy: [...ordemDaAba("ACKED")],
      take: ACOES_POR_ABA,
      select: actionSelect,
    }),
    prisma.operationalAction.findMany({
      where: { status: { notIn: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] } },
      orderBy: [...ordemDaAba("RESOLVED")],
      take: ACOES_POR_ABA,
      select: actionSelect,
    }),
  ]);
  return pages.flat().map((row) => row.status === OperationalActionStatus.RUNNING
    ? { ...row, status: OperationalActionStatus.ACKED }
    : row);
}

/** Caixa completa da superfície canônica `/monitoramento`. */
export async function getPainelOperationalActions() {
  const [acoes, grupos] = await Promise.all([
    getActionPage(),
    prisma.operationalAction.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);
  const counts = new Map(grupos.map((grupo) => [grupo.status, grupo._count._all]));
  const abertas = counts.get(OperationalActionStatus.OPEN) ?? 0;
  const assumidas = (counts.get(OperationalActionStatus.ACKED) ?? 0)
    + (counts.get(OperationalActionStatus.RUNNING) ?? 0);
  const encerradas = grupos
    .filter((grupo) => !isActiveOperationalActionStatus(grupo.status))
    .reduce((total, grupo) => total + grupo._count._all, 0);

  return {
    acoes,
    totais: {
      abertas,
      assumidas,
      encerradas,
      acionaveis: abertas + assumidas,
    },
  };
}
