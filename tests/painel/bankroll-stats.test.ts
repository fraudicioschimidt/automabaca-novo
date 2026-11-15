import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderDesignMarkup } from "../helpers/design-markup";
import type { BankrollBet } from "@/app/_design/screens/bankroll/types";
import { BETS } from "@/app/_design/mock/bet";
import { StatsView, summarizeLineMovements } from "@/app/_design/screens/bankroll-stats";

describe("estatísticas de movimento de linha", () => {
  it("só conta apostas com o movimento medido; sem medição não vira estável", () => {
    const result = summarizeLineMovements([
      { d: { moveType: null } },
      { d: { moveType: "steam" } },
      { d: { moveType: "drift" } },
      { d: { moveType: "estavel" } },
      { d: { moveType: null } },
    ]);

    expect(result).toEqual({ steam: 1, drift: 1, estavel: 1 });
  });
});


describe("métricas exibidas nas estatísticas", () => {
  it.each([false, true])("reembolso encerrado não aparece em aberto (pendente real: %s)", (pending) => {
    const base = BETS[0]!;
    const bets: BankrollBet[] = [{ ...base, id: "ganha", status: "won" as const, profit: 1 }, { ...base, id: "anulada", status: "void" as const, profit: 0 }];
    if (pending) bets.push({ ...base, id: "pendente", status: "pending", profit: null });
    const html = renderDesignMarkup(createElement(StatsView, { bets }));
    expect(html).toContain(`1 liquidada · ${pending ? 1 : 0} em aberto · 1 reembolso`);
  });

  it.each(["region", "line"] as const)("nomes reservados em %s mantêm contagens e médias", (field) => {
    const bets = ["constructor", "__proto__", "toString"].map((key, i) => ({ ...BETS[0]!, id: `reserved-${i}`, [field]: key, clv: i + 1, clvSituacao: "tem" as const }));
    const html = renderDesignMarkup(createElement(StatsView, { bets }));
    for (const key of ["constructor", "__proto__", "toString"]) expect(html).toContain(key);
    expect(html).toContain("+2.0%");
  });

  it("distribuição de seleções não apresenta moneyline como linha de gols", () => {
    const bets = [{ ...BETS[0]!, market: "Moneyline", line: "Mandante", esporte: "Basketball" }];
    const html = renderDesignMarkup(createElement(StatsView, { bets }));
    expect(html).toContain("Por seleção / linha");
    expect(html).not.toContain("distribuição por linha de gols");
  });
});
