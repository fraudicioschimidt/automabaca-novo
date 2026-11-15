import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { BankrollsDecisionCard } from "@/app/_design/screens/bankrolls/decision-card";
import { RankingCard } from "@/app/_design/screens/dashboard/ranking-card";
import { renderDesignMarkup } from "../helpers/design-markup";
import {
  compareTipstersByKey,
  DEFAULT_TIPSTER_SORT,
} from "@/app/_design/lib/tipster-metrics";
import { comparaDecisao, rankingDaDecisaoNaTela } from "@/src/domain/analyzer/decisao";
import type { EdgeVeredito } from "@/src/domain/analyzer/shared";

type DecisionTipster = ComponentProps<typeof BankrollsDecisionCard>["tipsters"][number];
type Dec = DecisionTipster["dec"] & { veredito: EdgeVeredito };

const labels = ["< −5%", "−5–0%", "0–5%", "5–10%", "≥ 10%"];

function renderDistribution(counts: number[]) {
  const tipster: DecisionTipster = {
    id: "canal",
    name: "Canal",
    sharpMode: "CLV_ONLY",
    logoUrl: null,
    dec: {
      amostra: counts.reduce((total, count) => total + count, 0),
      beat: 60,
      clv: 2,
      clvMedio: 2,
      distClv: labels.map((label, index) => ({ label, count: counts[index] ?? 0 })),
      d30: 0,
      d30Note: null,
      roiReal: 3,
      nRoi: 0,
      verdict: "monitorar",
      veredito: "INCONCLUSIVO",
      tStat: null,
      faltam: 0,
    },
  };
  return renderDesignMarkup(<BankrollsDecisionCard tipsters={[tipster]} />);
}

function tipster(over: { id: string; name: string; dec: Partial<Dec> }): DecisionTipster & { dec: Dec } {
  return {
    id: over.id,
    name: over.name,
    sharpMode: "CLV_ONLY",
    logoUrl: null,
    dec: {
      amostra: 30,
      beat: 60,
      clv: 2,
      clvMedio: over.dec.clv === undefined ? 2 : over.dec.clv,
      distClv: labels.map((label) => ({ label, count: 1 })),
      d30: 0,
      d30Note: null,
      roiReal: 3,
      nRoi: 2,
      verdict: "monitorar",
      veredito: "INCONCLUSIVO",
      tStat: null,
      faltam: 0,
      ...over.dec,
    },
  };
}

