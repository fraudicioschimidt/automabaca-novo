import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/infra/prisma", () => ({
  prisma: { $transaction: async (read: (tx: object) => Promise<unknown>) => read({}) },
}));

const services = vi.hoisted(() => ({
  getBankrollSummaries: vi.fn(),
  getCanaisDecisao: vi.fn(),
  getBetDetail: vi.fn(),
}));

vi.mock("@/src/services/painel/queries/bankrolls", () => ({
  getBankrollSummaries: services.getBankrollSummaries,
}));
vi.mock("@/src/services/painel/queries/bet-rows", () => ({
  getBetDetail: services.getBetDetail,
}));
vi.mock("@/src/services/painel/canais", () => ({ getCanaisDecisao: services.getCanaisDecisao }));

import { compareTipstersByKey } from "@/app/_design/lib/tipster-metrics";
import { BankrollsDecisionCard } from "@/app/_design/screens/bankrolls/decision-card";
import { renderDesignMarkup } from "../helpers/design-markup";
import { createElement } from "react";

const { getBankrollsData } = await import("@/app/_design/adapters/bankrolls");
const { getApostaBet } = await import("@/app/_design/adapters/aposta");

describe("adaptadores de bankrolls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.getBankrollSummaries.mockResolvedValue([{
      id: "bk-1",
      slug: "treino",
      nome: "Treino",
      sharpMode: "CLV_ONLY",
      temCanal: true,
      logoUrl: null,
      apostas: 40,
      resolvidas: 35,
      pendentes: 5,
      stakePendente: 2.5,
      stakeFinalizada: 20,
      lucro: 2.345,
      profitBrl: 23.45,
      stakedBrl: 200,
      halfWins: 0,
      halfLosses: 0,
      roi: 11.725,
      clv: 3.2,
      clvSamples: 35,
      acerto: 55,
      wins: 20,
      losses: 15,
      capitalInicial: 100,
      valorUnidade: 10,
      ultimaAtividade: null,
    }]);
    services.getCanaisDecisao.mockResolvedValue([{
      id: "bk-1",
      decisao: {
        nClv: 35,
        beatClosePct: 61.4,
        clvMedio: 3.24,
        distClv: [
          { label: "< −5%", count: 2 },
          { label: "−5–0%", count: 8 },
          { label: "0–5%", count: 15 },
          { label: "5–10%", count: 7 },
          { label: "≥ 10%", count: 3 },
        ],
        clv30d: 3.1,
        n30d: 12,
        n30a60d: 9,
        deltaClv30d: -0.14,
        roiReal: 11.72,
        nFinal: 20,
        tStat: 2.41,
        veredito: "EDGE",
      },
    }]);
    services.getBetDetail.mockResolvedValue(null);
  });

  it("combina resumo e decisão com arredondamento estável", async () => {
    const result = await getBankrollsData();
    expect(result.tipsters[0]).toMatchObject({
      id: "treino",
      lucro: 2.345,
      profitBrl: 23.45,
      stakedBrl: 200,
      halfWins: 0,
      halfLosses: 0,
      dec: {
        amostra: 35,
        beat: 61,
        clv: 3.2,
        distClv: [
          { label: "< −5%", count: 2 },
          { label: "−5–0%", count: 8 },
          { label: "0–5%", count: 15 },
          { label: "5–10%", count: 7 },
          { label: "≥ 10%", count: 3 },
        ],
        d30: -0.1,
        d30Note: null,
        roiReal: 11.7,
        nRoi: 20,
        verdict: "forte",
        veredito: "EDGE",
        tStat: 2.41,
        faltam: 0,
      },
    });
  });

  it("Δ 30d com um fechamento de um lado não vira número colorido", async () => {
    const base = (await services.getCanaisDecisao())[0];
    services.getCanaisDecisao.mockResolvedValueOnce([{
      ...base, decisao: { ...base.decisao, clv30d: 9, n30d: 1, n30a60d: 1, deltaClv30d: 8 },
    }]);
    const { dec } = (await getBankrollsData()).tipsters[0]!;
    expect(dec.d30).toBeNull();
    expect(dec.d30Note).toBe("amostra curta: 1 agora vs 1 em 30 dias anteriores");
  });

  it("canal sem decisão calculada é amostra curta, sem número de CLV", async () => {
    services.getCanaisDecisao.mockResolvedValueOnce([]);
    const result = await getBankrollsData();
    expect(result.tipsters[0]!.dec).toEqual({
      amostra: 0, beat: null, clv: null, clvMedio: null, distClv: [], d30: null, d30Note: null, roiReal: null, nRoi: 0,
      verdict: "amostra curta", veredito: "AMOSTRA_CURTA", tStat: null, faltam: 30,
    });
  });

  it("o desempate preserva o CLV completo nas listas e no cartão de decisão", async () => {
    const summary = (await services.getBankrollSummaries())[0];
    const decision = (await services.getCanaisDecisao())[0].decisao;
    services.getBankrollSummaries.mockResolvedValue([
      { ...summary, id: "a", slug: "a", nome: "Alfa", clv: 2.01 },
      { ...summary, id: "z", slug: "z", nome: "Zeta", clv: 2.04 },
    ]);
    services.getCanaisDecisao.mockResolvedValue([
      { id: "z", decisao: { ...decision, clvMedio: 2.04, tStat: null } },
      { id: "a", decisao: { ...decision, clvMedio: 2.01, tStat: null } },
    ]);
    const { tipsters } = await getBankrollsData();
    expect(tipsters.map((t) => t.dec.clv)).toEqual([2, 2]);
    expect([...tipsters].sort((a, b) => compareTipstersByKey(a, b, "decisao")).map((t) => t.name)).toEqual(["Zeta", "Alfa"]);
    const html = renderDesignMarkup(createElement(BankrollsDecisionCard, { tipsters }));
    expect(html.indexOf("Zeta")).toBeLessThan(html.indexOf("Alfa"));
  });

  it("retorna null para aposta inexistente", async () => {
    await expect(getApostaBet("missing")).resolves.toBeNull();
  });
});
