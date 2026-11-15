// Dados de demonstração de Contas, na forma do adaptador. Movimentações vivem
// dentro de cada conta.
import type { getContasData } from "../adapters/contas";

type ContasData = Awaited<ReturnType<typeof getContasData>>;
type Account = ContasData["accounts"][number];
type Move = Account["moves"][number];

function account(
  row: Omit<Account, "titular" | "apelido" | "bankrollIds" | "limitedAt" | "moveCount" | "profit" | "betProfit" | "moves">
    & { limitedAt?: string; moves: Omit<Move, "betId">[] },
): Account {
  const moves = row.moves.map((move) => ({ ...move, betId: null }));
  return {
    ...row,
    titular: 'Fabricio Schimidt',
    apelido: '',
    bankrollIds: [],
    limitedAt: row.limitedAt ?? null,
    moveCount: moves.length,
    profit: row.balance + row.withdrawn - row.deposited,
    betProfit: moves.filter((move) => move.type === 'resultado').reduce((sum, move) => sum + move.value, 0),
    moves,
  };
}

const accounts: Account[] = [
  account({ id: 'a1', name: 'Pinnacle', bankroll: 'Sharp Iberia', status: 'ativa', color: '#1f6f4a',
    balance: 12450, deposited: 15000, withdrawn: 3000, bets: 412, last: '13/06 11:40', opened: '04/02/2026',
    moves: [
      { id: 'm1', date: '13/06 11:40', type: 'resultado', desc: 'Liquidação — sharp', value: 540 },
      { id: 'm2', date: '12/06 18:40', type: 'saque', desc: 'Saque para conta corrente', value: -3000 },
      { id: 'm3', date: '12/06 14:10', type: 'resultado', desc: 'Liquidação — lote', value: 2140 },
      { id: 'm4', date: '10/06 19:00', type: 'resultado', desc: 'Liquidação — sharp', value: 1760 },
      { id: 'm5', date: '04/02 09:00', type: 'aporte', desc: 'Depósito inicial', value: 11010 },
    ] }),
  account({ id: 'a2', name: 'Bet365', bankroll: 'Big Data', status: 'ativa', color: '#0a7d4b',
    balance: 4820, deposited: 5000, withdrawn: 1430, bets: 13, last: '13/06 12:05', opened: '20/05/2026',
    moves: [
      { id: 'm1', date: '13/06 12:05', type: 'resultado', desc: 'Liquidação — lote 13/06', value: 1250 },
      { id: 'm2', date: '12/06 10:20', type: 'bonus', desc: 'Bônus de boas-vindas', value: 200 },
      { id: 'm3', date: '08/06 15:00', type: 'saque', desc: 'Saque parcial', value: -1430 },
      { id: 'm4', date: '20/05 11:30', type: 'aporte', desc: 'Depósito inicial', value: 4800 },
    ] }),
  account({ id: 'a3', name: 'Betano', bankroll: 'Value Hunter', status: 'ativa', color: '#b83a1b',
    balance: 3180, deposited: 4000, withdrawn: 1460, bets: 286, last: '12/06 22:30', opened: '11/03/2026',
    moves: [
      { id: 'm1', date: '12/06 22:30', type: 'resultado', desc: 'Liquidação — lote 12/06', value: -820 },
      { id: 'm2', date: '09/06 21:00', type: 'resultado', desc: 'Liquidação — valor', value: 640 },
      { id: 'm3', date: '11/03 14:00', type: 'aporte', desc: 'Depósito inicial', value: 4000 },
    ] }),
  account({ id: 'a4', name: 'Superbet', bankroll: 'Asian Lines BR', status: 'limitada', color: '#c4172b',
    balance: 1640, deposited: 3000, withdrawn: 980, bets: 538, last: '11/06 18:00', opened: '18/01/2026', limitedAt: '11/06/2026',
    moves: [
      { id: 'm1', date: '11/06 17:30', type: 'resultado', desc: 'Liquidação — Asian', value: -430 },
      { id: 'm2', date: '18/01 10:00', type: 'aporte', desc: 'Depósito inicial', value: 3050 },
    ] }),
  account({ id: 'a6', name: 'KTO', bankroll: null, status: 'encerrada', color: '#11734e',
    balance: 0, deposited: 2000, withdrawn: 2350, bets: 41, last: '02/05 14:00', opened: '02/02/2026',
    moves: [
      { id: 'm1', date: '02/05 14:00', type: 'saque', desc: 'Saque de encerramento', value: -2350 },
      { id: 'm2', date: '02/02 10:00', type: 'aporte', desc: 'Depósito inicial', value: 2000 },
    ] }),
];

export const ACC: ContasData = {
  owner: { name: 'Fabricio Schimidt' },
  accounts,
  bankrollOptions: [
    { id: 'bk-sharp-iberia', name: 'Sharp Iberia' },
    { id: 'bk-big-data', name: 'Big Data' },
    { id: 'bk-value-hunter', name: 'Value Hunter' },
  ],
  summary: {
    saldo: accounts.reduce((s, a) => s + a.balance, 0),
    ativas: accounts.filter((a) => a.status === 'ativa').length,
    saldoAtivas: accounts.filter((a) => a.status === 'ativa').reduce((s, a) => s + a.balance, 0),
    limitadas: accounts.filter((a) => a.status === 'limitada').length,
    encerradas: accounts.filter((a) => a.status === 'encerrada').length,
    retido: accounts.filter((a) => a.status === 'limitada').reduce((s, a) => s + a.balance, 0),
  },
};

/** Estado vazio (`?mock=1&empty=1`). */
export const EMPTY_ACC: ContasData = {
  owner: ACC.owner,
  accounts: [],
  bankrollOptions: ACC.bankrollOptions,
  summary: { saldo: 0, ativas: 0, saldoAtivas: 0, limitadas: 0, encerradas: 0, retido: 0 },
};
