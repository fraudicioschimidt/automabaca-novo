import { describe, expect, it } from "vitest";
import {
  packAnalyzerBet,
  unpackAnalyzerBet,
  unpackAnalyzerBets,
  type AnalyzerPackedBet,
} from "@/app/_design/lib/analyzer-pack";
import { ANALYZER_MOCK_DATA } from "@/app/_design/mock/analyzer-data";
import { simulateStakePolicies } from "@/src/domain/analyzer/stake-policy";
import { computeOverviewV1 } from "@/src/domain/analyzer/overview";
import { computePeriodoV1 } from "@/src/domain/analyzer/periodo";
import { computeTimingV1 } from "@/src/domain/analyzer/timing";
import { spDayKey } from "@/src/domain/dates";
import type { BetRowData } from "@/src/domain/bet-read-model";

function makeRow(over: Partial<BetRowData> = {}): BetRowData {
  return {
    id: "", data: new Date("2026-07-11T12:00:00Z"), evento: "A vs B", competicao: "Liga",
    pais: "BR", esporte: "Soccer", mercado: "Total", selecao: "", casaDeAposta: "Pinnacle",
    tipster: "", odds: 1.9, stake: 1, status: "WON", lucro: 0.9,
    closingOdd: 1.8,
    openingMaxBet: 80, closingMaxBet: null, openingOdd: 1.85,
    openingRawOdd: 1.9, closingRawOdd: 1.86, registradoEm: new Date("2026-07-10T12:00:00Z"),
    clv: 5, clvReliable: true, closingFetchedAt: new Date("2026-07-11T11:59:00Z"),
    identityStatus: null, noOddsReason: null, closingNoOddsReason: null, source: "",
    sourceExternalId: null, contaTitular: null,
    ...over,
  } satisfies BetRowData;
}

/** pack → unpack, que é exatamente o caminho do cliente (RSC → shim → compute). */
const roundTrip = (row: BetRowData): BetRowData & { day: string } =>
  unpackAnalyzerBet(packAnalyzerBet(row, spDayKey(row.data)));

