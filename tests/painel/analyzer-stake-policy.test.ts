import { describe, expect, it } from "vitest";
import { simulateStakePolicies, type StakePolicy, type StakeSimOptions } from "@/src/domain/analyzer/stake-policy";
import { computeOverviewV1 } from "@/src/domain/analyzer/overview";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import { AMOSTRA_MINIMA_CLV } from "@/src/domain/analyzer/shared";
import type { BetRowData } from "@/src/domain/bet-read-model";

/** Simulador de stake do Analyzer: walk-forward sobre as liquidadas, lógica pura. */

type Bet = BetRowData & { channel: string };

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));

/** Aposta liquidada: post em `post`, liquidação em `settled` (minutos a partir das 12h). */
function bet(p: Partial<Bet> & { post: number; settled?: number }): Bet {
  const { post, settled, ...rest } = p;
  return {
    channel: "Alfa", id: `bet-${post}`, data: at(post + 30), evento: "A vs B", competicao: "Liga", pais: "Brasil",
    esporte: "Soccer", mercado: "Total", selecao: "Over 2.5", casaDeAposta: "Pinnacle", tipster: "",
    status: "WON", odds: 2, stake: 1, lucro: 1,
    closingOdd: null, openingMaxBet: null, closingMaxBet: null, openingOdd: null, openingRawOdd: null, closingRawOdd: null,
    clv: null, clvReliable: null, closingFetchedAt: null,
    registradoEm: at(post), sourcePostedAt: at(post), settledAt: at(settled ?? post + 120),
    identityStatus: null, noOddsReason: null, closingNoOddsReason: null, source: "", sourceExternalId: null, contaTitular: null,
    ...rest,
  };
}

/**
 * `n` fechamentos confiáveis do canal, congelados no minuto `frozen`, em apostas
 * ainda pendentes (o fechamento conta; o dinheiro não entra na simulação).
 */
function closings(n: number, frozen: number, a: number, b: number, channel = "Alfa"): Bet[] {
  return Array.from({ length: n }, (_, i) => bet({
    channel, post: frozen - 60, status: "PENDING", lucro: 0, settledAt: null,
    clv: i % 2 ? a : b, clvReliable: true, closingFetchedAt: at(frozen),
  }));
}

const options: StakeSimOptions<Bet> = { channelOf: (b) => b.channel, unitValueOf: (b) => b.valorUnidade ?? 1 };
const run = (bets: Bet[], opts: Partial<StakeSimOptions<Bet>> = {}) => simulateStakePolicies(bets, { ...options, ...opts });
const policy = (sim: ReturnType<typeof run>, name: StakePolicy) => sim.policies.find((p) => p.policy === name)!;

describe("stake do tipster e stake fixa", () => {
  it("a stake do tipster é o que foi apostado: mesmo lucro, stake, ROI e drawdown da visão geral", () => {
    const bets = [
      bet({ post: 0, odds: 1.95, stake: 2, lucro: 1.9 }),
      bet({ post: 10, status: "LOST", stake: 1, lucro: -1 }),
      bet({ post: 20, status: "HALF_LOST", stake: 2, lucro: -1 }),
      bet({ post: 30, status: "CASHOUT", stake: 1, lucro: 0.4 }),
      bet({ post: 40, status: "VOID", stake: 3, lucro: 0 }),
      bet({ post: 50, status: "PENDING", stake: 3, lucro: 0, settledAt: null }),
    ];
    const tipster = policy(run(bets), "tipster");
    const overview = computeOverviewV1(bets);
    expect(tipster).toMatchObject({
      bets: 4, stake: overview.totalStake, lucro: overview.totalLucro, roi: overview.roi, maxDrawdown: overview.maxDrawdown, maxStake: 2,
    });
    expect(tipster.pnl).toEqual(overview.pnl);
  });

  it("a stake fixa põe 1u em cada liquidada e escala o resultado dela", () => {
    const sim = run([
      bet({ post: 0, odds: 1.95, stake: 2, lucro: 1.9 }),
      bet({ post: 10, status: "LOST", stake: 0.5, lucro: -0.5 }),
      bet({ post: 20, status: "HALF_LOST", stake: 2, lucro: -1 }),
      bet({ post: 30, status: "VOID", stake: 1, lucro: 0 }),
    ]);
    expect(sim.settledBets).toBe(3);
    // +0,95 − 1 − 0,5
    expect(policy(sim, "flat")).toMatchObject({ bets: 3, stake: 3, lucro: -0.55, maxStake: 1, maxDrawdown: -1.5 });
  });
});

