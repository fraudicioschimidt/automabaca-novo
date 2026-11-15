import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import { lacunasDeCobertura, type LinhaSemOdds } from "@/src/domain/lacuna-de-cobertura";
import { MOTIVOS_FORA_DA_BASE, SUPPLIER_NO_ODDS_REASONS, noOddsReasonBase } from "@/src/domain/no-odds-reason";
import { lacunaNaTela, textoDoSegmento } from "@/app/_design/lib/lacuna-na-tela";
import { NoOddsCard } from "@/app/_design/screens/operacoes/no-odds-card";

/**
 * Cartão agrega a base do propósito que declara — e lista cortada na CONSULTA
 * não pode ser cortada sem a tela saber.
 *
 * O cartão "Sem odds" serve para decidir o que consertar. Para isso não pode
 * agrupar tão fino que vire grupos de ~1 aposta cortados por um `LIMIT`
 * calado, nem misturar as três bases: a do fornecedor (comprar cobertura), a
 * do sistema (conserto nosso) e a que não se aplica (ao vivo, política da
 * banca, múltipla). Misturadas, uma soterra a outra.
 *
 * Mesma regra de `cobertura-na-tela` no PERCENTUAL: o domínio separa as
 * bases, e a tela tem de separar também.
 */

function linha(reason: string, n: number, segmentos = 1): LinhaSemOdds {
  return { lado: "fechamento", reason, n, segmentos, topoSegmento: "Brazil · Serie A", topoN: n };
}

/** Amostra realista, com os três lados e as três bases. */
const PRODUCAO: LinhaSemOdds[] = [
  { lado: "identidade", reason: "clv_only", n: 53, segmentos: 37, topoSegmento: "Club Friendlies", topoN: 6 },
  { lado: "fechamento", reason: "aposta_ao_vivo", n: 34, segmentos: 27, topoSegmento: "Club Friendlies", topoN: 4 },
  { lado: "fechamento", reason: "unsupported_market", n: 28, segmentos: 16, topoSegmento: "Spain · La Liga", topoN: 4 },
  { lado: "identidade", reason: "sharp_off", n: 26, segmentos: 20, topoSegmento: "Brazil · Serie A", topoN: 3 },
  { lado: "identidade", reason: "no_prices", n: 17, segmentos: 10, topoSegmento: "Spain · La Liga", topoN: 5 },
  { lado: "fechamento", reason: "kickoff_sem_captura", n: 6, segmentos: 5, topoSegmento: "Brazil · Serie A", topoN: 2 },
  { lado: "fechamento", reason: "line_mismatch", n: 4, segmentos: 3, topoSegmento: "Brazil · Campeonato Paulista", topoN: 2 },
  { lado: "abertura", reason: "falha_na_consulta", n: 2, segmentos: 2, topoSegmento: "Spain · La Liga", topoN: 1 },
  { lado: "identidade", reason: "multipla", n: 3, segmentos: 3, topoSegmento: "Brasil · Paulista A-1", topoN: 1 },
];

