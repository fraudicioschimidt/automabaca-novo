import { describe, expect, it } from "vitest";
import {
  SEGMENTOS_DE_CONFIG,
  SEGMENTOS_DO_MONITORAMENTO,
  formaDoContador,
  legendaDoSegmento,
  type Segmento,
  type TipoDeContador,
} from "@/app/_design/lib/segmentos-de-secao";

/**
 * O número de uma aba declara O QUE CONTA — e inventário nunca alcança o token
 * de atenção.
 *
 * O token mais forte da tela (accent SÓLIDO com texto invertido) não pode dizer
 * duas coisas opostas. `Liquidar 1` é trabalho parado esperando o operador;
 * `Times 650` é acervo, e ninguém precisa fazer nada com ele. Com o
 * mesmo token, o olho pousaria primeiro onde não há decisão nenhuma. Mesma família do
 * `resumo-de-apostas` — um número contando uma coisa e sendo lido como outra.
 */

const TODOS_OS_SEGMENTOS = [...SEGMENTOS_DO_MONITORAMENTO, ...SEGMENTOS_DE_CONFIG];

const TIPOS_VALIDOS: readonly TipoDeContador[] = ["fila", "inventario", "sem-contagem"];

/** Amostra de `n` que cobre as bordas que já morderam: 0, negativo, não-número. */
const NUMEROS = [0, 1, 2, 7, 650, -1, 1e6];

describe("vocabulário: toda aba declara o que o número dela conta", () => {
  it("cobre as três telas, sem id repetido", () => {
    expect(SEGMENTOS_DO_MONITORAMENTO.map((segment) => segment.id)).toEqual([
      "incidentes", "desempenho", "ocr", "providers", "canais", "manutencao",
    ]);
    expect(SEGMENTOS_DO_MONITORAMENTO.find((segment) => segment.id === "ocr")?.tipo).toBe("sem-contagem");
    expect(SEGMENTOS_DE_CONFIG.length).toBe(5);
    expect(SEGMENTOS_DE_CONFIG.find((segment) => segment.id === "jogadores")?.tipo).toBe("sem-contagem");

    const ids = TODOS_OS_SEGMENTOS.map((s) => s.id);
    // Os ids viram `segmento-painel-<id>` / `segmento-tab-<id>` no DOM: repetido
    // entre telas é tolerável, repetido DENTRO de uma tela quebra o aria.
    for (const tela of [SEGMENTOS_DO_MONITORAMENTO, SEGMENTOS_DE_CONFIG]) {
      const daTela = tela.map((s) => s.id);
      expect(new Set(daTela).size).toBe(daTela.length);
    }
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it("nenhum `tipo` fora do vocabulário, nenhum rótulo vazio", () => {
    for (const s of TODOS_OS_SEGMENTOS) {
      expect(TIPOS_VALIDOS, `segmento ${s.id} declara tipo desconhecido`).toContain(s.tipo);
      expect(s.rotulo.trim().length, `segmento ${s.id} sem rótulo`).toBeGreaterThan(0);
    }
  });

  /**
   * Bancas e aliases são CADASTRO: o número diz o tamanho do acervo, não que
   * exista trabalho parado. Classificá-los como `fila` é o erro que este teste
   * impede.
   */
  it("Config é inventário; Monitoramento é fila ou sem contagem", () => {
    // Largos de propósito: o registro já tem os tipos literais, e o teste
    // confere o valor em execução.
    const config: readonly Segmento[] = SEGMENTOS_DE_CONFIG;
    expect(config.some((s) => s.tipo === "fila")).toBe(false);
    expect(config.filter((s) => s.tipo === "inventario").map((s) => s.id))
      .toEqual(["bancas", "times"]);

    const trabalho: readonly Segmento[] = SEGMENTOS_DO_MONITORAMENTO;
    expect(trabalho.some((s) => s.tipo === "inventario")).toBe(false);
  });
});

describe("significado → desenho: a tradução é fechada", () => {
  it("inventário NUNCA vira atenção nem resolvido, para nenhum n", () => {
    for (const n of NUMEROS) {
      expect(formaDoContador("inventario", n), `n=${n}`).toBe("inventario");
    }
  });

  it("inventário zerado mostra a contagem, nunca `em dia` — não há o que resolver num acervo", () => {
    const tipsters = SEGMENTOS_DE_CONFIG.find((segment) => segment.id === "bancas")!;
    expect(formaDoContador("inventario", 0)).toBe("inventario");
    expect(legendaDoSegmento(tipsters, 0)).toBe("0 cadastrados");
    expect(legendaDoSegmento(tipsters, 650)).toBe("650 cadastrados");
  });

  it("fila com trabalho é atenção; fila zerada é resolvido", () => {
    expect(formaDoContador("fila", 1)).toBe("atencao");
    expect(formaDoContador("fila", 650)).toBe("atencao");
    expect(formaDoContador("fila", 0)).toBe("resolvido");
    const canais = SEGMENTOS_DO_MONITORAMENTO.find((segment) => segment.id === "canais")!;
    expect(legendaDoSegmento(canais, 0)).toBe("em dia");
    expect(legendaDoSegmento(canais, 1)).toBe("1 degradado");
    expect(legendaDoSegmento(canais, 5)).toBe("5 degradados");
  });

  it("`sem-contagem` não desenha, mesmo que alguém passe um número", () => {
    for (const n of NUMEROS) {
      expect(formaDoContador("sem-contagem", n), `n=${n}`).toBe("ausente");
    }
    const providers = SEGMENTOS_DO_MONITORAMENTO.find((segment) => segment.id === "providers")!;
    expect(legendaDoSegmento(providers, 5)).toBe("gasto e cotas");
  });

  it("número ausente ou inválido não desenha (viés fail-closed)", () => {
    for (const tipo of ["fila", "inventario"] as const) {
      expect(formaDoContador(tipo, null)).toBe("ausente");
      expect(formaDoContador(tipo, undefined)).toBe("ausente");
      expect(formaDoContador(tipo, Number.NaN)).toBe("ausente");
      expect(formaDoContador(tipo, Number.POSITIVE_INFINITY)).toBe("ausente");
    }
  });

  /**
   * A legenda é o mesmo texto para quem vê e para quem ouve: a unidade diz se o
   * número é pendência ou acervo, e sem leitura ela não inventa um zero.
   */
  it("a legenda diz a unidade e não inventa zero sem leitura", () => {
    const incidentes = SEGMENTOS_DO_MONITORAMENTO.find((segment) => segment.id === "incidentes")!;
    expect(legendaDoSegmento(incidentes, 1)).toBe("1 aberto");
    expect(legendaDoSegmento(incidentes, 10)).toBe("10 abertos");
    expect(legendaDoSegmento(incidentes, null)).toBe("sem leitura");
    expect(legendaDoSegmento(incidentes, Number.NaN)).toBe("sem leitura");
  });
});
