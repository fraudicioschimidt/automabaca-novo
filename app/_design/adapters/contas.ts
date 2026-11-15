import "server-only";
import { formatSpDateTime, formatSpDateWithYear } from "@/src/domain/dates";
import { getContasPageData, type ContaCard } from "@/src/services/painel/contas";
import { getBankrollsTips } from "@/src/services/painel/queries/bankrolls";

/** Contas de casa de aposta para ContasScreen. Mock: app/_design/mock/contas.ts. */

// Cor estável por casa (o schema não guarda cor) — espelha a paleta do design.
const PALETTE = [
  "#1f6f4a", "#0a7d4b", "#b83a1b", "#a8192a", "#2f5fc4",
  "#704fe8", "#11734e", "#5b6470", "#0e7490", "#785822",
];
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? "#5b6470";
}

/** Status como a tela mostra. */
export type ContaStatus = "ativa" | "limitada" | "encerrada";
/** Tipo de movimentação como a tela mostra. */
export type MoveType = "aporte" | "saque" | "resultado" | "bonus";

const STATUS: Record<ContaCard["status"], ContaStatus> = {
  ATIVA: "ativa",
  LIMITADA: "limitada",
  ENCERRADA: "encerrada",
};

// Tipos do banco (MovimentacaoTipo) → tipos da tela (`typeMeta` em contas/detail-view).
const MOVTYPE: Record<ContaCard["movimentacoes"][number]["tipo"], MoveType> = {
  DEPOSITO: "aporte",
  SAQUE: "saque",
  GANHO_APOSTA: "resultado",
  PERDA_APOSTA: "resultado",
  ESTORNO: "resultado",
  BONUS: "bonus",
  AJUSTE_MANUAL: "resultado",
};

function toAccount(c: ContaCard) {
  return {
    id: c.id,
    name: c.casaDeAposta,
    // Campos para os formulários de edição (pré-preenchimento).
    titular: c.titular,
    apelido: c.apelido ?? "",
    bankrollIds: c.bancaIds,
    bankroll: c.bancas.length ? c.bancas.join(", ") : null,
    status: STATUS[c.status],
    color: colorFor(c.casaDeAposta),
    balance: c.saldoAtual,
    deposited: c.depositado,
    withdrawn: c.sacado,
    bets: c.apostasVinculadas,
    last: formatSpDateTime(c.atualizada),
    opened: formatSpDateWithYear(c.aberta),
    limitedAt: c.limitadaEm ? formatSpDateWithYear(c.limitadaEm) : null,
    moveCount: c.movimentacoesTotal,
    profit: c.lucroLiquido,
    betProfit: c.resultadoApostas,
    moves: c.movimentacoes.map((m) => ({
      id: m.id,
      date: formatSpDateTime(m.data),
      type: MOVTYPE[m.tipo],
      desc: m.descricao ?? "—",
      value: m.valor,
      betId: m.betId,
    })),
  };
}

export async function getContasData() {
  // As opções de vínculo só precisam de id e nome; o resumo varreria as apostas.
  const [data, bancas] = await Promise.all([getContasPageData(), getBankrollsTips()]);
  const all = [...data.ativas, ...data.limitadas, ...data.encerradas];
  const accounts = all.map(toAccount);
  return {
    owner: { name: all[0]?.titular ?? "—" },
    accounts,
    // Opções para vincular bankroll nos formulários de nova/editar conta.
    bankrollOptions: bancas.map((b) => ({ id: b.id, name: b.nome })),
    summary: {
      saldo: data.summary.saldoGeral,
      ativas: data.summary.ativas,
      saldoAtivas: data.summary.saldoAtivas,
      limitadas: data.summary.limitadas,
      encerradas: data.summary.encerradas,
      retido: data.summary.saldoLimitadas,
    },
  };
}
