import { describe, expect, it, vi } from "vitest";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import { Prisma } from "@/src/generated/prisma/client";
import { settleFromFlashscoreScoreTx } from "@/src/services/settlement/flashscore/score-settle";

describe("settleFromFlashscoreScoreTx: mudança material dos termos", () => {
  it("lança erro se mercado, seleção ou odds forem modificados no banco antes da tx", async () => {
    const mockBet: EligibleBet = {
      id: "bet-mutated",
      evento: "Chelsea vs Arsenal",
      mercado: "Total de Gols",
      selecao: "Mais de 2.5",
      odds: new Prisma.Decimal(1.90),
      stake: new Prisma.Decimal(10),
      status: "PENDING",
      data: new Date(),
      registradoEm: new Date(),
      esporte: "Futebol",
      competicao: "Premier League",
      pais: "Inglaterra",
    } as unknown as EligibleBet;

    // Mock tx onde o banco já possui a seleção alterada para "Menos de 2.5"
    const mockTx = {
      bet: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          mercado: "Total de Gols",
          selecao: "Menos de 2.5", // Mutação material!
          odds: new Prisma.Decimal(1.90),
        }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      settleFromFlashscoreScoreTx(mockTx, mockBet, {
        status: "WON",
        homeScore: 3,
        awayScore: 0,
      }),
    ).rejects.toThrow(/mutação material de termos/i);
  });

  it("lança erro se as odds sofrerem mutação material no banco", async () => {
    const mockBet: EligibleBet = {
      id: "bet-odds-mutated",
      evento: "Chelsea vs Arsenal",
      mercado: "Total de Gols",
      selecao: "Mais de 2.5",
      odds: new Prisma.Decimal(1.90),
      stake: new Prisma.Decimal(10),
      status: "PENDING",
      data: new Date(),
      registradoEm: new Date(),
      esporte: "Futebol",
      competicao: "Premier League",
      pais: "Inglaterra",
    } as unknown as EligibleBet;

    const mockTx = {
      bet: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          mercado: "Total de Gols",
          selecao: "Mais de 2.5",
          odds: new Prisma.Decimal(2.10), // Odd alterada!
        }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(
      settleFromFlashscoreScoreTx(mockTx, mockBet, {
        status: "WON",
        homeScore: 3,
        awayScore: 0,
      }),
    ).rejects.toThrow(/mutação material de termos/i);
  });
});
