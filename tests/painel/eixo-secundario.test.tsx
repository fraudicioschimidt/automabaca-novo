import { createElement } from "react";
import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import * as DISTRIBUICAO from "@/app/_design/screens/analyzer/charts/distribuicao";
import * as LINHA_DO_TEMPO from "@/app/_design/screens/analyzer/charts/linha-do-tempo";
import { RCChart } from "@/app/_design/screens/analyzer/charts/distribuicao";
import { MonthlyChart } from "@/app/_design/screens/analyzer/charts/linha-do-tempo";
import { SegmentosTab } from "@/app/_design/screens/analyzer/segmentos-tab";
import { ranking } from "@/app/_design/lib/concentracao";
import {
  compartilhandoOZero,
  escala,
  faixaVertical,
  fracaoDoZero,
  marcasRedondas,
  rotulosQueCabem,
} from "@/app/_design/lib/eixo-secundario";

/**
 * Duas séries no mesmo desenho não têm zeros diferentes — e cartão não promete
 * uma ordem no título e desenha outra. Mesma família de `resumo-de-apostas` e
 * `barra-com-sinal`: o desenho afirmando o que o número ao lado não sustenta.
 *
 * 1. **Dois zeros, uma régua.** `MonthlyChart` desenha barras de lucro e pontos
 *    de ROI com uma linha horizontal só; com escalas independentes, um ROI
 *    positivo sai ABAIXO da linha que o gráfico chama de zero. `RCChart` tem o
 *    mesmo risco entre as barras de ROI e a linha de CLV.
 *
 * 2. **Ranking fora de ordem.** "Top casas por lucro" e "Ranking por lucro"
 *    têm de desenhar pela ordem do título, não pela de ENCONTRO do agrupamento
 *    nem pela de CONTAGEM — senão a pior casa aparece em 1º.
 *
 * A propriedade que mata a primeira classe é uma só: **o pixel do zero das duas
 * séries é o mesmo**. A que mata a segunda é a ordem desenhada ser a ordem
 * prometida. Ambas são varridas abaixo sobre grade e sobre render.
 */

const CAIXA = faixaVertical(230, 16, 30);

/** `cy="123.4"` de cada círculo, na ordem em que saem no HTML. */
const circulos = (html: string): number[] =>
  [...html.matchAll(/<circle[^>]*\bcy="([-\d.]+)"/g)].map((m) => Number(m[1]));

/** O `y1` da linha horizontal cheia — a régua do zero. */
function regua(html: string): number {
  const m = html.match(/<line[^>]*\bx1="[\d.]+"[^>]*\by1="([-\d.]+)"[^>]*\by2="\1"/);
  expect(m, "o desenho não tem régua horizontal").not.toBeNull();
  return Number(m![1]);
}

describe("a escala é uma só, e sabe onde está o zero", () => {
  it("mapeia as pontas do alcance nas pontas da faixa", () => {
    const e = escala(-10, 30, CAIXA);
    expect(e.px(-10)).toBe(CAIXA.inicio);
    expect(e.px(30)).toBe(CAIXA.fim);
  });

  it("alcance degenerado não vira divisão por zero", () => {
    const e = escala(5, 5, CAIXA);
    expect(Number.isFinite(e.px(5))).toBe(true);
    expect(e.px(5)).toBe((CAIXA.inicio + CAIXA.fim) / 2);
  });

  it("zero fora do alcance não tem pixel", () => {
    expect(escala(2, 8, CAIXA).pxDoZero).toBeNull();
    expect(escala(-8, -2, CAIXA).pxDoZero).toBeNull();
    expect(escala(-8, 2, CAIXA).pxDoZero).not.toBeNull();
  });

  it("fracaoDoZero recusa alcance sem zero dentro", () => {
    expect(fracaoDoZero(1, 5)).toBeNull();
    expect(fracaoDoZero(-5, -1)).toBeNull();
    expect(fracaoDoZero(5, 5)).toBeNull();
    expect(fracaoDoZero(-5, 5)).toBeCloseTo(0.5);
    expect(fracaoDoZero(-3, 9)).toBeCloseTo(0.75);
  });
});

