import { describe, expect, it } from "vitest";
import {
  getPeriodHighlights,
  percentOf,
} from "@/app/_design/lib/analyzer-view";

describe("analyzer view helpers", () => {
  it("não produz porcentagem inválida em recortes vazios", () => {
    expect(percentOf(0, 0)).toBe(0);
    expect(percentOf(3, 4)).toBe(75);
  });

  it("deriva destaques dos períodos reais em vez de rótulos fixos", () => {
    const jan = { label: "Jan/26", lucro: -2, roi: -10 };
    const fev = { label: "Fev/26", lucro: 4, roi: 20 };
    const s5 = { l: "S05", roi: 12, lucro: 1 };
    const s6 = { l: "S06", roi: 8, lucro: 2 };
    const result = getPeriodHighlights({ monthly: [jan, fev], weekly: [s5, s6] });

    expect(result.bestMonth).toBe(fev);
    expect(result.worstMonth).toBe(jan);
    expect(result.bestWeek).toBe(s5);
    expect(result.lastWeek).toBe(s6);
  });

  it("mantém destaques nulos quando não há histórico", () => {
    expect(getPeriodHighlights({ monthly: [], weekly: [] })).toMatchObject({
      bestMonth: null,
      worstMonth: null,
      bestWeek: null,
      lastWeek: null,
    });
  });

  it("não promove período sem aposta financeira a destaque", () => {
    const voidOnly = { label: "Jan/26", lucro: 0, roi: 0, settledN: 0 };
    const loss = { label: "Fev/26", lucro: -1, roi: -100, settledN: 1 };
    const result = getPeriodHighlights({ monthly: [voidOnly, loss], weekly: [] });
    expect(result.bestMonth).toBe(loss);
    expect(result.worstMonth).toBe(loss);
  });
});
