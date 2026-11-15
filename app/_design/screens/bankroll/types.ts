// Tipos do fluxo da banca. O dado vem do adaptador; a aposta local é a que a
// tela cria no otimismo de "Adicionar aposta" (ou no mock), antes do servidor.
import type { getBankrollData } from "../../adapters/bankroll";
import type { ManualSettlementView } from "@/src/domain/manual-settlement";
import type { StatusDeTela } from "@/src/domain/status-de-aposta";

export type BankrollData = NonNullable<Awaited<ReturnType<typeof getBankrollData>>>;

/**
 * O que a tela lê: o dado real ou, sem ele, o runtime vazio. `bk`,
 * `historyTotal`, `todayKey` e `removed` só existem com dado (e o mock não
 * traz todos).
 */
export type BankrollView = Pick<BankrollData, "BETS" | "METRICS" | "CHART" | "tips">
  & Partial<Pick<BankrollData, "bk" | "historyTotal" | "todayKey" | "removed">>;

export type ServerBet = BankrollData["BETS"][number];

/** Uma aposta da lista "Removidas": fora da banca, com o "Restaurar". */
export type RemovedBet = BankrollData["removed"]["bets"][number];

/** Aposta criada na tela antes de o servidor devolvê-la. */
export type LocalBet = {
  id: string;
  day: string;
  time: string;
  home: string;
  away: string;
  esporte: string;
  region: string;
  league: string | null;
  market: string;
  line: string;
  odds: number;
  clv: null;
  stake: number;
  status: StatusDeTela;
  profit: number | null;
  kickoffInferido?: boolean;
  /** Mesma guarda do servidor, sobre o mercado e a seleção digitados. */
  allowsHalfResult: boolean;
  settlementView?: undefined;
  // O que só o servidor calcula; a linha lê esses campos de qualquer aposta.
  movimento?: undefined;
  clvSituacao?: undefined;
  reliq?: undefined;
  sportPending?: undefined;
  liveScoreAtTip?: undefined;
  d: {
    open: number;
    close: null;
    liqOpen: null;
    liqClose: null;
    eventAt: string;
    casa: string | null;
    capturedAt: string;
    before: string;
    origin: string;
    msg: null;
    moveType: null;
    liveScoreAtTip?: undefined;
    clvOrigem?: undefined;
    aposApito?: undefined;
  };
};

export type BankrollBet = ServerBet | LocalBet;

/** O mínimo que a liquidação manual precisa da aposta. */
export type SettleTarget = {
  id: string;
  stake: number;
  odds: number;
  settlementView?: ManualSettlementView | null;
};

/** Menu "alterar resultado" aberto sobre uma aposta, ancorado no clique. */
export type ResultMenuState<B extends SettleTarget = BankrollBet> = { b: B; x: number; y: number };

export type Overlay = "calendario" | "estatisticas" | "adicionar" | "compartilhar";
