import { describe, expect, it } from "vitest";
import { accentuate, accentVariants } from "@/src/domain/mercados/accents";
import { normalizeStr } from "@/src/domain/text";

/**
 * Implementação ÚNICA das grafias acentuadas. Com uma cópia por módulo
 * (vocabulário de empate, qualificador de estatística, consulta de placar),
 * cada lista nova esquece pelo menos uma delas e o termo fica sem variante.
 */
describe("accentuate", () => {
  it("as REGRAS de sufixo cobrem termo novo sem entrada em mapa", () => {
    for (const [termo, esperado] of [
      ["cartao", "cartão"],
      ["cartoes", "cartões"],
      ["finalizacoe", "finalizaçõe"],
      ["finalizacoes", "finalizações"],
      ["interceptacoe", "interceptaçõe"],
      ["devolucao", "devolução"],
      ["selecao", "seleção"],
      ["competicao", "competição"],
      ["dragoes", "dragões"],
      ["assistencia", "assistência"],
      ["assistencias", "assistências"],
      ["nao", "não"],
      ["campeao", "campeão"],
    ] as const) {
      expect(accentuate(termo), termo).toBe(esperado);
    }
  });

  it("o mapa cobre só o irregular, inclusive os escopos de outright da r25", () => {
    for (const [termo, esperado] of [
      ["titulo", "título"],
      ["taca", "taça"],
      ["trofeu", "troféu"],
      ["serie", "série"],
      ["campea", "campeã"],
      ["hipotese", "hipótese"],
      ["prejuizo", "prejuízo"],
      ["patrimonio", "patrimônio"],
    ] as const) {
      expect(accentuate(termo), termo).toBe(esperado);
    }
  });

  it("acentua palavra a palavra dentro da expressão e é estável sem acento", () => {
    expect(accentuate("empate nao tem aposta")).toBe("empate não tem aposta");
    expect(accentuate("dupla selecao")).toBe("dupla seleção");
    for (const termo of ["copa", "grupo", "liga", "torneio", "empate anula", "double chance"]) {
      expect(accentVariants(termo), termo).toEqual([termo]);
    }
  });

  it("a forma acentuada normaliza de volta para a forma sem acento", () => {
    // É o que garante que domínio (sem diacrítico) e SQL (com) falem do mesmo
    // termo: se a regra inventasse uma letra, o par deixaria de fechar.
    for (const termo of [
      "titulo", "taca", "trofeu", "serie", "campea", "campeao", "cartao",
      "cartoes", "devolucao", "selecao", "assistencias", "patrimonio",
    ]) {
      expect(normalizeStr(accentuate(termo)), termo).toBe(termo);
    }
  });
});