describe("as três bases saem separadas, e pelo SSOT", () => {
  it("a classificação vem do vocabulário, não de lista redigitada", () => {
    const { fornecedor, sistema, naoSeAplica } = lacunasDeCobertura(
      [...MOTIVOS_FORA_DA_BASE, ...SUPPLIER_NO_ODDS_REASONS, "motivo_que_ainda_nao_existe"].map((motivo) => linha(motivo, 1)),
    );
    expect(naoSeAplica.linhas.map((l) => l.reason).sort()).toEqual([...MOTIVOS_FORA_DA_BASE].sort());
    expect(fornecedor.linhas.map((l) => l.reason).sort()).toEqual([...SUPPLIER_NO_ODDS_REASONS].sort());
    // Motivo desconhecido é conserto nosso: continua contando contra nós.
    expect(sistema.linhas.map((l) => l.reason)).toEqual(["motivo_que_ainda_nao_existe"]);
    expect(noOddsReasonBase("kickoff_sem_captura")).toBe("sistema");
  });

  it("nenhuma aposta se perde entre as bases", () => {
    const { fornecedor, sistema, naoSeAplica, total } = lacunasDeCobertura(PRODUCAO);
    expect(fornecedor.total + sistema.total + naoSeAplica.total).toBe(total);
    expect(total).toBe(PRODUCAO.reduce((s, l) => s + l.n, 0));
    expect(fornecedor.total).toBe(49);
    expect(sistema.total).toBe(8);
    expect(naoSeAplica.total).toBe(116);
  });

  it("a fração é da PRÓPRIA base, não da soma delas", () => {
    const { fornecedor, sistema, naoSeAplica } = lacunasDeCobertura(PRODUCAO);
    for (const grupo of [fornecedor, sistema, naoSeAplica]) {
      const soma = grupo.linhas.reduce((s, l) => s + l.pct, 0);
      expect(soma).toBeCloseTo(100, 6);
    }
    // 28 de 49 na base do fornecedor é 57%; de 173 seria 16% — a conta errada.
    const maior = fornecedor.linhas[0]!;
    expect(maior.reason).toBe("unsupported_market");
    expect(Math.round(maior.pct)).toBe(57);
  });

  it("base vazia não divide por zero", () => {
    const so = lacunasDeCobertura([linha("aposta_ao_vivo", 4)]);
    expect(so.fornecedor.total).toBe(0);
    expect(so.fornecedor.linhas).toEqual([]);
    expect(so.sistema.linhas).toEqual([]);
    expect(lacunasDeCobertura([]).total).toBe(0);
  });
});

describe("o cartão publica as três bases, na ordem da decisão", () => {
  const render = () => renderDesignMarkup(
    <NoOddsCard noOdds={lacunaNaTela(PRODUCAO)} />,
  );

  it("os três cabeçalhos declaram o que o número pede", () => {
    const html = render();
    expect(html).toContain("49 apostas — decisão de cobertura");
    expect(html).toContain("8 apostas — conserto nosso");
    expect(html).toContain("116 apostas — a métrica não se aplica");
    expect(html).toContain("173 apostas sem odds");
  });

  it("declara a janela: o motivo fica gravado na aposta, e sem ela o número seria o histórico inteiro", () => {
    expect(render()).toContain("jogos dos últimos 30 dias");
  });

  it("cobertura primeiro, conserto nosso depois, o que não se aplica por último", () => {
    const html = render();
    expect(html.indexOf("decisão de cobertura")).toBeLessThan(html.indexOf("conserto nosso"));
    expect(html.indexOf("conserto nosso")).toBeLessThan(html.indexOf("a métrica não se aplica"));
  });

  it("o mesmo motivo em lados diferentes não colide", () => {
    const tela = lacunaNaTela([
      { ...linha("partida_nao_localizada", 2), lado: "abertura" },
      { ...linha("partida_nao_localizada", 1), lado: "fechamento" },
    ]);
    expect(tela.fornecedor.linhas.map((l) => l.id)).toEqual([
      "abertura-partida_nao_localizada",
      "fechamento-partida_nao_localizada",
    ]);
  });

  it("a fração declara de que base é", () => {
    const html = render();
    expect(html).toContain("de cada base");
  });

  it("o segmento continua alcançável, e não diz 'maior' com um só", () => {
    expect(textoDoSegmento({
      ...linha("no_prices", 17, 10), id: "x", rotulo: "y", pct: 1,
      topoSegmento: "Spain · La Liga", topoN: 5,
    })).toBe("em 10 segmentos · maior: Spain · La Liga (5)");
    expect(textoDoSegmento({
      ...linha("no_prices", 2, 1), id: "x", rotulo: "y", pct: 1,
      topoSegmento: "Brazil · Serie A", topoN: 2,
    })).toBe("Brazil · Serie A");
  });
});
