import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  auditCreate: vi.fn(),
  enqueue: vi.fn(),
  naFila: vi.fn(),
  alert: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/src/infra/prisma", () => ({
  prisma: {
    bet: { findMany: mocks.findMany, count: mocks.count },
    auditEvent: { create: mocks.auditCreate },
  },
}));
vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn() }),
}));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({}) }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ enqueueSharpEnrich: mocks.enqueue }));
vi.mock("@/src/services/scheduling/enqueue-sport-resolution", () => ({ enqueueSportResolution: vi.fn() }));
vi.mock("@/src/services/sharp/revive", () => ({ betIdsComEnrichNaFila: mocks.naFila }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: mocks.alert }));

const { reprocessarTransitoriosDoCanal } = await import("@/src/services/ops/reprocess");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.naFila.mockResolvedValue(new Set<string>());
  mocks.auditCreate.mockResolvedValue({});
  mocks.alert.mockResolvedValue(true);
  mocks.findMany.mockResolvedValue(
    Array.from({ length: 4 }, (_, i) => ({ id: `bet-${i + 1}` })),
  );
  mocks.count.mockResolvedValue(4);
});

describe("reprocesso transitório do canal", () => {
  it("alerta quando parte do lote não entra na fila — parcial não é sucesso", async () => {
    // O operador clica "Reprocessar" e lê `enfileiradas` como pronto; sem o
    // alerta, as que ficaram de fora só existiriam no log.
    mocks.enqueue.mockImplementation(async (_boss: unknown, betId: string) => {
      if (betId === "bet-2" || betId === "bet-4") throw new Error("fila indisponível");
      return "job";
    });

    const resultado = await reprocessarTransitoriosDoCanal("-1001", "fabricio");

    expect(resultado.enfileiradas).toBe(2);
    expect(mocks.alert).toHaveBeenCalledWith(
      expect.stringContaining("2 de 4"),
      expect.objectContaining({
        source: "ops.reprocess-enqueue",
        autoResolve: false,
        evidence: expect.objectContaining({ falhas: 2, total: 4 }),
      }),
    );
    // O lote NÃO aborta na primeira falha: isolamento por item (lei 7).
    expect(mocks.enqueue).toHaveBeenCalledTimes(4);
  });

  it("lote inteiro verde não abre ação na caixa do operador", async () => {
    mocks.enqueue.mockResolvedValue("job");

    const resultado = await reprocessarTransitoriosDoCanal("-1001", "fabricio");

    expect(resultado.enfileiradas).toBe(4);
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
