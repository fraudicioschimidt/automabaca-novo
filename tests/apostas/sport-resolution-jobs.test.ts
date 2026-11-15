import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), resolve: vi.fn(), sharp: vi.fn(), avisar: vi.fn(), avisarConflito: vi.fn() }));
vi.mock("@/src/services/scheduling/enqueue-sport-resolution", () => ({ enqueueSportResolution: mocks.enqueue }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ enqueueSharpEnrich: mocks.sharp }));
vi.mock("@/src/services/bets/sport-resolution/resolve", () => ({ resolvePendingBetSport: mocks.resolve }));
vi.mock("@/src/services/bets/sport-resolution/notify", () => ({ avisarEsportePendente: mocks.avisar, avisarConflitoDeEsporte: mocks.avisarConflito }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperatorNotification: vi.fn() }));
import { resolveBetSports } from "@/src/jobs/sport-resolution-jobs";

describe("fila de esporte retoma sem consumir tentativas de negócio", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["outside_provider_window", "provider_capacity"])("persiste a continuação de %s, mesmo após os retries rápidos", async (reason) => {
    const cursor = { sport: "Soccer", searchAt: 2 };
    mocks.resolve.mockResolvedValue({ status: "pending", reason, retryAt: new Date(Date.now() + 86_400_000), bridgeCursor: cursor });
    const boss = {} as never;
    await resolveBetSports([{ data: { betId: "bet-1", attempt: 15, continuation: 2, bridgeCursor: cursor } }] as never, boss);
    expect(mocks.resolve).toHaveBeenCalledWith("bet-1", { attempt: 15, continuation: 2, bridgeCursor: cursor });
    expect(mocks.enqueue).toHaveBeenCalledWith(boss, "bet-1", expect.objectContaining({ attempt: 15, continuation: 3, bridgeCursor: cursor, origem: reason }));
    expect(mocks.enqueue.mock.calls[0]![2].startAfterSeconds).toBeGreaterThan(86_390);
    expect(mocks.sharp).not.toHaveBeenCalled();
  });
  it("confirmação encaminha para sharp e encerra a espera", async () => {
    mocks.resolve.mockResolvedValue({ status: "resolved" });
    const boss = {} as never;
    await resolveBetSports([{ data: { betId: "bet-1", attempt: 0 } }] as never, boss);
    expect(mocks.sharp).toHaveBeenCalledWith(boss, "bet-1", { origem: "sport-resolved" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

it("interrompe a retomada de capacidade sem progresso e aplica backoff", async () => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ status: "pending", reason: "provider_capacity", retryAt: new Date(Date.now() + 40_000) });
  const boss = {} as never;
  await resolveBetSports([{ data: { betId: "bet-1", attempt: 6, continuation: 716 } }] as never, boss);
  expect(mocks.enqueue).toHaveBeenCalledWith(boss, "bet-1", { attempt: 7, startAfterSeconds: 7200, origem: "pending" });
});

describe("fim das tentativas automáticas avisa o dono", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.avisar.mockResolvedValue(true);
  });

  it("esgotado o backoff, notifica com o que a busca achou e não reenfileira", async () => {
    const run = { status: "pending", reason: "provider_capacity", candidates: [{ sport: "Soccer", confidence: 90, source: "WEB" }] };
    mocks.resolve.mockResolvedValue(run);
    const boss = {} as never;
    // attempt 15 = 3 rápidas + 12 estendidas: não há próxima tentativa.
    await resolveBetSports([{ data: { betId: "bet-1", attempt: 15, continuation: 716 } }] as never, boss);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.avisar).toHaveBeenCalledExactlyOnceWith(run);
  });

  it("enquanto ainda há tentativa, não avisa", async () => {
    mocks.resolve.mockResolvedValue({ status: "pending", reason: "no_strong_candidate", candidates: [] });
    const boss = {} as never;
    await resolveBetSports([{ data: { betId: "bet-1", attempt: 2 } }] as never, boss);
    expect(mocks.enqueue).toHaveBeenCalled();
    expect(mocks.avisar).not.toHaveBeenCalled();
  });

  it("falha do aviso não derruba o job — a aposta segue na caixa de ações", async () => {
    mocks.resolve.mockResolvedValue({ status: "pending", reason: "no_strong_candidate", candidates: [] });
    mocks.avisar.mockRejectedValueOnce(new Error("telegram fora do ar"));
    const boss = {} as never;
    await expect(resolveBetSports([{ data: { betId: "bet-1", attempt: 15 } }] as never, boss)).resolves.toBeUndefined();
  });
});

describe("tentativa avulsa (esportes do canal trocados)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não agenda a próxima nem avisa, mesmo no fim do backoff: a cadeia da aposta cuida disso", async () => {
    mocks.resolve.mockResolvedValue({ status: "pending", reason: "no_strong_candidate", candidates: [] });
    const boss = {} as never;
    await resolveBetSports([{ data: { betId: "bet-1", attempt: 15, oneShot: true } }] as never, boss);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.avisar).not.toHaveBeenCalled();
  });

  it("a espera de fornecedor continua avulsa", async () => {
    mocks.resolve.mockResolvedValue({ status: "pending", reason: "provider_capacity", retryAt: new Date(Date.now() + 60_000) });
    const boss = {} as never;
    await resolveBetSports([{ data: { betId: "bet-1", attempt: 0, oneShot: true } }] as never, boss);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(boss, "bet-1", expect.objectContaining({ continuation: 1, oneShot: true }));
  });
});

describe("vez da busca web contada do kickoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.avisar.mockResolvedValue(true);
  });

  it("adianta a próxima tentativa para a vez da web", async () => {
    mocks.resolve.mockResolvedValue({ status: "pending", reason: "no_strong_candidate", candidates: [], nextWebSearchAt: new Date(Date.now() + 600_000) });
    const boss = {} as never;
    await resolveBetSports([{ data: { betId: "bet-1", attempt: 5 } }] as never, boss);
    const delay = mocks.enqueue.mock.calls[0]![2].startAfterSeconds as number;
    expect(delay).toBeGreaterThan(590);
    expect(delay).toBeLessThanOrEqual(600);
  });

  it("esgotado o backoff, avisa uma vez e ainda acorda na vez da web", async () => {
    const run = { status: "pending", reason: "no_strong_candidate", candidates: [], nextWebSearchAt: new Date(Date.now() + 86_400_000) };
    mocks.resolve.mockResolvedValue(run);
    const boss = {} as never;
    await resolveBetSports([{ data: { betId: "bet-1", attempt: 15 } }] as never, boss);
    expect(mocks.enqueue).toHaveBeenCalledWith(boss, "bet-1", expect.objectContaining({ attempt: 16, origem: "pending" }));
    expect(mocks.avisar).toHaveBeenCalledExactlyOnceWith(run);

    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue({ ...run, nextWebSearchAt: undefined });
    await resolveBetSports([{ data: { betId: "bet-1", attempt: 16 } }] as never, boss);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.avisar).not.toHaveBeenCalled();
  });
});

it("conflito do resolvedor avisa o dono na hora e não reenfileira", async () => {
  vi.clearAllMocks();
  mocks.avisarConflito.mockResolvedValue(true);
  const run = { status: "conflict", reason: "post_dissent", candidates: [], dissent: { sport: "Soccer", confidence: 85, source: "LLM", fromPost: true } };
  mocks.resolve.mockResolvedValue(run);
  await resolveBetSports([{ data: { betId: "bet-1", attempt: 1 } }] as never, {} as never);
  expect(mocks.avisarConflito).toHaveBeenCalledExactlyOnceWith(run);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.avisar).not.toHaveBeenCalled();
});
