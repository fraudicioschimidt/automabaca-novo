import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/infra/prisma", () => ({
  prisma: { $transaction: async (read: (tx: object) => Promise<unknown>) => read({}) },
}));

const services = vi.hoisted(() => ({
  getBankrollEquityCurves: vi.fn(),
  getBankrollSummaries: vi.fn(),
  getResumoHoje: vi.fn(),
  getLastVisit: vi.fn(),
  getSinceLastVisit: vi.fn(),
  getAlertas: vi.fn(),
  getSaudeMotor: vi.fn(),
  getCanaisDecisao: vi.fn(),
}));

vi.mock("@/src/services/painel/queries/bankroll-curves", () => ({
  getBankrollEquityCurves: services.getBankrollEquityCurves,
}));
vi.mock("@/src/services/painel/queries/bankrolls", () => ({
  getBankrollSummaries: services.getBankrollSummaries,
}));
vi.mock("@/src/services/painel/queries/dashboard", () => ({
  getResumoHoje: services.getResumoHoje,
  getLastVisit: services.getLastVisit,
  getSinceLastVisit: services.getSinceLastVisit,
}));
vi.mock("@/src/services/painel/operacoes/alertas", () => ({
  getAlertas: services.getAlertas,
}));
// Só a leitura do banco é substituída: `workerVivo` é o de verdade, porque é
// ele que decide o `alive` que este teste confere.
vi.mock("@/src/services/painel/operacoes/saude", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/services/painel/operacoes/saude")>(),
  getSaudeMotor: services.getSaudeMotor,
}));
vi.mock("@/src/services/painel/canais", () => ({
  getCanaisDecisao: services.getCanaisDecisao,
}));

import { compareTipstersByKey } from "@/app/_design/lib/tipster-metrics";

const { getDashboardData } = await import("@/app/_design/adapters/dashboard");

function summary(id: string, nome: string) {
  return {
    id,
    slug: id,
    nome,
    sharpMode: "CLV_ONLY",
    temCanal: true,
    logoUrl: null,
    apostas: 2,
    resolvidas: 1,
    pendentes: 1,
    stakePendente: 0.5,
    stakeFinalizada: 10,
    lucro: 1,
    profitBrl: 10,
    stakedBrl: 100,
    halfWins: 0,
    halfLosses: 0,
    roi: 10,
    clv: 3,
    clvSamples: 1,
    acerto: 50,
    wins: 1,
    losses: 0,
    capitalInicial: 100,
    valorUnidade: 10,
    ultimaAtividade: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  services.getBankrollSummaries.mockResolvedValue([
    summary("missing", "Sem curva"),
    summary("empty", "Curva vazia"),
    summary("short", "Curva curta"),
    summary("full", "Curva completa"),
  ]);
  services.getResumoHoje.mockResolvedValue({ lucroDia: 2, resolvidasHoje: 3, tipsNovas: 4, aResolver: 5 });
  services.getBankrollEquityCurves.mockResolvedValue({
    days: ["2026-07-11", "2026-07-12", "2026-07-13"],
    curves: [
      { bankrollId: "empty", acumulado: [], accumulatedBrl: [] },
      { bankrollId: "short", acumulado: [1.23456], accumulatedBrl: [12.3456] },
      { bankrollId: "full", acumulado: [1, 2, 3], accumulatedBrl: [10, 20, 30] },
    ],
  });
  services.getSaudeMotor.mockResolvedValue({ ultimoHeartbeat: new Date(), dbOk: true });
  services.getAlertas.mockResolvedValue([{ id: "alert-1", kind: "warn", title: "Atenção", desc: "detalhe" }]);
  services.getCanaisDecisao.mockResolvedValue([]);
  services.getLastVisit.mockResolvedValue(null);
});

