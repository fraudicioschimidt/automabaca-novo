import { beforeEach, describe, expect, it, vi } from "vitest";

const findBankrolls = vi.fn();
const findBets = vi.fn();
const findContas = vi.fn();
const findActions = vi.fn();

vi.mock("@/src/infra/prisma", () => ({
  prisma: {
    bankroll: { findMany: findBankrolls },
    bet: { findMany: findBets },
    conta: { findMany: findContas },
    operationalAction: { findMany: findActions },
  },
}));

const { searchPanel } = await import("@/src/services/painel/search");

beforeEach(() => {
  vi.clearAllMocks();
  findBankrolls.mockResolvedValue([]);
  findBets.mockResolvedValue([]);
  findContas.mockResolvedValue([]);
  findActions.mockResolvedValue([]);
});

describe("searchPanel", () => {
  it("normaliza resultados das quatro áreas do painel", async () => {
    findBankrolls.mockResolvedValue([{ id: "b1", nome: "Treino", slug: "treino" }]);
    findBets.mockResolvedValue([
      { id: "t1", evento: "Flamengo vs Bahia", mercado: "Total", selecao: "Over", status: "PENDING" },
    ]);
    findContas.mockResolvedValue([
      { id: "c1", casaDeAposta: "Pinnacle", titular: "Fabrício", apelido: "Principal" },
    ]);
    findActions.mockResolvedValue([
      { id: "a1", title: "Revisar fila", area: "sharp", risk: "HIGH" },
    ]);

    await expect(searchPanel("treino")).resolves.toEqual([
      expect.objectContaining({ id: "bankroll:b1", href: "/tipsters/treino" }),
      expect.objectContaining({ id: "bet:t1", detail: "Total · Over · pendente", href: "/aposta?id=t1" }),
      expect.objectContaining({ id: "conta:c1", title: "Principal" }),
      expect.objectContaining({ id: "action:a1", detail: "sharp · risco alto", href: "/monitoramento" }),
    ]);
  });

  it("mostra o status da aposta em português", async () => {
    findBets.mockResolvedValue([
      { id: "t2", evento: "Flamengo vs Bahia", mercado: "Total", selecao: "Over 2.5", status: "HALF_WON" },
    ]);
    const [aposta] = await searchPanel("flamengo");
    expect(aposta?.detail).toBe("Total · Over 2.5 · ½ ganha");
  });
});
