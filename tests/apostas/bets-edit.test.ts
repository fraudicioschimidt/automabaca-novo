import { describe, expect, it } from "vitest";
import { Prisma } from "@/src/generated/prisma/client";
import { isIdentityCompatibleEdit } from "@/src/services/bets/edit";

describe("isIdentityCompatibleEdit", () => {
  it("os mesmos termos, com odd e stake numéricos, são compatíveis", () => {
    const now = new Date();
    const before = {
      data: now,
      evento: "Flamengo vs Vasco",
      esporte: "Futebol",
      competicao: "Brasileirão",
      pais: "Brasil",
      mercado: "Total de Gols",
      selecao: "Mais de 2.5",
      odds: new Prisma.Decimal(1.95),
      stake: new Prisma.Decimal(100),
      casaDeAposta: "Bet365",
      kickoffInferido: false,
    };

    const after = {
      data: now,
      evento: "Flamengo vs Vasco",
      esporte: "Futebol",
      competicao: "Brasileirão",
      pais: "Brasil",
      mercado: "Total de Gols",
      selecao: "Mais de 2.5",
      odds: 1.95,
      stake: 100,
      casaDeAposta: "Bet365",
    };

    expect(isIdentityCompatibleEdit(before, after)).toBe(true);
  });
});
