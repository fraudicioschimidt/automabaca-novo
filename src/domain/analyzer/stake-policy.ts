import type { BetRowData } from "@/src/domain/bet-read-model";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import type { BetStatus } from "@/src/domain/bet-status";
import { instanteDaEntrada } from "@/src/domain/instante-da-entrada";
import { multiplyMoneyDecimal, sumMoneyBy, unitsToReais } from "@/src/domain/money";
import { pnlCurve, type PnlPoint } from "./overview";
import {
  clvConfiavel,
  closingEvidenceKnownAt,
  compareBetTimeline,
  type EdgeVeredito,
  resolvidas,
  roiPct,
  vereditoEdgeFromStats,
} from "./shared";

/**
 * Simulador de stake: as apostas liquidadas do recorte refeitas com outra regra
 * de stake, na ordem dos posts (walk-forward). Em cada aposta a regra só vê o
 * que existia no instante do post: os fechamentos confiáveis do canal já
 * congelados. A stake fixa refaz o resultado pela odd e pelo status. O cashout
 * conserva o retorno proporcional informado pelo dono.
 */

export const STAKE_POLICIES = ["tipster", "flat", "edgeOnly"] as const;
export type StakePolicy = (typeof STAKE_POLICIES)[number];

export type StakeSimBet = Pick<
  BetRowData,
  | "data" | "status" | "odds" | "stake" | "lucro" | "clv" | "clvReliable" | "closingFetchedAt" | "closingUpdatedAt"
  | "registradoEm" | "sourcePostedAt" | "stakeUnits" | "profitUnits"
> & { id?: string };

export type StakeSimOptions<T> = {
  /** O canal da aposta: o CLV médio e o veredito são de cada canal. */
  channelOf: (bet: T) => string;
  /**
   * Quanto vale uma unidade no dinheiro da linha: 1 na banca (a linha já está
   * em unidades) e o valor da unidade gravado na aposta na carteira (em reais).
   */
  unitValueOf: (bet: T) => number;
};

export type PolicyResult = {
  policy: StakePolicy;
  /** Apostas em que a política pôs stake (a amostra dela). */
  bets: number;
  stake: number;
  lucro: number;
  roi: number | null;
  /** O pior recuo desde o pico do lucro acumulado (≤ 0), como na visão geral. */
  maxDrawdown: number;
  maxStake: number;
  /** Lucro acumulado a cada aposta, na ordem dos jogos. */
  pnl: PnlPoint[];
};

export type StakeSimulation = {
  /** Liquidadas do recorte: a base de todas as políticas. */
  settledBets: number;
  policies: PolicyResult[];
};

/** Em empate de instante, o post decide antes: um fechamento do mesmo milissegundo ainda não existia. */
const DECISION = 0;
const CLOSING = 1;

type SimEvent = { at: number; kind: typeof DECISION | typeof CLOSING; seq: number; run: () => void };

/** CLVs confiáveis já congelados do canal (Welford: contagem, média e soma dos quadrados dos desvios). */
type ChannelState = { n: number; mean: number; m2: number };

type Stakes = Record<StakePolicy, { stake: number; lucro: number }>;

/** O veredito do canal no instante do post, pela régua de Bancas. */
function channelVerdict(state: ChannelState): EdgeVeredito {
  const clvMedio = state.n > 0 ? state.mean : null;
  const sd = state.n >= 2 ? Math.sqrt(Math.max(0, state.m2) / (state.n - 1)) : null;
  return vereditoEdgeFromStats(state.n, clvMedio, sd).veredito;
}

export function simulateStakePolicies<T extends StakeSimBet>(
  bets: readonly T[],
  options: StakeSimOptions<T>,
): StakeSimulation {
  const settled = resolvidas([...bets]);
  const channels = new Map<string, ChannelState>();
  const stateOf = (channel: string): ChannelState => {
    let state = channels.get(channel);
    if (!state) {
      state = { n: 0, mean: 0, m2: 0 };
      channels.set(channel, state);
    }
    return state;
  };

  const events: SimEvent[] = [];
  const push = (at: number, kind: SimEvent["kind"], run: () => void) => {
    events.push({ at, kind, seq: events.length, run });
  };

  // O fechamento de qualquer aposta do recorte (pendente e anulada também)
  // entra na régua do canal quando congela, como no veredito de Bancas.
  for (const bet of bets) {
    const clv = clvConfiavel(bet);
    const knownAt = closingEvidenceKnownAt(bet);
    if (clv === null || !knownAt) continue;
    push(knownAt.getTime(), CLOSING, () => {
      const state = stateOf(options.channelOf(bet));
      state.n += 1;
      const delta = clv - state.mean;
      state.mean += delta / state.n;
      state.m2 += delta * (clv - state.mean);
    });
  }

  const stakes: Stakes[] = [];
  settled.forEach((bet, index) => {
    const channel = options.channelOf(bet);
    const unitValue = options.unitValueOf(bet);
    push(instanteDaEntrada(bet).getTime(), DECISION, () => {
      const edge = channelVerdict(stateOf(channel)) === "EDGE";
      // O lucro original já foi arredondado: dividi-lo pela stake amplificaria
      // esse erro. Cashout não deriva da odd e conserva os valores em unidades.
      const status = bet.status.trim().toUpperCase() as BetStatus;
      const originalStake = bet.stakeUnits ?? bet.stake;
      const flatLucro = status === "CASHOUT"
        ? multiplyMoneyDecimal(bet.profitUnits ?? bet.lucro, unitValue, {
          multiplierDecimals: 2, divisor: originalStake, divisorDecimals: 6,
        })
        : unitsToReais(computeLucroFromStatus({ status, stake: 1, odds: bet.odds }), unitValue);
      stakes[index] = {
        tipster: { stake: bet.stake, lucro: bet.lucro },
        flat: { stake: unitsToReais(1, unitValue), lucro: flatLucro },
        edgeOnly: edge ? { stake: bet.stake, lucro: bet.lucro } : { stake: 0, lucro: 0 },
      };
    });
  });

  events.sort((a, b) => a.at - b.at || a.kind - b.kind || a.seq - b.seq);
  for (const event of events) event.run();

  // A mesma ordem (a dos jogos) da visão geral: a curva e o drawdown da stake
  // do tipster saem iguais aos de lá.
  const byResult = settled
    .map((bet, index) => ({ bet, index }))
    .sort((a, b) => compareBetTimeline(a.bet, b.bet));

  const policies = STAKE_POLICIES.map((policy): PolicyResult => {
    const placed = stakes.map((s) => s[policy]);
    const stake = sumMoneyBy(placed, (s) => s.stake);
    const lucro = sumMoneyBy(placed, (s) => s.lucro);
    const { pnl, maxDrawdown } = pnlCurve(byResult.map(({ bet, index }) => ({
      data: bet.data, lucro: stakes[index]![policy].lucro,
    })));
    return {
      policy,
      bets: placed.filter((s) => s.stake > 0).length,
      stake,
      lucro,
      roi: roiPct(lucro, stake),
      maxDrawdown,
      maxStake: placed.reduce((max, s) => Math.max(max, s.stake), 0),
      pnl,
    };
  });

  return { settledBets: settled.length, policies };
}