describe("decisão de assinatura", () => {
  it("renderiza a distribuição real de CLV, normalizada pelo maior bucket", () => {
    const leftHeavy = renderDistribution([4, 2, 1, 0, 0]);
    const rightHeavy = renderDistribution([0, 0, 1, 2, 4]);

    expect(leftHeavy).toContain("Distribuição de CLV");
    expect(leftHeavy).toContain("height:100%");
    expect(leftHeavy).toContain("height:50%");
    expect(leftHeavy).not.toBe(rightHeavy);
  });

  it("ordena pela evidência de edge de comparaDecisao, não pelo CLV médio", () => {
    const tipsters = [
      tipster({ id: "sem", name: "Canal sem edge", dec: { verdict: "pausar", veredito: "SEM_EDGE", tStat: -3, clv: 12 } }),
      tipster({ id: "edge", name: "Canal com edge", dec: { verdict: "forte", veredito: "EDGE", tStat: 2.5, clv: 1 } }),
      tipster({ id: "curta", name: "Canal amostra curta", dec: { verdict: "amostra curta", veredito: "AMOSTRA_CURTA", tStat: null, clv: 18 } }),
      tipster({ id: "inc", name: "Canal inconclusivo", dec: { verdict: "monitorar", veredito: "INCONCLUSIVO", tStat: 1, clv: 9 } }),
    ];
    const html = renderDesignMarkup(<BankrollsDecisionCard tipsters={tipsters} />);
    const ordem = ["Canal com edge", "Canal inconclusivo", "Canal amostra curta", "Canal sem edge"];
    const posicoes = ordem.map((nome) => html.indexOf(nome));
    expect(posicoes.every((pos) => pos >= 0)).toBe(true);
    expect(posicoes).toEqual([...posicoes].sort((a, b) => a - b));
    expect(ordem).toEqual(
      [...tipsters]
        .sort((a, b) => comparaDecisao(rankingDaDecisaoNaTela(a.dec), rankingDaDecisaoNaTela(b.dec)))
        .map((item) => item.name),
    );
    expect(html).not.toContain("ordenado por CLV médio");
    expect(html).toContain("ordenado por evidência de edge");
  });

  it("pódio e lista padrão não promovem AMOSTRA_CURTA com CLV alto acima de EDGE", () => {
    const rows = [
      {
        id: "curta",
        name: "Canal amostra curta",
        lucro: 40,
        clv: 18,
        clvSamples: 3,
        hasClv: true,
        hasRoi: true,
        roi: 90,
        staked: 4,
        wins: 3,
        losses: 0,
        n: 4,
        open: 0,
        main: false,
        veredito: "AMOSTRA_CURTA",
        tStat: null,
        dec: { veredito: "AMOSTRA_CURTA", tStat: null, clv: 18, verdict: "amostra curta" },
        equity: [0, 18],
        sharpMode: "CLV_ONLY",
        unit: "R$10/u",
        last: "hoje",
        acerto: 100,
        hasAcerto: true,
      },
      {
        id: "edge",
        name: "Canal com edge",
        lucro: 2,
        clv: 1,
        clvSamples: 30,
        hasClv: true,
        hasRoi: true,
        roi: 4,
        staked: 20,
        wins: 16,
        losses: 10,
        n: 30,
        open: 0,
        main: false,
        veredito: "EDGE",
        tStat: 2.5,
        dec: { veredito: "EDGE", tStat: 2.5, clv: 1, verdict: "forte" },
        equity: [0, 2],
        sharpMode: "CLV_ONLY",
        unit: "R$10/u",
        last: "hoje",
        acerto: 61,
        hasAcerto: true,
      },
    ];
    expect(DEFAULT_TIPSTER_SORT).toBe("decisao");
    expect(
      [...rows].sort((a, b) => compareTipstersByKey(a, b, DEFAULT_TIPSTER_SORT)).map((row) => row.name),
    ).toEqual(["Canal com edge", "Canal amostra curta"]);
    expect(
      [...rows].sort((a, b) => compareTipstersByKey(a, b, "clv")).map((row) => row.name),
    ).toEqual(["Canal com edge", "Canal amostra curta"]);
    expect(
      [...rows].sort((a, b) => compareTipstersByKey(a, b, "lucro")).map((row) => row.name),
    ).toEqual(["Canal amostra curta", "Canal com edge"]);

    const sorted = [...rows].sort((a, b) => compareTipstersByKey(a, b, DEFAULT_TIPSTER_SORT));
    const html = renderDesignMarkup(
      <RankingCard
        TIP={{ tipsters: rows }}
        sorted={sorted}
        sortKey={DEFAULT_TIPSTER_SORT}
        setSortKey={() => undefined}
      />,
    );
    expect(html.indexOf("Canal com edge")).toBeGreaterThan(-1);
    expect(html.indexOf("Canal com edge")).toBeLessThan(html.indexOf("Canal amostra curta"));
  });
});

describe("Δ 30d", () => {
  it("é diferença de percentuais, escrita em p.p.", () => {
    const html = renderDesignMarkup(<BankrollsDecisionCard tipsters={[tipster({ id: "a", name: "A", dec: { d30: 1.4 } })]} />);
    expect(html).toContain("+1.4 p.p.");
    expect(html).not.toContain("+1.4%");
  });

  it("sem base dos dois lados fica apagado, com o motivo", () => {
    const nota = "amostra curta: 1 agora vs 1 em 30 dias anteriores";
    const html = renderDesignMarkup(<BankrollsDecisionCard tipsters={[tipster({ id: "a", name: "A", dec: { d30: null, d30Note: nota } })]} />);
    expect(html).toContain(`title="${nota}"`);
  });
});


it("explica os limites da inferência mesmo com 30 CLVs na régua", () => {
  const html = renderDistribution([0, 0, 30, 0, 0]);
  expect(html).toContain("observações independentes");
  expect(html).toContain("mesmo jogo podem ser correlacionadas");
  expect(html).toContain("sem ajuste para múltiplas comparações");
  expect(html).toContain("CLVs constantes usam o sinal");
});