describe("precisão da stake fixa", () => {
  it.each([["WON", 0.9505], ["HALF_WON", 0.47525], ["LOST", -1], ["HALF_LOST", -0.5]] as const)("refaz %s com 1u pela odd e pelo resultado, sem amplificar o arredondamento original", (status, expectedProfit) => {
    const stake = 0.001;
    const odds = 1.9505;
    const lucro = computeLucroFromStatus({ status, stake, odds });
    const flat = policy(run([bet({ post: 0, status, stake, odds, lucro })]), "flat");
    expect(flat.lucro).toBe(expectedProfit);
  });

  it("na carteira, o arredondamento em reais não altera o retorno da seleção", () => {
    const flat = policy(run([bet({ post: 0, stake: 0.000001, lucro: -0.000001, status: "HALF_LOST", valorUnidade: 0.5 })]), "flat");
    expect(flat).toMatchObject({ stake: 0.5, lucro: -0.25, roi: -50 });
  });

  it("cashout mantém o retorno proporcional e arredonda só no valor final em reais", () => {
    const flat = policy(run([bet({ post: 0, status: "CASHOUT", stake: 150, lucro: 50, valorUnidade: 50 })]), "flat");
    expect(flat).toMatchObject({ stake: 50, lucro: 16.666667 });
  });
});

describe("cashout com microunidades na carteira", () => {
  it("conserva o retorno original mesmo quando a conversão em reais arredondou a zero", () => {
    const flat = policy(run([bet({ post: 0, status: "CASHOUT", stake: 0, lucro: 0,
      stakeUnits: 0.000001, profitUnits: 0.000001, valorUnidade: 0.01 })]), "flat");
    expect(flat).toMatchObject({ stake: 0.01, lucro: 0.01, roi: 100 });
  });
});

describe("stake do tipster só com veredito Manter", () => {
  it("aposta a stake do tipster só quando o veredito do canal no post era Manter", () => {
    const post = (minute: number) => bet({ post: minute, stake: 2, lucro: 1.8 });
    const sim = run([...closings(AMOSTRA_MINIMA_CLV, 50, 4, 6), post(10), post(100)]);
    // No minuto 10 ainda não havia fechamento (amostra curta); no 100, EDGE.
    expect(policy(sim, "edgeOnly")).toMatchObject({ bets: 1, stake: 2, lucro: 1.8 });
    // CLV médio 1% com desvio de ~10: sem edge provado.
    const noisy = run([...closings(AMOSTRA_MINIMA_CLV, 50, -9, 11), post(100)]);
    expect(policy(noisy, "edgeOnly").bets).toBe(0);
  });

  it("não olha o futuro: fechamento congelado depois do post não muda o veredito da aposta", () => {
    const target = bet({ post: 100 });
    const withFuture = [
      ...closings(AMOSTRA_MINIMA_CLV - 1, 50, 4, 6),
      // O 30º fechamento congela um minuto depois do post.
      ...closings(1, 101, 4, 6),
      target,
      // E um fechamento enorme bem depois: nada disso existia no post.
      ...closings(5, 500, 80, 90),
    ];
    expect(policy(run(withFuture), "edgeOnly")).toMatchObject({ bets: 0, stake: 0 });
    // No mesmo milissegundo do post o fechamento ainda não existia.
    const sameInstant = [...closings(AMOSTRA_MINIMA_CLV - 1, 50, 4, 6), ...closings(1, 100, 4, 6), target];
    expect(policy(run(sameInstant), "edgeOnly").bets).toBe(0);
    const before = [...closings(AMOSTRA_MINIMA_CLV, 50, 4, 6), target, ...closings(5, 500, 80, 90)];
    expect(policy(run(before), "edgeOnly")).toMatchObject({ bets: 1, stake: 1 });
  });
});

describe("carteira", () => {
  it("cada canal com a própria régua, e o dinheiro em reais pelo valor da unidade", () => {
    const sim = run([
      ...closings(AMOSTRA_MINIMA_CLV, 50, 4, 6, "Alfa"),
      // Na carteira a linha está em reais: 1u a R$ 50 = R$ 50.
      bet({ channel: "Alfa", post: 100, stake: 50, lucro: 50, valorUnidade: 50 }),
      bet({ channel: "Beta", post: 100, stake: 40, lucro: -40, status: "LOST", valorUnidade: 20 }),
    ]);
    // Só Alfa tem edge; Beta sem fechamentos fica de fora.
    expect(policy(sim, "edgeOnly")).toMatchObject({ bets: 1, stake: 50, lucro: 50 });
    // 1u em cada: R$ 50 ganhos e R$ 20 perdidos.
    expect(policy(sim, "flat")).toMatchObject({ bets: 2, stake: 70, lucro: 30 });
    expect(policy(sim, "tipster")).toMatchObject({ stake: 90, lucro: 10 });
  });
});

describe("instante real em que o CLV ficou conhecido", () => {
  it("busca pós-jogo e correção posteriores ao post não voltam no tempo na simulação", () => {
    const delayed = closings(1, 50, 4, 6)[0]!;
    // A tentativa inicial é do minuto 50; o preço só chegou no 150.
    Object.assign(delayed, { closingUpdatedAt: at(150) });
    const rows = [...closings(AMOSTRA_MINIMA_CLV - 1, 50, 4, 6), delayed, bet({ post: 100 })];
    expect(policy(run(rows), "edgeOnly").bets).toBe(0);
  });
});
