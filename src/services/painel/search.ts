import "server-only";
import { ACTIVE_OPERATIONAL_ACTION_STATUSES, riskLabel } from "@/src/domain/operational-action-status";
import { rotuloDeStatus } from "@/src/domain/status-de-aposta";
import { prisma } from "@/src/infra/prisma";

export type PanelSearchResult = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
};

export async function searchPanel(query: string): Promise<PanelSearchResult[]> {
  // O `contains` insensível do Prisma vira ILIKE sem escape: "%" e "_" seriam
  // curingas e uma barra invertida no fim escaparia o curinga final.
  const pattern = query.replace(/[\\%_]/g, "\\$&");
  const [bankrolls, bets, contas, actions] = await Promise.all([
    prisma.bankroll.findMany({
      where: { nome: { contains: pattern, mode: "insensitive" } },
      select: { id: true, nome: true, slug: true },
      take: 5,
    }),
    prisma.bet.findMany({
      where: {
        deletedAt: null,
        OR: [
          { evento: { contains: pattern, mode: "insensitive" } },
          { selecao: { contains: pattern, mode: "insensitive" } },
          { competicao: { contains: pattern, mode: "insensitive" } },
        ],
      },
      select: { id: true, evento: true, mercado: true, selecao: true, status: true },
      orderBy: { data: "desc" },
      take: 7,
    }),
    prisma.conta.findMany({
      where: {
        deletedAt: null,
        OR: [
          { casaDeAposta: { contains: pattern, mode: "insensitive" } },
          { titular: { contains: pattern, mode: "insensitive" } },
          { apelido: { contains: pattern, mode: "insensitive" } },
        ],
      },
      select: { id: true, casaDeAposta: true, titular: true, apelido: true },
      take: 5,
    }),
    prisma.operationalAction.findMany({
      where: {
        status: { in: [...ACTIVE_OPERATIONAL_ACTION_STATUSES] },
        OR: [
          { title: { contains: pattern, mode: "insensitive" } },
          { description: { contains: pattern, mode: "insensitive" } },
        ],
      },
      select: { id: true, title: true, area: true, risk: true },
      orderBy: [{ priority: "desc" }, { lastSeenAt: "desc" }],
      take: 5,
    }),
  ]);

  return [
    ...bankrolls.map((row) => ({ id: `bankroll:${row.id}`, kind: "Tipster", title: row.nome, detail: "Abrir painel do tipster", href: `/tipsters/${row.slug}` })),
    ...bets.map((row) => ({ id: `bet:${row.id}`, kind: "Aposta", title: row.evento, detail: `${row.mercado} · ${row.selecao} · ${rotuloDeStatus(row.status)}`, href: `/aposta?id=${row.id}` })),
    ...contas.map((row) => ({ id: `conta:${row.id}`, kind: "Conta", title: row.apelido || row.casaDeAposta, detail: `${row.casaDeAposta} · ${row.titular}`, href: `/contas?acc=${row.id}` })),
    ...actions.map((row) => ({ id: `action:${row.id}`, kind: "Ação", title: row.title, detail: `${row.area} · risco ${riskLabel(row.risk)}`, href: "/monitoramento" })),
  ];
}
