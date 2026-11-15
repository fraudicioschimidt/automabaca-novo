import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/infra/prisma", () => ({
  prisma: { $transaction: async (read: (tx: object) => Promise<unknown>) => read({}) },
}));

const services = vi.hoisted(() => ({
  getBankrollVersion: vi.fn(),
  getBankrollDetail: vi.fn(),
  getBankrollsTips: vi.fn(),
  getBankrollChart: vi.fn(),
  apostasReliquidadas: vi.fn(),
}));

vi.mock("@/src/services/painel/queries/bankrolls", () => ({
  getBankrollVersion: services.getBankrollVersion,
  getBankrollDetail: services.getBankrollDetail,
  getBankrollsTips: services.getBankrollsTips,
}));
vi.mock("@/src/services/painel/queries/bankroll-curves", () => ({ getBankrollChart: services.getBankrollChart }));
vi.mock("@/src/services/painel/aposta/reliquidacao", () => ({ apostasReliquidadas: services.apostasReliquidadas }));
vi.mock("@/src/services/painel/queries/bet-rows", () => ({ getBetDetail: vi.fn(), getBetCaptureOrigin: vi.fn() }));

const { getBankrollData } = await import("@/app/_design/adapters/bankroll");

const SEM_REMOVIDAS = { total: 0, bets: [] };

function resumo(over: Record<string, unknown> = {}) {
  return {
    id: "bk-1", nome: "Treino", slug: "treino", sharpMode: "CLV_ONLY", temCanal: true, logoUrl: null,
    valorUnidade: 10, capitalInicial: 100, apostas: 10, pendentes: 2, stakePendente: 2, stakeFinalizada: 8,
    lucro: 3, roi: 37.5, acerto: 60, resolvidas: 8, wins: 5, losses: 3, halfWins: 0, halfLosses: 0,
    clv: 2.5, clvSamples: 4, clvBase: 5, ultimaAtividade: null, ...over,
  };
}

describe("dados da banca", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.getBankrollVersion.mockResolvedValue("v1");
    services.getBankrollsTips.mockResolvedValue([]);
    services.apostasReliquidadas.mockResolvedValue(new Set());
    services.getBankrollDetail.mockResolvedValue({ resumo: resumo(), clvMedio: 2.5, historyTotal: 10, bets: [], removed: SEM_REMOVIDAS });
  });

  it("um dia de lucro chega ao gráfico como o ponto real, sem virar dois zeros", async () => {
    services.getBankrollChart.mockResolvedValue([{ day: "2026-06-10", realized: 3 }]);
    const data = await getBankrollData("treino");
    expect(data!.CHART).toEqual([{ label: "10/06", realized: 3 }]);
  });

  it("sem curva, o gráfico recebe a série vazia e mostra o estado vazio", async () => {
    services.getBankrollChart.mockResolvedValue([]);
    const data = await getBankrollData("treino");
    expect(data!.CHART).toEqual([]);
  });

  it.each([100 / 3, 0, null])("preserva o acerto esportivo completo, inclusive ausência: %s", async (acerto) => {
    services.getBankrollChart.mockResolvedValue([]);
    services.getBankrollDetail.mockResolvedValue({ resumo: resumo({ acerto }), clvMedio: null, historyTotal: 401, bets: [], removed: SEM_REMOVIDAS });
    expect((await getBankrollData("treino"))!.METRICS.acerto).toBe(acerto);
  });

  it("a cobertura de CLV divide pela base alcançável, não por todas as apostas", async () => {
    services.getBankrollChart.mockResolvedValue([]);
    const data = await getBankrollData("treino");
    // 4 com CLV em 5 alcançáveis; sobre as 10 apostas daria 40%.
    expect(data!.METRICS.clvShare).toBe(80);
  });

  it("as removidas chegam com quando, por onde, se voltam e o que o estorno desfez", async () => {
    services.getBankrollChart.mockResolvedValue([]);
    const removida = (over: Record<string, unknown>) => ({
      id: "rm-1", evento: "Flamengo vs Palmeiras", mercado: "Moneyline", selecao: "Flamengo", odds: 2, stake: 1,
      data: new Date("2026-06-15T19:00:00Z"), ...over,
    });
    services.getBankrollDetail.mockResolvedValue({
      resumo: resumo(), clvMedio: 2.5, historyTotal: 10, bets: [],
      removed: { total: 5, bets: [
        removida({ removal: { at: new Date("2026-06-16T00:30:00Z"), origin: "reacao", restorable: true, previous: { status: "WON", lucro: 1 } } }),
        removida({ id: "rm-2", removal: { at: new Date("2026-06-16T00:30:00Z"), origin: "painel", restorable: true, previous: { status: "PENDING", lucro: 0 } } }),
      ] },
    });
    const data = await getBankrollData("treino");
    const base = { home: "Flamengo", away: "Palmeiras", market: "Moneyline", line: "Flamengo", odds: 2, stake: 1, day: "2026-06-15" };
    expect(data!.removed).toEqual({ total: 5, bets: [
      { id: "rm-1", ...base, removal: { at: "15/06 21:30", origin: "reacao", restorable: true, previous: { status: "won", profit: 1 } } },
      // Pendente ao sair: não havia resultado a estornar.
      { id: "rm-2", ...base, removal: { at: "15/06 21:30", origin: "painel", restorable: true, previous: { status: "pending", profit: null } } },
    ] });
  });

  it("sem base alcançável, a cobertura é ausência", async () => {
    services.getBankrollChart.mockResolvedValue([]);
    services.getBankrollDetail.mockResolvedValue({
      resumo: resumo({ clv: null, clvSamples: 0, clvBase: 0 }), clvMedio: null, historyTotal: 10, bets: [], removed: SEM_REMOVIDAS,
    });
    const data = await getBankrollData("treino");
    expect(data!.METRICS.clvShare).toBeNull();
  });
});