describe("a segunda série divide o zero com a primeira", () => {
  /**
   * A propriedade central. Qualquer escala secundária calculada por conta
   * própria erra isto, e a fratura passa despercebida.
   */
  it.each([
    [-5, 5],
    [-2.112, 2.112],
    [-17.8, 65.6],
    [-15, 10],
    [-0.33, 0.33],
  ])("zero no mesmo pixel — primária [%s, %s]", (lo, hi) => {
    const primaria = escala(lo, hi, CAIXA);
    for (const valores of [[0.8, -12.8, 60.6], [-1], [7, 7], [0], [null, 3]]) {
      const sec = compartilhandoOZero(valores, primaria, CAIXA);
      expect(sec, "devia haver escala").not.toBeNull();
      expect(sec!.pxDoZero!).toBeCloseTo(primaria.pxDoZero!, 6);
    }
  });

  it("todo valor cabe dentro da faixa desenhada", () => {
    const primaria = escala(-2.112, 2.112, CAIXA);
    const valores = [0.8, -12.8, 60.6, -6];
    const sec = compartilhandoOZero(valores, primaria, CAIXA)!;
    for (const v of valores) {
      expect(sec.px(v)).toBeLessThanOrEqual(CAIXA.inicio + 1e-9);
      expect(sec.px(v)).toBeGreaterThanOrEqual(CAIXA.fim - 1e-9);
    }
  });

  it("valor maior sobe no desenho, sempre", () => {
    const sec = compartilhandoOZero([-12.8, 0.8, 60.6], escala(-5, 5, CAIXA), CAIXA)!;
    const ys = [-12.8, -6, 0, 0.8, 60.6].map((v) => sec.px(v));
    for (let i = 1; i < ys.length; i += 1) expect(ys[i]!).toBeLessThan(ys[i - 1]!);
  });

  it("sem zero na primária, ou com ele na borda, não há escala compartilhada", () => {
    expect(compartilhandoOZero([1, 2], escala(2, 8, CAIXA), CAIXA)).toBeNull();
    expect(compartilhandoOZero([1, 2], escala(0, 8, CAIXA), CAIXA)).toBeNull();
    expect(compartilhandoOZero([1, 2], escala(-8, 0, CAIXA), CAIXA)).toBeNull();
  });

  it("piso de alcance impede que ruído de 0,1% encoste no topo", () => {
    const sec = compartilhandoOZero([0.1], escala(-5, 5, CAIXA), CAIXA, { minimoAbs: 5 })!;
    expect(sec.hi).toBeGreaterThanOrEqual(5);
    expect(sec.px(0.1)).toBeGreaterThan(sec.px(sec.hi) + 10);
  });

  it("tudo nulo ou zero põe a série na régua, sem inventar proporção", () => {
    const primaria = escala(-5, 5, CAIXA);
    const sec = compartilhandoOZero([null, 0, undefined], primaria, CAIXA)!;
    expect(sec.px(0)).toBeCloseTo(primaria.pxDoZero!, 6);
  });
});

describe("o desenho renderizado", () => {
  /**
   * Quatro casas na ordem que o cartão desenha. `SL` (+0,8%) é o caso fino:
   * com escalas separadas, sairia ABAIXO da régua.
   */
  const CASAS_LUIS = [
    { label: "Pinnacle", v: 1.21, roi: 60.6 },
    { label: "SL", v: 0.03, roi: 0.8 },
    { label: "(sem casa)", v: -0.18, roi: -6.0 },
    { label: "Bet365", v: -1.92, roi: -12.8 },
  ];

  it("ROI positivo fica ACIMA da régua e negativo abaixo", () => {
    const html = renderDesignMarkup(
      <MonthlyChart data={CASAS_LUIS} />,
    );
    const zero = regua(html);
    const [pinnacle, sl, semCasa, bet365] = circulos(html);
    expect(sl!, "SL tem ROI +0,8% e foi desenhada abaixo do zero").toBeLessThan(zero);
    expect(pinnacle!).toBeLessThan(sl!);
    expect(semCasa!).toBeGreaterThan(zero);
    expect(bet365!).toBeGreaterThan(semCasa!);
  });

  it("o eixo do ROI se declara — a régua diz que também é zero para os pontos", () => {
    const html = renderDesignMarkup(
      <MonthlyChart data={CASAS_LUIS} />,
    );
    expect(html).toContain("0.0%");
  });

  it("a linha de CLV cruza a régua exatamente onde o CLV é zero", () => {
    const rows = [
      { l: "S1", roi: 5, clv: 4, n: 3 },
      { l: "S2", roi: -5, clv: 0, n: 3 },
      { l: "S3", roi: 2, clv: -6, n: 3 },
    ];
    const html = renderDesignMarkup(<RCChart rows={rows} />);
    const zero = regua(html);
    const [c1, c2, c3] = circulos(html);
    expect(c2!, "CLV 0 devia cair na régua").toBeCloseTo(zero, 6);
    expect(c1!).toBeLessThan(zero);
    expect(c3!).toBeGreaterThan(zero);
  });
});