describe("getDashboardData", () => {
  it("alinha curvas ausentes, vazias, curtas e completas", async () => {
    const result = await getDashboardData("Fabricio", "fabricio");

    expect(result.tipsters.map((item) => item.equity)).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 1.23456],
      [1, 2, 3],
    ]);
    expect(result.tipsters.map((item) => item.equityBrl)).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 12.3456], [10, 20, 30]]);
    // Média = último acumulado de CADA curva ÷ dias operados. A curva vazia
    // entra como 0 e não some do divisor — banca parada é dia operado também.
    // R$ (0 + 12.3456 + 30) ÷ 3
    expect(result.today).toEqual({
      lucroDia: 2, resolvidas: 3, tips: 4, aResolver: 5,
      mediaDiaria: 14.1152, diasOperados: 3,
    });
    // A idade do motor é `frescor`, do mesmo cálculo que decide `alive`: não há
    // um campo de idade separado que possa contradizer a pill.
    expect(result.engine).toMatchObject({ alive: true, dbOk: true });
    expect(result.engine.frescor[0]).toMatchObject({ chave: "motor", atrasada: false, texto: "agora" });
    expect(result.greeting).toContain("Fabricio");
  });

  it("o horário do alerta é o da leitura, em São Paulo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T17:05:00Z"));
    try {
      const result = await getDashboardData("Fabricio", "fabricio");
      expect(result.alerts).toEqual([{ id: "alert-1", kind: "warn", title: "Atenção", desc: "detalhe", time: "lido às 14:05" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("motor com heartbeat velho ou ausente não aparece vivo", async () => {
    services.getSaudeMotor.mockResolvedValueOnce({ ultimoHeartbeat: new Date(Date.now() - 60 * 60_000), dbOk: true });
    expect((await getDashboardData("F", "fabricio")).engine).toMatchObject({ alive: false, dbOk: true });
    services.getSaudeMotor.mockResolvedValueOnce({ ultimoHeartbeat: null, dbOk: true });
    expect((await getDashboardData("F", "fabricio")).engine.alive).toBe(false);
  });

  it("canal sem decisão calculada é amostra curta, nunca edge", async () => {
    const result = await getDashboardData("Fabricio", "fabricio");
    for (const t of result.tipsters) expect(t).toMatchObject({ veredito: "AMOSTRA_CURTA", tStat: null });
  });

  it("o desempate do ranking usa o CLV da decisão, sem misturar a base do resumo", async () => {
    services.getBankrollSummaries.mockResolvedValue([
      { ...summary("a", "Alfa"), clv: 100, clvSamples: 30 },
      { ...summary("z", "Zeta"), clv: 2, clvSamples: 30 },
    ]);
    services.getCanaisDecisao.mockResolvedValue([
      { id: "z", decisao: { veredito: "EDGE", tStat: null, clvMedio: 2 } },
      { id: "a", decisao: { veredito: "EDGE", tStat: null, clvMedio: 1 } },
    ]);
    const { tipsters } = await getDashboardData("F", "fabricio");
    expect([...tipsters].sort((a, b) => compareTipstersByKey(a, b, "decisao")).map((t) => t.name)).toEqual(["Zeta", "Alfa"]);
  });

  it("não inventa média com um dia só de operação", async () => {
    // Média de um dia é o próprio dia: exibi-la ao lado do lucro de hoje seria
    // oferecer o mesmo número como se fosse referência.
    services.getBankrollEquityCurves.mockResolvedValueOnce({
      days: ["2026-07-11"],
      curves: [{ bankrollId: "full", acumulado: [9], accumulatedBrl: [90] }],
    });

    const result = await getDashboardData("Fabricio", "fabricio");

    expect(result.today.mediaDiaria).toBeNull();
    expect(result.today.diasOperados).toBe(1);
  });

  it("mantém ao menos dois pontos quando não há dias", async () => {
    services.getBankrollEquityCurves.mockResolvedValueOnce({ days: [], curves: [] });
    services.getBankrollSummaries.mockResolvedValueOnce([summary("one", "Única")]);
    expect((await getDashboardData("F", "fabricio")).tipsters[0]!.equity).toEqual([0, 0]);
  });
});

describe("desde a última visita", () => {
  it("primeira visita não mostra resumo, e a tela recebe o instante da leitura", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T17:05:00Z"));
    try {
      const result = await getDashboardData("Fabricio", "fabricio");
      expect(services.getLastVisit).toHaveBeenCalledWith("fabricio", expect.any(Object));
      expect(services.getSinceLastVisit).not.toHaveBeenCalled();
      expect(result.visit).toEqual({ readAt: "2026-09-23T17:05:00.000Z", since: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("com visita anterior, resume a janela até esta leitura", async () => {
    const antes = new Date("2026-09-22T23:10:00Z");
    services.getLastVisit.mockResolvedValueOnce(antes);
    services.getSinceLastVisit.mockImplementationOnce(async (since: Date, until: Date) => ({
      since, until, newBets: 3, settled: 2, lucroUnits: 1.5, lucroReais: 150, closings: 1, clvMean: 2.2, openAlerts: 0,
    }));
    const result = await getDashboardData("Fabricio", "fabricio");
    expect(services.getSinceLastVisit).toHaveBeenCalledWith(antes, new Date(result.visit.readAt), expect.any(Object));
    expect(result.visit.since).toEqual({
      sinceLabel: "22/09 20:10", newBets: 3, settled: 2, lucroUnits: 1.5, lucroReais: 150, closings: 1, clvMean: 2.2, openAlerts: 0,
    });
  });
});

it.each([
  ["2026-10-11T02:59:59.999Z", "2026-10-11T03:00:00Z", "Boa noite"],
  ["2026-10-11T14:59:59.999Z", "2026-10-11T15:00:00Z", "Bom dia"],
])("a data, a saudação e Hoje usam a mesma leitura em %s", async (start, end, greeting) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(start));
  services.getSaudeMotor.mockImplementationOnce(async () => {
    vi.setSystemTime(new Date(end));
    return { dbOk: true, ultimoHeartbeat: new Date() };
  });
  services.getResumoHoje.mockImplementationOnce(async (ref?: Date) => ({
    lucroDia: (ref ?? new Date()).toISOString() === start ? 10 : 20,
    resolvidasHoje: 1, tipsNovas: 1, aResolver: 0,
  }));
  try {
    const result = await getDashboardData("Dono", "dono");
    expect(result.visit.readAt).toBe(start);
    expect(result.today.lucroDia).toBe(10);
    expect(result.greeting).toBe(`${greeting}, Dono`);
  } finally { vi.useRealTimers(); }
});