describe("payload compacto do Analyzer", () => {
  it("preserva os campos usados pelos cálculos sem repetir chaves no RSC", () => {
    const row = makeRow();
    const packed = packAnalyzerBet(row, "2026-07-11");
    expect(Array.isArray(packed)).toBe(true);
    expect(unpackAnalyzerBet(packed)).toMatchObject({
      day: "2026-07-11", evento: row.evento, odds: row.odds, clv: row.clv,
      registradoEm: row.registradoEm,
    });
  });

  /**
   * A gaveta lista apostas: sem `id` a lista não tem chave estável (todas iguais
   * a "") nem link para a ficha `/aposta?id=`, e sem `selecao` duas apostas no
   * mesmo jogo ficam visualmente idênticas.
   */
  it("preserva id e selecao, que a gaveta precisa para identificar a aposta", () => {
    const row = makeRow({ id: "ckz7q1a2b0000xyz", selecao: "Over 2.5" });
    expect(roundTrip(row)).toMatchObject({ id: "ckz7q1a2b0000xyz", selecao: "Over 2.5" });
  });

  it("preserva o motivo da abertura ausente, que decide a base da cobertura de abertura", () => {
    expect(roundTrip(makeRow({ openingNoOddsReason: "partida_nao_localizada" })).openingNoOddsReason)
      .toBe("partida_nao_localizada");
  });

  it("na carteira leva a banca da aposta (a dimensão Canal); na banca ela não viaja", () => {
    expect(roundTrip(makeRow({ bankrollName: "Tênis Pro" })).bankrollName).toBe("Tênis Pro");
    expect(roundTrip(makeRow()).bankrollName).toBeUndefined();
  });

  it("na carteira leva o valor da unidade da aposta, que devolve o simulador de stake às unidades", () => {
    expect(roundTrip(makeRow({ bankrollName: "Tênis Pro", valorUnidade: 50 })).valorUnidade).toBe(50);
    expect(roundTrip(makeRow()).valorUnidade).toBeUndefined();
  });

  it("apostas distintas mantêm ids distintos (chave de lista utilizável)", () => {
    const ids = [makeRow({ id: "a1" }), makeRow({ id: "a2" }), makeRow({ id: "a3" })]
      .map((b) => roundTrip(b).id);
    expect(new Set(ids).size).toBe(3);
  });

  it("mock visual cumpre liquidação, identidade e unidade de liquidez", () => {
    const rows = unpackAnalyzerBets(
      ANALYZER_MOCK_DATA.bets as unknown as AnalyzerPackedBet[],
    );

    expect(rows).not.toHaveLength(0);
    for (const row of rows) {
      expect(row.settledAt === null).toBe(row.status === "PENDING");
      expect(row.id).toBeTruthy();
      expect(row.selecao).toBeTruthy();
      expect(row.closingMaxBetCurrency).toBe(row.closingMaxBet == null ? null : "USD");
      expect(row.openingMaxBetCurrency).toBe(row.openingMaxBet == null ? null : "USD");
    }
  });

  /**
   * O Analyzer calcula no CLIENTE, sobre o que o pack leva. O round-trip é o
   * portão porque é o caminho real: um teste que chamasse `computePeriodoV1`
   * direto no BetRowData passaria com o pack quebrado.
   */
  describe("atribuição de PnL pelo dia do jogo, não pelo da liquidação", () => {
    // Jogo 31/07 21:00 SP (= 01/08 00:00 UTC), liquidado 01/08 00:30 SP.
    // Kickoff e liquidação caem em dias E meses SP diferentes.
    const viraDia = makeRow({
      data: new Date("2026-08-01T00:00:00Z"),
      settledAt: new Date("2026-08-01T03:30:00Z"),
    });

    it("o round-trip preserva settledAt", () => {
      expect(roundTrip(viraDia).settledAt).toEqual(viraDia.settledAt);
    });

    it("preserva settledAt nulo (aposta ainda não liquidada)", () => {
      const pendente = makeRow({ status: "PENDING", lucro: 0, settledAt: null });
      expect(roundTrip(pendente).settledAt).toBeNull();
    });

    it("o daily90 do cliente bucketiza pelo dia do jogo", () => {
      const { daily90 } = computePeriodoV1([roundTrip(viraDia)]);
      expect(daily90.map((d) => d.dayKey)).toEqual(["2026-07-31"]);
    });

    it("o mensal do cliente bucketiza pelo mês do jogo", () => {
      const { monthly } = computePeriodoV1([roundTrip(viraDia)]);
      expect(monthly.map((m) => m.key)).toEqual(["2026-07"]);
    });

    it("a curva de equity do cliente bucketiza pelo dia do jogo", () => {
      const { pnl } = computeOverviewV1([roundTrip(viraDia)]);
      expect(pnl.map((p) => p.dayKey)).toEqual(["2026-07-31"]);
    });

    it("cliente e servidor concordam sobre os mesmos bets", () => {
      const bets = [
        viraDia,
        makeRow({ data: new Date("2026-07-20T18:00:00Z"), settledAt: new Date("2026-07-20T20:00:00Z") }),
      ];
      const noServidor = computePeriodoV1(bets);
      const noCliente = computePeriodoV1(bets.map(roundTrip));
      expect(noCliente.monthly.map((m) => m.key)).toEqual(noServidor.monthly.map((m) => m.key));
      expect(noCliente.daily90).toEqual(noServidor.daily90);
    });
  });

  /**
   * A aba Timing mede a antecedência a partir do post (`sourcePostedAt`) e deixa
   * de fora o kickoff provisório (`kickoffInferido`). Sem as duas colunas no
   * pacote, o cliente contaria a partir do registro e poria o kickoff provisório
   * em "Pós-kickoff".
   */
  describe("antecedência pelo horário do post, sem kickoff provisório", () => {
    // Post 09:00 SP, registro 14:00 SP (captura atrasada), jogo 16:00 SP.
    const capturaAtrasada = makeRow({
      data: new Date("2026-07-11T19:00:00Z"),
      sourcePostedAt: new Date("2026-07-11T12:00:00Z"),
      registradoEm: new Date("2026-07-11T17:00:00Z"),
    });
    // Post só com a data (00:00 SP) às 14:00 SP.
    const soComData = makeRow({
      data: new Date("2026-07-11T03:00:00Z"),
      kickoffInferido: true,
      sourcePostedAt: new Date("2026-07-11T17:00:00Z"),
      registradoEm: new Date("2026-07-11T17:00:30Z"),
    });

    it("o round-trip preserva sourcePostedAt e kickoffInferido", () => {
      expect(roundTrip(capturaAtrasada)).toMatchObject({
        sourcePostedAt: capturaAtrasada.sourcePostedAt,
        kickoffInferido: false,
      });
      expect(roundTrip(soComData).kickoffInferido).toBe(true);
      expect(roundTrip(makeRow({ sourcePostedAt: null })).sourcePostedAt).toBeNull();
    });

    it("cliente e servidor concordam no timing", () => {
      const bets = [capturaAtrasada, soComData];
      const noServidor = computeTimingV1(bets);
      const noCliente = computeTimingV1(bets.map(roundTrip));
      expect(noServidor).toMatchObject({ coveredBets: 1, avgAntecedenciaHours: 7 });
      expect(noCliente.coveredBets).toBe(noServidor.coveredBets);
      expect(noCliente.coveragePct).toBe(noServidor.coveragePct);
      expect(noCliente.avgAntecedenciaHours).toBe(noServidor.avgAntecedenciaHours);
      const faixas = (t: ReturnType<typeof computeTimingV1>) =>
        t.byAntecedencia.map((b) => [b.label, b.bets]);
      expect(faixas(noCliente)).toEqual(faixas(noServidor));
      expect(noCliente.heatmap).toEqual(noServidor.heatmap);
    });
  });
});

describe("reconstrução de valores originais", () => {
  it("o transporte ao navegador conserva microunidades para refazer o cashout", () => {
    const row = makeRow({ status: "CASHOUT", stake: 0, lucro: 0, stakeUnits: 0.000001, profitUnits: 0.000001, valorUnidade: 0.01 });
    const opts = { channelOf: () => "canal", unitValueOf: (bet: BetRowData) => bet.valorUnidade ?? 1 };
    const original = simulateStakePolicies([row], opts);
    expect(simulateStakePolicies([roundTrip(row)], opts)).toEqual(original);
  });
});

describe("instante de disponibilidade no navegador", () => {
  it("leva a última escrita do fechamento, além da tentativa de congelar", () => {
    const updated = new Date("2026-07-11T14:15:16.789Z");
    expect(roundTrip(makeRow({ closingUpdatedAt: updated })).closingUpdatedAt).toEqual(updated);
  });
});
