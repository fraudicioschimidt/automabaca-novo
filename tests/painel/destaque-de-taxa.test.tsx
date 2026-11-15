import { describe, expect, it } from "vitest";
import { melhorPorTaxa, type TipsterMetricRow } from "@/app/_design/lib/tipster-metrics";
import { textoDaBaseDoDestaque } from "@/app/_design/lib/destaque-de-taxa";
import { AMOSTRA_MINIMA_EXIBICAO } from "@/src/domain/analyzer/shared";
import { DestaquesCard } from "@/app/_design/screens/dashboard/destaques-card";
import { renderDesignMarkup } from "../helpers/design-markup";

/**
 * Destaque por métrica de TAXA tem piso de amostra e é publicado com a base
 * sobre a qual foi medido.
 *
 * Sem piso, o "Melhor CLV médio" do cartão "Destaques" do Dashboard poderia ir
 * para qualquer tipster com UM fechamento; sem a base ao lado, "+11,66% sobre 83
 * apostas" e "sobre 4" pareceriam a mesma afirmação. O piso é o mesmo da aba
 * Casas do Analyzer.
 *
 * O corolário importa tanto quanto a regra: piso é para MÉDIA, não para soma.
 * "Mais lucrativo" e "Precisa de atenção" somam lucro absoluto — quem fez +5u
 * em uma aposta fez +5u —, e aplicar amostra mínima ali esconderia dinheiro
 * real. Família do `comparacao-de-janelas`.
 */

function linha(nome: string, clv: number, clvSamples: number) {
  return {
    id: nome, name: nome, lucro: 1, staked: 10, wins: 1, losses: 0,
    clv, clvSamples,
  } satisfies TipsterMetricRow;
}

describe("a eleição por taxa respeita o piso", () => {
  it("amostra de 1 não vence amostra que alcança o piso", () => {
    const anedota = linha("anedota", 90, 1);
    const medido = linha("medido", 10, AMOSTRA_MINIMA_EXIBICAO);
    const destaque = melhorPorTaxa([anedota, medido], "clv", AMOSTRA_MINIMA_EXIBICAO);
    expect(destaque).toEqual({ estado: "ok", row: medido, amostra: AMOSTRA_MINIMA_EXIBICAO });
  });

  it("exatamente no piso já compete; um abaixo, não", () => {
    const noPiso = melhorPorTaxa([linha("a", 5, AMOSTRA_MINIMA_EXIBICAO)], "clv", AMOSTRA_MINIMA_EXIBICAO);
    expect(noPiso.estado).toBe("ok");
    const abaixo = melhorPorTaxa([linha("a", 5, AMOSTRA_MINIMA_EXIBICAO - 1)], "clv", AMOSTRA_MINIMA_EXIBICAO);
    expect(abaixo.estado).toBe("amostra-curta");
  });

  it("ninguém elegível não é o mesmo que ninguém medido", () => {
    const curta = melhorPorTaxa([linha("a", 5, 2), linha("b", 9, 3)], "clv", AMOSTRA_MINIMA_EXIBICAO);
    expect(curta).toEqual({ estado: "amostra-curta", melhorAmostra: 3 });
    const semDado = melhorPorTaxa([linha("a", 0, 0)], "clv", AMOSTRA_MINIMA_EXIBICAO);
    expect(semDado).toEqual({ estado: "sem-dado" });
  });

  it("os três estados falam frases diferentes", () => {
    const frases = [
      textoDaBaseDoDestaque({ estado: "ok", row: linha("a", 5, 23), amostra: 23 }),
      textoDaBaseDoDestaque({ estado: "amostra-curta", melhorAmostra: 3 }),
      textoDaBaseDoDestaque({ estado: "sem-dado" }),
    ];
    expect(new Set(frases).size).toBe(3);
    expect(frases[0]).toBe("23 fechamentos");
    expect(frases[1]).toContain("3 fechamentos");
    expect(frases[2]).not.toContain("amostra curta");
  });
});

describe("o cartão publica a base", () => {
  function render(bestClv: Parameters<typeof DestaquesCard>[0]["A"]["bestClv"]) {
    const alvo = { id: "x", name: "Alvo", lucro: 5, hasRoi: true, equity: [0, 5] };
    return renderDesignMarkup(<DestaquesCard A={{ best: alvo, worst: alvo, bestClv }} />);
  }

  it("o vencedor vem com o número de fechamentos; o rótulo fica curto", () => {
    const html = render({ estado: "ok", row: linha("Big Data Under", 10.6, 23), amostra: 23 });
    expect(html).toContain("23 fechamentos");
    expect(html).toContain("Melhor CLV médio");
    expect(html).not.toContain(`≥${AMOSTRA_MINIMA_EXIBICAO} fechamentos`);
  });

  it("amostra curta não publica percentual nenhum", () => {
    const html = render({ estado: "amostra-curta", melhorAmostra: 3 });
    expect(html).toContain("amostra curta");
    expect(html).not.toContain("%");
  });
});
