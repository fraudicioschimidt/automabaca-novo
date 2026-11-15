import { describe, expect, it } from "vitest";
import { concentracao, fraseDeConcentracao } from "@/app/_design/lib/concentracao";

/**
 * A tira de concentração diz quanto do stake está nos N maiores grupos.
 *
 * O que este portão guarda são as RECUSAS. Um top-5 que na verdade são 3, ou um
 * percentual calculado sobre stake zero, produz número plausível e falso — que é
 * o tipo de erro que ninguém percebe olhando a tela.
 */

const linha = (l: string, stake: number, n = 1) => ({ l, k: l, stake, n });

describe("concentração do stake", () => {
  it("soma os N maiores e devolve a fração do total", () => {
    const c = concentracao([
      linha("A", 10, 5), linha("B", 6, 3), linha("C", 2, 1), linha("D", 1, 1), linha("E", 1, 1), linha("F", 0.5, 1),
    ], 3);
    expect(c.stakeTop).toBe(18);
    expect(c.stakeTotal).toBe(20.5);
    expect(c.pct).toBeCloseTo(87.8, 1);
    expect(c.apostasTop).toBe(9);
    expect(c.apostasTotal).toBe(12);
    expect(c.parcial).toBe(false);
  });

  it("ordena por stake, não pela ordem de chegada", () => {
    const c = concentracao([linha("pequena", 1), linha("grande", 99), linha("média", 10)], 1);
    expect(c.stakeTop).toBe(99);
  });

  it("com menos grupos que N, marca parcial e diz o número real", () => {
    const c = concentracao([linha("A", 4), linha("B", 6)], 5);
    expect(c.parcial).toBe(true);
    expect(c.n).toBe(2);
    expect(c.gruposTotal).toBe(2);
    expect(c.pct).toBe(100);
    // Com o top-N cobrindo tudo, "as 2 maiores de 2 concentram 100%" seria uma
    // frase vazia. O que ainda informa é o MAIOR sozinho.
    expect(c.pctMaior).toBe(60);
    expect(fraseDeConcentracao(c, "ligas")).toBe("São 2 ligas ao todo, e a maior concentra 60% do stake liquidado.");
    expect(fraseDeConcentracao(c, "ligas")).not.toContain("As 5 maiores");
  });

  it("com stake total zero não inventa percentual", () => {
    const c = concentracao([linha("A", 0), linha("B", 0)], 5);
    expect(c.pct).toBeNull();
    expect(fraseDeConcentracao(c, "casas")).toBeNull();
  });

  it("recorte vazio não vira frase nenhuma", () => {
    const c = concentracao([], 5);
    expect(c.gruposTotal).toBe(0);
    expect(c.pct).toBeNull();
    expect(fraseDeConcentracao(c, "casas")).toBeNull();
  });

  it("um grupo só é 100% e vale ser dito — é o achado, não um caso de esconder", () => {
    const c = concentracao([linha("Brasileirão", 12, 6)], 5);
    expect(c.pct).toBe(100);
    expect(fraseDeConcentracao(c, "ligas")).toBe("Todo o stake liquidado está em uma liga só (Brasileirão).");
    expect(fraseDeConcentracao(c, "competições")).toContain("uma competição só");
  });

  it("empate na fronteira do corte não altera a soma do topo", () => {
    // B, C e D empatam: qualquer um que entre no top 2 dá o mesmo stake.
    const c = concentracao([linha("A", 10), linha("B", 5), linha("C", 5), linha("D", 5)], 2);
    expect(c.stakeTop).toBe(15);
    expect(c.pct).toBeCloseTo(60, 5);
  });

  it("ignora linha sem stake numérico em vez de somar NaN", () => {
    const c = concentracao([linha("A", 10), { l: "B", stake: undefined, n: 2 }, linha("C", 10)] as never, 5);
    expect(c.gruposTotal).toBe(2);
    expect(c.stakeTotal).toBe(20);
    expect(Number.isNaN(c.pct)).toBe(false);
  });

  it("exatamente N grupos ainda é o top completo, não parcial pela metade", () => {
    const c = concentracao([linha("A", 1), linha("B", 1), linha("C", 1)], 3);
    expect(c.n).toBe(3);
    // 3 grupos e top-3: a frase "as 3 maiores concentram 100%" seria verdadeira e
    // inútil. `parcial` cobre o caso, e o texto diz o total.
    expect(c.parcial).toBe(true);
    expect(fraseDeConcentracao(c, "casas")).toBe("São 3 casas ao todo, e a maior concentra 33% do stake liquidado.");
  });
});
