import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import {
  JANELA_DE_RENDIMENTO_DIAS,
  TIPOS_DE_TRABALHO,
} from "@/src/domain/rendimento-de-provider";
import {
  textoDeRendimento,
  textoDoCusto,
} from "@/app/_design/lib/rendimento-na-tela";
import { PROVIDER_CAPS } from "@/src/providers/budget-config";
import { BudgetsCard } from "@/app/_design/screens/operacoes/budgets-card";

/**
 * Custo e entrega na mesma linha dizem de que janela é cada um — e a contagem
 * de entrega enxerga TODAS as colunas de autoria.
 *
 * No card "Budgets de providers", o custo é da janela do teto (às vezes a hora
 * corrente) e a entrega é de outra; sem nomear as duas, uma chave de período
 * entre elas parece governar ambas. E a entrega do flashscore mora em
 * `bet_result.resultProvider`: contagem que não lê essa coluna mostra o
 * provider que mais entrega como custo puro.
 *
 * As duas janelas são diferentes de propósito (o custo é do período do teto;
 * o rendimento, de 7 dias — a hora corrente do bridgeodds seria ruído). O que
 * não podem é ficar mudas. Família do `resumo-de-apostas`.
 */

describe("as duas janelas são declaradas", () => {
  it("todo período de teto em uso sabe se dizer em palavras", () => {
    for (const cap of PROVIDER_CAPS) {
      expect(textoDoCusto(cap.period), `período ${cap.period} sem frase`).not.toBe("no período");
    }
  });
});

describe("a frase do rendimento", () => {
  it("nomeia a janela e concorda em número", () => {
    expect(textoDeRendimento({ identidade: 1 })).toBe(`${JANELA_DE_RENDIMENTO_DIAS} dias: 1 identidade`);
    expect(textoDeRendimento({ identidade: 116, fechamento: 66 })).toBe(
      `${JANELA_DE_RENDIMENTO_DIAS} dias: 116 identidades · 66 fechamentos`,
    );
  });

  it("diz a ausência em vez de sumir — provider que gasta e não entrega é o que importa ver", () => {
    expect(textoDeRendimento({})).toBe(`${JANELA_DE_RENDIMENTO_DIAS} dias: nada atribuído`);
    expect(textoDeRendimento({ resultado: 0 })).toContain("nada atribuído");
  });

  it("cada tipo de trabalho sabe aparecer sozinho", () => {
    for (const tipo of TIPOS_DE_TRABALHO) {
      expect(textoDeRendimento({ [tipo]: 2 })).not.toContain("nada atribuído");
    }
  });
});

describe("o card publica as duas janelas", () => {
  const budgets = [
    {
      name: "bridgeodds", period: "2026-08-19T00", janelaDoCusto: "hour" as const,
      used: 25, cap: 900, label: "900/h", rendimento: { identidade: 116, fechamento: 66 },
    },
    {
      name: "flashscore", period: "2026-08-18", janelaDoCusto: "day" as const,
      used: 79, cap: 900, label: "900/dia", rendimento: { resultado: 111 },
    },
    {
      name: "pinnacle17", period: "2026-08", janelaDoCusto: "month" as const,
      used: 250, cap: 250, label: "250/mês", rendimento: {},
    },
  ];

  const html = renderDesignMarkup(
    <BudgetsCard budgets={budgets} />,
  );

  it("o gasto vem com a janela do teto por extenso", () => {
    expect(html).toContain("25/900");
    expect(html).toContain("nesta hora");
    expect(html).toContain("hoje");
    expect(html).toContain("neste mês");
  });

  it("a entrega vem com a própria janela, e o resultado do flashscore aparece", () => {
    expect(html).toContain("111 resultados");
    expect(html).toContain(`${JANELA_DE_RENDIMENTO_DIAS} dias`);
  });

  it("provider que queimou a cota sem entregar nada diz isso", () => {
    expect(html).toContain("250/250");
    expect(html).toContain("nada atribuído");
  });

  it("nenhum número de entrega sai sem janela", () => {
    expect(html).not.toContain("atribuída");
    expect(html).not.toContain("atribuídas");
  });
});