describe("o ranking desenha na ordem que o título promete", () => {
  const SEG_TARGET = [
    { k: "Handicap – Match", n: 17, settledN: 17, lucro: 0.03, roi: 0.1, stake: 22, clv: null, clvN: 0 },
    { k: "Moneyline", n: 9, settledN: 9, lucro: 1.58, roi: 17.5, stake: 9, clv: null, clvN: 0 },
    { k: "Total (Bookings) – Match", n: 6, settledN: 6, lucro: -1.09, roi: -18.1, stake: 6, clv: null, clvN: 0 },
    { k: "Handicap – Game", n: 4, settledN: 4, lucro: 3.97, roi: 74.5, stake: 5.3, clv: null, clvN: 0 },
    { k: "Both Teams Cards – Match", n: 2, settledN: 2, lucro: -0.45, roi: -22.5, stake: 2, clv: null, clvN: 0 },
  ].map((s) => ({ ...s, l: "", membros: [], clvPct: null, acerto: null, pendingN: 0 }));

  /** Os rótulos das barras do ranking, na ordem em que saem no HTML. */
  function ordemDesenhada(): string[] {
    const html = renderDesignMarkup(
      <SegmentosTab
        periodCard={null}
        segData={SEG_TARGET}
        carteira={null}
        segView="mercado"
        segViews={["esporte", "mercado", "competicao", "pais"]}
        setSegView={() => {}}
        abrirRecorte={() => {}}
      />,
    );
    expect(html, "a lista não declara por qual métrica está ordenada").toContain('data-ranking="lucro"');
    return [...html.matchAll(/data-rank-label="([^"]+)"/g)].map((m) => m[1]!);
  }

  it("o líder por lucro é a primeira barra do 'Ranking por lucro'", () => {
    const ordem = ordemDesenhada();
    expect(ordem).toEqual(ranking(SEG_TARGET, "lucro").map((s) => s.k));
    expect(ordem[0], "o mercado de +3,97u devia abrir o ranking").toBe("Handicap – Game");
  });

  it("ranking manda nulo para o fim, sem sentinela numérica", () => {
    const linhas = [{ v: -50 }, { v: null }, { v: 2 }, { v: Number.NaN }, { v: 10 }];
    expect(ranking(linhas, "v").map((l) => l.v)).toEqual([10, 2, -50, null, Number.NaN]);
    expect(ranking(linhas, (l: { v: number | null }) => l.v)[0]!.v).toBe(10);
    expect(ranking(null, "v")).toEqual([]);
  });
});

describe("nenhum gráfico desenha nada em silêncio", () => {
  /**
   * Completude. Gráfico sem estado vazio renderiza um flex de altura zero e o
   * cartão fica com título e nada, indistinguível de quebra.
   * A varredura sai dos EXPORTS, então gráfico novo nasce coberto ou reprova.
   *
   * `Heatmap` fica de fora com motivo: é matriz de dia×hora, não série. A grade
   * inteira é o desenho, e ela existe mesmo sem nenhuma aposta dentro.
   */
  it("todo gráfico exportado declara o vazio", () => {
    const vazio = {
      larguraInicial: 400,
      items: [], bins: [], pts: [], data: [], rows: [], labels: [], series: [],
    };
    const componentes = Object.entries({ ...LINHA_DO_TEMPO, ...DISTRIBUICAO }).filter(([nome]) => nome !== "Heatmap");
    expect(componentes.length, "a varredura ficou sem gráficos para conferir").toBeGreaterThanOrEqual(5);
    for (const [nome, Componente] of componentes) {
      const html = renderDesignMarkup(
        createElement(Componente as React.FunctionComponent<typeof vazio>, vazio),
      );
      expect(html, `${nome} não declara o estado vazio`).toContain("Sem dados suficientes");
    }
  });
});

