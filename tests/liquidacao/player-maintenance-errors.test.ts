import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError, ProviderRequestError, ProviderCadenceDeferredError } from "@/src/domain/provider-error";
import { BetSettlementTermsChangedError } from "@/src/services/bets/settle-terms";
import { settlePersistentPlayerProp } from "@/src/services/settlement/flashscore/player-props";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";

const mocks = vi.hoisted(() => ({ list: vi.fn(), fixture: vi.fn() }));
vi.mock("@/src/infra/prisma", () => ({ prisma: { betPlayerProp: { findMany: mocks.list } } }));
vi.mock("@/src/providers/flashscore/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/client")>()),
  flashscoreConfigured: () => true,
}));
vi.mock("@/src/services/players/fixture", () => ({ linkPlayerPropFlashscoreFixture: mocks.fixture }));
vi.mock("@/src/services/players/resolve", () => ({ resolvePlayerIdentity: vi.fn() }));
vi.mock("@/src/services/settlement/flashscore/player-props", () => ({ settlePersistentPlayerProp: vi.fn() }));
import { runPlayerPropsMaintenance } from "@/src/services/players/maintenance";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([{ betId: "bet", providerMatchId: null }]);
});

describe("indisponibilidade na manutenção de jogadores", () => {
  it.each([
    new BudgetExhaustedError("flashscore"), new CircuitOpenError("flashscore"),
    new ProviderRequestError("flashscore", { status: 429, error: "quota" }),
    new ProviderCadenceDeferredError("flashscore", new Date()),
  ])("encerra a rodada para %s e deixa a próxima retomar", async (error) => {
    mocks.fixture.mockRejectedValue(error);
    await expect(runPlayerPropsMaintenance()).resolves.toBeUndefined();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.fixture).toHaveBeenCalledTimes(1);
  });

  it("propaga falha interna para a telemetria e o mecanismo de retry do job", async () => {
    const error = new Error("falha ao ler o banco");
    mocks.fixture.mockRejectedValue(error);
    await expect(runPlayerPropsMaintenance()).rejects.toBe(error);
  });
});


it("rechecagem obsoleta não impede conferir as demais apostas", async () => {
  const now = new Date("2026-09-10T20:00:00Z");
  const prop = (betId: string) => ({ betId, revision: 1, providerMatchId: "fixture", bet: { id: betId }, evidence: {
    endedAt: "2026-09-09T18:00:00Z", teams: { home: "h", away: "a", swapped: false },
  } });
  mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([prop("old"), prop("next")]);
  vi.mocked(settlePersistentPlayerProp).mockRejectedValueOnce(new BetSettlementTermsChangedError("old"))
    .mockResolvedValueOnce({ settled: false, unsupported: false, aguardando: false, settlementOutcome: "already_settled", evidencia: { version: 1, resolvido: false, motivo: "already_settled", jogadoresNaPartida: 0, details: {} } });
  await expect(runPlayerPropsMaintenance(now)).resolves.toBeUndefined();
  expect(settlePersistentPlayerProp).toHaveBeenCalledTimes(2);
  expect(settlePersistentPlayerProp).toHaveBeenLastCalledWith(expect.objectContaining({ bet: expect.objectContaining({ id: "next" }), recheck: true }));
});
