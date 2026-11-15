import { describe, expect, it } from "vitest";
import { indiceDaFaixa, indiceDaSerie, readoutLeft } from "@/app/_design/lib/chart-hover";

/**
 * Gráfico de barra não pode indexar como série contínua.
 *
 * O mapeamento de série contínua (`total - 1` passos, `Math.round`) é o caminho
 * óbvio para `MonthlyChart` e `RCChart`, e está errado por meia fatia: numa
 * barra o cursor pertence à faixa que o CONTÉM, não à divisória mais próxima.
 *
 * O sintoma é o pior tipo — não quebra, mente. A caixa abre, com números certos,
 * da barra errada; e as faixas das pontas viram alvos de meia largura, que o
 * operador lê como "o hover não pega aqui".
 *
 * Aritmética pura de propósito: o defeito é de fórmula, não de DOM, e provar em
 * navegador custaria 100× mais para cobrir menos casos.
 */

// Geometria de um gráfico real: `MonthlyChart` (padL 54, padR 54).
const ESCALA = { largura: 600, padL: 54, padR: 54 };
const UTIL = ESCALA.largura - ESCALA.padL - ESCALA.padR; // 492

describe("índice sob o cursor", () => {
  describe("faixa (barras e categorias)", () => {
    const total = 6;
    const fatia = UTIL / total; // 82

    it("o cursor pertence à faixa que o contém, do início ao fim", () => {
      for (let i = 0; i < total; i++) {
        const inicio = ESCALA.padL + fatia * i;
        const centro = inicio + fatia / 2;
        const fim = inicio + fatia - 0.001;
        expect(indiceDaFaixa(inicio, { total, ...ESCALA }), `início da faixa ${i}`).toBe(i);
        expect(indiceDaFaixa(centro, { total, ...ESCALA }), `centro da faixa ${i}`).toBe(i);
        expect(indiceDaFaixa(fim, { total, ...ESCALA }), `fim da faixa ${i}`).toBe(i);
      }
    });

    it("a faixa inteira do primeiro e do último é alcançável", () => {
      // Com o mapeamento contínuo, nas pontas só metade da faixa responderia.
      const fimDaPrimeira = ESCALA.padL + fatia - 0.001;
      expect(indiceDaFaixa(fimDaPrimeira, { total, ...ESCALA })).toBe(0);
      expect(indiceDaSerie(fimDaPrimeira, { total, ...ESCALA })).not.toBe(0);

      const inicioDaUltima = ESCALA.padL + fatia * (total - 1);
      expect(indiceDaFaixa(inicioDaUltima, { total, ...ESCALA })).toBe(total - 1);
      expect(indiceDaSerie(inicioDaUltima, { total, ...ESCALA })).not.toBe(total - 1);
    });

    it("cursor fora da área útil gruda na ponta em vez de estourar", () => {
      expect(indiceDaFaixa(0, { total, ...ESCALA })).toBe(0);
      expect(indiceDaFaixa(ESCALA.largura, { total, ...ESCALA })).toBe(total - 1);
    });

    it("largura zero ou série vazia devolve null, nunca NaN", () => {
      expect(indiceDaFaixa(10, { total: 0, ...ESCALA })).toBeNull();
      expect(indiceDaFaixa(10, { total: 3, largura: 0, padL: 0, padR: 0 })).toBeNull();
      // Antes da medição do contêiner a largura pode ser menor que o padding.
      expect(indiceDaFaixa(10, { total: 3, largura: 40, padL: 54, padR: 54 })).toBeNull();
    });
  });

  describe("série contínua", () => {
    const total = 5;
    const passo = UTIL / (total - 1); // 123

    it("cada ponto é o mais próximo do próprio x", () => {
      for (let i = 0; i < total; i++) {
        expect(indiceDaSerie(ESCALA.padL + passo * i, { total, ...ESCALA })).toBe(i);
      }
    });

    it("a divisa entre dois pontos cai no seguinte", () => {
      expect(indiceDaSerie(ESCALA.padL + passo * 0.5, { total, ...ESCALA })).toBe(1);
    });

    it("série de um ponto só não divide por zero", () => {
      expect(indiceDaSerie(300, { total: 1, ...ESCALA })).toBe(0);
    });
  });

});

describe("posição da caixa de leitura", () => {
  it("abre à direita do cursor e vira para a esquerda perto da borda", () => {
    expect(readoutLeft(150, 600, 158)).toBe("calc(25% + 12px)");
    expect(readoutLeft(480, 600, 158)).toBe("calc(80% - 170px)");
  });

  it("no gráfico estreito vira antes dos 72% quando não cabe à direita", () => {
    // 300px de largura, cursor em 60%: à direita a caixa terminaria em 360px.
    expect(readoutLeft(180, 300, 158)).toBe("calc(60% - 170px)");
  });

  it("sem lugar de nenhum lado, encosta na borda direita sem sair do cartão", () => {
    expect(readoutLeft(165, 300, 220)).toBe("80px");
  });
});