describe("as marcas do eixo y são redondas", () => {
  it("usa passos 1, 2, 2,5 ou 5 × 10ⁿ e inclui o zero quando o alcance o cruza", () => {
    expect(marcasRedondas(-8.5, 25.8)).toEqual([0, 10, 20]);
    expect(marcasRedondas(-5.75, 27.77)).toEqual([0, 10, 20]);
    expect(marcasRedondas(0, 45.78)).toEqual([0, 20, 40]);
    expect(marcasRedondas(-374, 3500)).toEqual([0, 1000, 2000, 3000]);
    expect(marcasRedondas(-2127, 0)).toEqual([-2000, -1000, 0]);
    expect(marcasRedondas(-0.3, 0.3)).toEqual([-0.2, 0, 0.2]);
    expect(marcasRedondas(0, 1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("fica dentro do alcance e nunca mais apertada que o alvo pede", () => {
    for (const [lo, hi] of [[-7.3, 91.2], [-0.04, 0.9], [-1234, 56], [0, 3.3], [-12.5, 12.5]] as const) {
      const marcas = marcasRedondas(lo, hi);
      expect(marcas).toContain(0);
      for (const m of marcas) {
        expect(m).toBeGreaterThanOrEqual(lo);
        expect(m).toBeLessThanOrEqual(hi);
        // Redonda: a mantissa do passo é 1, 2, 2,5 ou 5.
        expect(Number(m.toPrecision(12))).toBe(m);
      }
      const passo = marcas[1]! - marcas[0]!;
      expect(passo).toBeGreaterThanOrEqual((hi - lo) / 4 - 1e-9);
      const mantissa = passo / 10 ** Math.floor(Math.log10(passo));
      expect([1, 2, 2.5, 5].some((m) => Math.abs(mantissa - m) < 1e-9)).toBe(true);
    }
  });

  it("alcance vazio não inventa marcas", () => {
    expect(marcasRedondas(0, 0)).toEqual([0]);
    expect(marcasRedondas(3, 3)).toEqual([]);
    expect(marcasRedondas(Number.NaN, 1)).toEqual([]);
  });
});

describe("o eixo x só mostra as datas que cabem", () => {
  const dias = (n: number) => Array.from({ length: n }, (_, i) => `${String((i % 28) + 1).padStart(2, "0")}/08`);
  const largura = (fonte: number, texto = "31/07") => texto.length * fonte * 0.62 + fonte;

  it("no celular, 40 datas viram poucas, espaçadas sem encavalar, sempre com a última", () => {
    const rotulos = dias(40);
    const util = 330;
    const indices = rotulosQueCabem(rotulos, util, 10.5);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(39);
    expect(indices.length).toBeLessThan(10);
    // Posição de cada rótulo com as âncoras do desenho: início, meio, fim.
    const caixa = (i: number) => {
      const x = (util * i) / 39, w = largura(10.5);
      return i === 0 ? [x, x + w] : i === 39 ? [x - w, x] : [x - w / 2, x + w / 2];
    };
    for (let k = 1; k < indices.length; k++) {
      expect(caixa(indices[k]!)[0]).toBeGreaterThanOrEqual(caixa(indices[k - 1]!)[1]!);
    }
  });

  it("com espaço de sobra, mostra todas", () => {
    expect(rotulosQueCabem(dias(6), 1000, 10)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("largura menor que duas datas mostra só a mais recente", () => {
    expect(rotulosQueCabem(dias(10), 60, 10)).toEqual([9]);
    expect(rotulosQueCabem(["01/08"], 20, 10)).toEqual([0]);
    expect(rotulosQueCabem([], 300, 10)).toEqual([]);
  });
});
