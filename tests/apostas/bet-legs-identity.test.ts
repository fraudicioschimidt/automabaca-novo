import { expect, it } from "vitest";
import { sameBetLegs } from "@/src/domain/bet-legs";

const leg = { evento: "France vs Spain", mercado: "Handicap", selecao: "France -0.25" };
const total = { evento: "France vs Spain", mercado: "Total", selecao: "Over 2.5" };
const ticket = { kind: "same_game", legs: [leg, total] };

it("ordem e caixa das mesmas pernas são cosméticas", () => {
  expect(sameBetLegs(ticket, { kind: "same_game", legs: [total, { ...leg, selecao: "FRANCE -0.25" }] })).toBe(true);
});

it("preserva diferenças financeiras de sinal, lado e quantidade de pernas", () => {
  expect(sameBetLegs(ticket, { kind: "same_game", legs: [{ ...leg, selecao: "France +0.25" }, total] })).toBe(false);
  expect(sameBetLegs(ticket, { kind: "same_game", legs: [leg, { ...total, selecao: "Under 2.5" }] })).toBe(false);
  expect(sameBetLegs(ticket, { kind: "same_game", legs: [leg, total, total] })).toBe(false);
  expect(sameBetLegs(ticket, null)).toBe(false);
  expect(sameBetLegs({ kind: "same_game", legs: [] }, ticket)).toBe(false);
});
