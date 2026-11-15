import {
  type BetStatus,
  type MovimentacaoTipo,
  Prisma,
} from "@/src/generated/prisma/client";
import {
  LEDGER_MIN_AMOUNT,
  sumMoneyDecimal,
  toNumber,
  unitsToBrl,
} from "@/src/domain/money";

/**
 * Conta indisponível (soft-deletada) no meio de uma transição financeira. A
 * transação inteira aborta (status e ledger) e o erro sobe para o job: pular o
 * lançamento dessincronizaria o ledger do status da aposta.
 */
export class ContaIndisponivelError extends Error {
  readonly contaId: string;
  readonly betId: string;

  constructor(params: { contaId: string; betId: string; etapa: string }) {
    super(
      `Conta ${params.contaId} está soft-deletada — impossível lançar ${params.etapa} ` +
        `da aposta ${params.betId}. Restaure a conta ou desvincule a aposta.`,
    );
    this.name = "ContaIndisponivelError";
    this.contaId = params.contaId;
    this.betId = params.betId;
  }
}

function isRecordNotFoundError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025"
  );
}

/**
 * Tipo de lançamento por status. CASHOUT segue o sinal do lucro.
 * PENDING/VOID/CANCELED → null (só estorno do efeito anterior, sem lançamento).
 */
function tipoFromStatus(
  status: BetStatus,
  lucroUnidades: number,
): MovimentacaoTipo | null {
  switch (status) {
    case "WON":
    case "HALF_WON":
      return "GANHO_APOSTA";
    case "LOST":
    case "HALF_LOST":
      return "PERDA_APOSTA";
    case "CASHOUT":
      // Cashout no zero a zero não é ganho nem perda: sem efeito financeiro,
      // não há movimentação a criar.
      if (lucroUnidades === 0) return null;
      return lucroUnidades < 0 ? "PERDA_APOSTA" : "GANHO_APOSTA";
    default:
      return null;
  }
}

function describeBetOutcome(status: BetStatus): string {
  if (status === "WON" || status === "HALF_WON") return "ganha";
  if (status === "LOST" || status === "HALF_LOST") return "perdida";
  return "cashout";
}

function formatLedgerUnits(value: number): string {
  const rounded = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return rounded === "-0" ? "0" : rounded;
}

export type ProcessMovimentacaoFromBetParams = {
  betId: string;
  newStatus: BetStatus;
  /** Lucro em unidades (pode ser negativo). */
  lucroUnidades: number;
  /** R$ por unidade do bankroll. */
  valorUnidade: number;
  /** Quando conhecido, evita findUnique extra dentro da tx. */
  contaId?: string | null;
  /** Quem mudou o status (operador, agente); sem ele, o extrato grava "system". */
  actor?: string;
};

/**
 * Reconciliação financeira de uma mudança de status de aposta. Chamar DEPOIS
 * do `tx.bet.update`, dentro da MESMA transação.
 *
 * Invariante: `saldoAtual = Σ movimentações` (o saldo inicial já entra como
 * DEPOSITO na criação da conta). Um ESTORNO zera o efeito atual da aposta e só
 * então o novo status lança a movimentação nova: ciclos WON→LOST→WON não
 * contam duas vezes.
 */
export async function processMovimentacaoFromBetTx(
  tx: Prisma.TransactionClient,
  params: ProcessMovimentacaoFromBetParams,
): Promise<void> {
  const { betId, newStatus, lucroUnidades, valorUnidade } = params;

  // O adapter `pg` compartilha uma conexão por TransactionClient. Consultas
  // simultâneas nessa conexão disparam a depreciação de `client.query()` e
  // serão recusadas no pg@9; dentro da transação, I/O é deliberadamente serial.
  const bet = params.contaId !== undefined
    ? { contaId: params.contaId }
    : await tx.bet.findUnique({ where: { id: betId }, select: { contaId: true } });
  const movimentacoesDaAposta = await tx.movimentacao.findMany({
    where: { betId },
    select: { contaId: true, valor: true },
  });

  // 1. Estorna o efeito líquido por conta (ordenado — evita deadlock entre
  // transações concorrentes que tocam as mesmas contas em ordens diferentes).
  const netByContaId = new Map<string, number[]>();
  for (const movimentacao of movimentacoesDaAposta) {
    const bucket = netByContaId.get(movimentacao.contaId) ?? [];
    bucket.push(toNumber(movimentacao.valor));
    netByContaId.set(movimentacao.contaId, bucket);
  }

  for (const contaId of Array.from(netByContaId.keys()).sort()) {
    const netLiquido = sumMoneyDecimal(netByContaId.get(contaId) ?? [], 2);
    if (!Number.isFinite(netLiquido) || Math.abs(netLiquido) < LEDGER_MIN_AMOUNT) {
      continue;
    }
    const totalEstorno = -netLiquido;

    let contaAtualizada: { saldoAtual: unknown };
    try {
      contaAtualizada = await tx.conta.update({
        where: { id: contaId, deletedAt: null },
        data: { saldoAtual: { increment: totalEstorno } },
        select: { saldoAtual: true },
      });
    } catch (error) {
      if (!isRecordNotFoundError(error)) throw error;
      throw new ContaIndisponivelError({ contaId, betId, etapa: "estorno" });
    }

    await tx.movimentacao.create({
      data: {
        contaId,
        betId,
        tipo: "ESTORNO",
        valor: totalEstorno,
        saldoApos: toNumber(contaAtualizada.saldoAtual),
        descricao: `Estorno automático (status alterado para ${newStatus})`,
        actor: params.actor,
      },
    });
  }

  // 2. Lançamento novo (apenas status finais com conta vinculada).
  const tipo = tipoFromStatus(newStatus, lucroUnidades);
  const contaId = bet?.contaId ?? null;
  if (!tipo || !contaId) return;

  // Arredonda para centavos ANTES de usar: o mesmo valor vai para o saldo e
  // para a linha do extrato. Se o Postgres arredondasse cada um por si ("half
  // away from zero"), um lançamento negativo divergiria da linha em 1 centavo.
  const valor = unitsToBrl(lucroUnidades, valorUnidade);
  if (!Number.isFinite(valor)) {
    throw new Error(`Valor financeiro inválido na aposta ${betId}.`);
  }
  // Abaixo de meio centavo é ruído de arredondamento — não polui o extrato.
  if (Math.abs(valor) < LEDGER_MIN_AMOUNT) return;

  let contaAtualizada: { saldoAtual: unknown };
  try {
    contaAtualizada = await tx.conta.update({
      where: { id: contaId, deletedAt: null },
      data: { saldoAtual: { increment: valor } },
      select: { saldoAtual: true },
    });
  } catch (error) {
    if (!isRecordNotFoundError(error)) throw error;
    throw new ContaIndisponivelError({ contaId, betId, etapa: "lançamento" });
  }

  await tx.movimentacao.create({
    data: {
      contaId,
      betId,
      tipo,
      valor,
      saldoApos: toNumber(contaAtualizada.saldoAtual),
      descricao: `Aposta ${describeBetOutcome(newStatus)} — ${lucroUnidades >= 0 ? "+" : ""}${formatLedgerUnits(lucroUnidades)}u × R$${valorUnidade}`,
      actor: params.actor,
    },
  });
}
