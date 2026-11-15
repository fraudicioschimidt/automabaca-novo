import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), markVisit: vi.fn() }));
vi.mock("@/app/(painel)/_auth", () => ({ actor: mocks.actor }));
vi.mock("@/src/services/painel/queries/dashboard", () => ({ markVisit: mocks.markVisit }));

const { markDashboardVisitAction } = await import("@/app/(painel)/dashboard-actions");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue("fabricio");
});

describe("marcar a visita ao dashboard", () => {
  it("avança a visita do operador da sessão até o instante da leitura", async () => {
    await expect(markDashboardVisitAction("2026-09-23T15:00:00.000Z")).resolves.toEqual({ ok: true });
    expect(mocks.markVisit).toHaveBeenCalledWith("fabricio", new Date("2026-09-23T15:00:00.000Z"));
  });

  it("instante malformado ou no futuro é erro de cliente", async () => {
    await expect(markDashboardVisitAction("ontem")).rejects.toThrow("Instante da leitura inválido.");
    await expect(markDashboardVisitAction(new Date(Date.now() + 3_600_000).toISOString())).rejects.toThrow("Instante da leitura inválido.");
    expect(mocks.markVisit).not.toHaveBeenCalled();
  });

  it("sem sessão não grava", async () => {
    mocks.actor.mockRejectedValue(new Error("Sessão inválida — faça login novamente."));
    await expect(markDashboardVisitAction("2026-09-23T15:00:00.000Z")).rejects.toThrow("Sessão inválida");
    expect(mocks.markVisit).not.toHaveBeenCalled();
  });
});
