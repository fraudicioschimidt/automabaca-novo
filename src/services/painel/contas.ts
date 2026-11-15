import "server-only";
import { sumMoneyBy, toNumber } from "@/src/domain/money";
import type { ContaStatus, MovimentacaoTipo, Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";

/** Dados da página de Contas — agrupados por titular (prestação de contas). */

export type MovimentacaoRow = {
  id: string;
  tipo: MovimentacaoTipo;
  valor: number;
  saldoApos: number;
  descricao: string | null;
  data: Date;
  betId: string | null;
};

export type ContaResumo = {
  id: string;
  casaDeAposta: string;
  apelido: string | null;
  status: ContaStatus;
  saldoAtual: number;
  depositado: number;
  sacado: number;
  resultadoApostas: number;
  movimentacoes: MovimentacaoRow[];
};

// ───────────── Página de Contas (status + cards) ─────────────

export type ContaCard = ContaResumo & {
  titular: string;
  /** P&L de caixa da conta: saldo + saques − depósitos. */
  lucroLiquido: number;
  apostasVinculadas: number;
  bancas: string[];
  /** IDs dos bankrolls vinculados (para pré-marcar na edição). */
  bancaIds: string[];
  /** Data de abertura da conta (createdAt). */
  aberta: Date;
  /** Última movimentação (ou updatedAt se não houver movimentações). */
  atualizada: Date;
  /** Total histórico de movimentações; `movimentacoes` contém só as 60 mais recentes. */
  movimentacoesTotal: number;
  /** Instante exato da última transição para LIMITADA, quando ainda retido na auditoria. */
  limitadaEm: Date | null;
};

export type ContasPageData = {
  summary: {
    total: number;
    ativas: number;
    limitadas: number;
    encerradas: number;
    saldoGeral: number;
    saldoAtivas: number;
    saldoLimitadas: number;
  };
  ativas: ContaCard[];
  limitadas: ContaCard[];
  encerradas: ContaCard[];
};

const CONTA_SELECT = {
  id: true,
  casaDeAposta: true,
  titular: true,
  apelido: true,
  status: true,
  saldoAtual: true,
  createdAt: true,
  updatedAt: true,
  bankrollLinks: {
    select: { bankroll: { select: { id: true, nome: true } } },
  },
  _count: {
    select: {
      bets: { where: { deletedAt: null } },
      movimentacoes: true,
    },
  },
} satisfies Prisma.ContaSelect;

type ContaRow = Prisma.ContaGetPayload<{ select: typeof CONTA_SELECT }>;
type MovementRaw = Pick<Prisma.MovimentacaoGetPayload<object>, "id" | "tipo" | "valor" | "saldoApos" | "descricao" | "data" | "betId"> & { contaId: string };

/** O LIMIT por conta roda no PostgreSQL, antes de transferir as linhas ao Node. */
async function recentMovements(client: Prisma.TransactionClient, ids: string[]): Promise<Map<string, MovementRaw[]>> {
  const byAccount = new Map<string, MovementRaw[]>();
  if (!ids.length) return byAccount;
  const rows = await client.$queryRaw<MovementRaw[]>`
    SELECT recent.* FROM contas AS account
    CROSS JOIN LATERAL (
      SELECT id, "contaId", tipo, valor, "saldoApos", descricao, data, "betId"
      FROM movimentacoes WHERE "contaId" = account.id
      ORDER BY data DESC, id DESC LIMIT 60
    ) AS recent
    WHERE account.id = ANY(${ids}::text[])
    ORDER BY account.id, recent.data DESC, recent.id DESC
  `;
  for (const row of rows) {
    const list = byAccount.get(row.contaId) ?? [];
    list.push(row);
    byAccount.set(row.contaId, list);
  }
  return byAccount;
}

/** Dados da página: resumo por status + cards com vínculos. */
export async function getContasPageData(): Promise<ContasPageData> {
  // Saldo, contagens e extrato precisam ver o mesmo instante: um depósito
  // entre as leituras não pode aparecer como prejuízo fictício na conta.
  return prisma.$transaction(async (tx) => {
    const contas = await tx.conta.findMany({
      where: { deletedAt: null },
      orderBy: [{ casaDeAposta: "asc" }, { titular: "asc" }],
      select: CONTA_SELECT,
    });
    const limitadaIds = contas.filter((c) => c.status === "LIMITADA").map((c) => c.id);
    const totais = await totaisPorContaETipo(tx);
    const limitadasEm = await limitadasDesde(tx, limitadaIds);
    const movements = await recentMovements(tx, contas.map((c) => c.id));
    const cards = contas.map((c) =>
      contaCard(c, movements.get(c.id) ?? [], totais.get(c.id) ?? new Map<string, number>(), limitadasEm.get(c.id) ?? null));

    const por = (status: string) => cards.filter((c) => c.status === status);
    const ativas = por("ATIVA");
    const limitadas = por("LIMITADA");
    const encerradas = por("ENCERRADA");
    return {
      summary: {
        total: cards.length,
        ativas: ativas.length,
        limitadas: limitadas.length,
        encerradas: encerradas.length,
        saldoGeral: sumMoneyBy(cards, (c) => c.saldoAtual, 2),
        saldoAtivas: sumMoneyBy(ativas, (c) => c.saldoAtual, 2),
        saldoLimitadas: sumMoneyBy(limitadas, (c) => c.saldoAtual, 2),
      },
      ativas,
      limitadas,
      encerradas,
    };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}

/**
 * Totais por conta e tipo sobre o histórico COMPLETO, não a janela de 60 da
 * timeline: somar a janela erraria depositado/sacado/resultado depois de 60
 * lançamentos. groupBy agrega no banco, com _sum exato.
 */
async function totaisPorContaETipo(client: Prisma.TransactionClient): Promise<Map<string, Map<string, number>>> {
  const totaisRaw = await client.movimentacao.groupBy({
    by: ["contaId", "tipo"],
    where: { conta: { deletedAt: null } },
    _sum: { valor: true },
  });
  const totaisPorConta = new Map<string, Map<string, number>>();
  for (const t of totaisRaw) {
    const porTipo = totaisPorConta.get(t.contaId) ?? new Map<string, number>();
    porTipo.set(t.tipo, toNumber(t._sum.valor ?? 0));
    totaisPorConta.set(t.contaId, porTipo);
  }
  return totaisPorConta;
}

/** Instante da última passagem para LIMITADA de cada conta, pela auditoria. */
async function limitadasDesde(client: Prisma.TransactionClient, ids: string[]): Promise<Map<string, Date>> {
  const limitadasEm = new Map<string, Date>();
  if (ids.length === 0) return limitadasEm;
  const eventos = await client.auditEvent.findMany({
    where: { action: "conta.status", resource: "conta", resourceId: { in: ids } },
    orderBy: { createdAt: "desc" },
    select: { resourceId: true, details: true, createdAt: true },
  });
  for (const evento of eventos) {
    if (!evento.resourceId || limitadasEm.has(evento.resourceId)) continue;
    const details = evento.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    if ((details as Record<string, unknown>).status !== "LIMITADA") continue;
    limitadasEm.set(evento.resourceId, evento.createdAt);
  }
  return limitadasEm;
}

function contaCard(c: ContaRow, movements: MovementRaw[], tot: Map<string, number>, limitadaEm: Date | null): ContaCard {
  const movs = movements.map((m) => ({
    id: m.id,
    tipo: m.tipo,
    valor: toNumber(m.valor),
    saldoApos: toNumber(m.saldoApos),
    descricao: m.descricao,
    data: m.data,
    betId: m.betId,
  }));
  const soma = (tipos: string[]) =>
    sumMoneyBy(tipos.map((t) => ({ v: tot.get(t) ?? 0 })), (x) => x.v, 2);
  const saldo = toNumber(c.saldoAtual);
  // Bônus é ganho promocional, não capital aportado pelo operador. Misturá-lo
  // em depósitos subtrairia o crédito do lucro líquido e inflaria "aportes".
  const depositado = soma(["DEPOSITO"]);
  const sacado = Math.abs(soma(["SAQUE"]));
  const resultadoApostas = soma(["GANHO_APOSTA", "PERDA_APOSTA", "ESTORNO"]);
  // Lucro líquido de caixa: saldo + saques − depósitos, em BigInt-cents.
  const lucroLiquido = sumMoneyBy([saldo, sacado, -depositado].map((v) => ({ v })), (x) => x.v, 2);
  return {
    id: c.id,
    casaDeAposta: c.casaDeAposta,
    apelido: c.apelido,
    titular: c.titular,
    status: c.status,
    saldoAtual: saldo,
    depositado,
    sacado,
    resultadoApostas,
    lucroLiquido,
    apostasVinculadas: c._count.bets,
    bancas: c.bankrollLinks.map((l) => l.bankroll.nome),
    bancaIds: c.bankrollLinks.map((l) => l.bankroll.id),
    aberta: c.createdAt,
    atualizada: movs[0]?.data ?? c.updatedAt,
    movimentacoesTotal: c._count.movimentacoes,
    limitadaEm,
    movimentacoes: movs,
  };
}
