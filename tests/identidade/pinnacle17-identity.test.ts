import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  betUpdate: vi.fn(),
  betFind: vi.fn(),
  audit: vi.fn(),
  resolve: vi.fn(),
  release: vi.fn(async () => {}),
  resolveTeams: vi.fn(),
  learnTipster: vi.fn(async () => {}),
  judge: vi.fn(),
}));

vi.mock("@/src/infra/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (callback) => callback({ $queryRaw: vi.fn(async () => []),
      bet: { update: mocks.betUpdate, findUnique: mocks.betFind }, betSharp: { findUnique: vi.fn(async () => null) },
      auditEvent: { create: mocks.audit } })),
  },
}));
vi.mock("@/src/providers/pinnacle17/client", async (original) => ({
  ...await original<object>(),
  pinnacle17Enabled: () => true,
}));
vi.mock("@/src/providers/pinnacle17/types", async (original) => ({
  ...await original<object>(),
  encodePinnacle17PriceReference: (r: { eventId: number; period: number; marketType: string; line: string; outcome: string }) =>
    `pinnacle17:v1:${r.eventId}:${r.period}:${r.marketType}:${r.line}:${r.outcome}`,
}));
vi.mock("@/src/providers/pinnacle17/sharp", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/providers/pinnacle17/sharp")>(),
  releasePinnacle17ClosingIfCreated: mocks.release,
  resolvePinnacle17SharpForBet: mocks.resolve,
}));
vi.mock("@/src/services/teams/resolve", () => ({
  resolveTeamsForProvider: mocks.resolveTeams,
}));
vi.mock("@/src/services/teams/tipster-names", () => ({
  learnTipsterTeamNames: mocks.learnTipster,
}));
vi.mock("@/src/services/sharp/judge", () => ({
  judgeMatchCandidates: mocks.judge,
}));

import { resolvePinnacle17Identity, tryPinnacle17Identity } from "@/src/services/sharp/enrich/pinnacle17-identity";
import { singlePriceSnapshot } from "@/src/domain/price-provenance";
import type { UpsertSharpFn } from "@/src/services/sharp/enrich/upsert-sharp";

const KICKOFF = new Date("2026-08-28T22:00:00Z");
const bet = {
  id: "bet-pinnacle17",
  evento: "Unión Santa Fe vs Sarmiento",
  esporte: "Soccer",
  pais: "Argentina",
  competicao: "Liga Profesional",
  mercado: "Money Line – Match",
  selecao: "Unión Santa Fe",
  odds: 2,
  data: KICKOFF,
  registradoEm: new Date(),
  bankroll: { sharpMode: "CLV_ONLY" },
};

const event = {
  id: 1634172613,
  name: "Union de Santa Fe vs Sarmiento de Junin",
  startTime: KICKOFF.toISOString(),
  status: { isStarted: false, isInProgress: false, isInterrupted: false },
  sport: { id: 29, name: "Soccer" },
  league: { id: 210697, name: "Liga Pro", country: "Argentina" },
  homeTeam: { name: "Union de Santa Fe" },
  awayTeam: { name: "Sarmiento de Junin" },
  units: "Regular",
};

function result(withPrice: boolean) {
  return {
    matched: true,
    match: { event, score: 2, swapped: false },
    mainEvent: event,
    score: 2,
    swapped: false,
    current: withPrice ? {
      fair: 1.95,
      raw: 1.9,
      maxBet: 450,
      snapshot: {
        version: 1,
        combination: "single",
        components: [{ lineQ: null, rawOdds: [1.9, 2.1], selectedIndex: 0, devig: "power" }],
      },
    } : null,
    currentObservedAt: withPrice ? new Date() : null,
    priceReference: withPrice ? {
      provider: "pinnacle17",
      eventId: event.id,
      period: 0,
      marketType: "moneyline",
      line: "ml",
      outcome: "home",
    } : null,
    closingReservationCreated: withPrice,
    unresolvedReason: withPrice ? null : "no_prices",
  };
}

describe("persistência canônica Pinnacle17", () => {
  it("identidade fica gravada enquanto a consulta de preço ainda está em andamento", async () => {
    let release!: (value: ReturnType<typeof result>) => void;
    mocks.resolve.mockResolvedValueOnce(result(false)).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const upsert = vi.fn<UpsertSharpFn>(async () => {});
    const running = resolvePinnacle17Identity({ ...bet }, { home: "Unión Santa Fe", away: "Sarmiento" }, upsert);
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2));
    expect(mocks.resolve.mock.calls[0]?.[0]).toMatchObject({ needOdds: false });
    expect(upsert).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "identidade_auto", resourceId: bet.id,
      details: expect.objectContaining({ provider: "pinnacle17", providerMatchId: String(event.id),
        antes: expect.objectContaining({ evento: bet.evento, competicao: bet.competicao }),
        depois: expect.objectContaining({ evento: "Union de Santa Fe vs Sarmiento de Junin", competicao: "Liga Pro" }) }) }) });
    expect(upsert.mock.calls[0]?.[1]).toMatchObject({ identityStatus: "MATCHED", provider: "pinnacle17" });
    release(result(true));
    await expect(running).resolves.toMatchObject({ resolved: true });
    expect(upsert.mock.calls.at(-1)?.[1]).toMatchObject({ noOddsReason: "clv_only" });
    expect(mocks.audit).toHaveBeenCalledOnce();
  });
  it("CLV_ONLY preserva referência de closing sem snapshot parcial de entrada", async () => {
    mocks.resolve.mockResolvedValue(result(true));
    const upsert = vi.fn<UpsertSharpFn>(async () => {});
    await resolvePinnacle17Identity({ ...bet, bankroll: { sharpMode: "CLV_ONLY" } }, { home: "Unión Santa Fe", away: "Sarmiento" }, upsert);
    const data = upsert.mock.calls.at(-1)?.[1];
    expect(data).toMatchObject({ identityStatus: "MATCHED", noOddsReason: "clv_only", provider: "pinnacle17" });
    expect(data?.priceReference).toBeTruthy();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.betFind.mockResolvedValue({ ...bet, deletedAt: null, bankroll: {}, liveScoreHome: null, liveScoreAway: null, kickoffInferido: false });
    mocks.betUpdate.mockImplementation(async ({ data }) => ({ ...bet, ...data }));
    mocks.resolve.mockReset();
    mocks.resolveTeams.mockResolvedValue({
      home: "Unión Santa Fe",
      away: "Sarmiento",
      homeResolution: { providerTeamId: null },
      awayResolution: { providerTeamId: null },
    });
    mocks.judge.mockResolvedValue({ applied: null, verdict: null, reason: "unavailable" });
  });

  it("salva exatamente país, liga, times e seleção da Pinnacle", async () => {
    mocks.resolve.mockResolvedValue(result(true));
    const upsert = vi.fn(async () => {});

    await expect(resolvePinnacle17Identity({ ...bet }, { home: "Unión Santa Fe", away: "Sarmiento" }, upsert)).resolves.toEqual({ resolved: true, matched: true, identityApplied: true });

    expect(mocks.betUpdate).toHaveBeenCalledWith({
      where: { id: bet.id },
      data: expect.objectContaining({
        evento: "Union de Santa Fe vs Sarmiento de Junin",
        selecao: "Union de Santa Fe",
        pais: "Argentina",
        competicao: "Liga Pro",
        data: KICKOFF,
        kickoffInferido: false,
      }),
    });
    expect(upsert).toHaveBeenCalledWith(
      bet.id,
      expect.objectContaining({
        provider: "pinnacle17",
        providerMatchId: "1634172613",
        priceReference: "pinnacle17:v1:1634172613:0:moneyline:ml:home",
        noOddsReason: "clv_only",
      }),
      expect.anything(),
    );
    // O casamento automático ensina à ficha os nomes que o tipster escreveu, depois de a identidade gravar.
    expect(mocks.learnTipster).toHaveBeenCalledWith({
      betId: bet.id,
      pinnacleEventId: "1634172613",
      tipster: { home: "Unión Santa Fe", away: "Sarmiento" },
      pinnacle: { home: "Union de Santa Fe", away: "Sarmiento de Junin" },
      kickoff: KICKOFF,
    });
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(mocks.learnTipster.mock.invocationCallOrder[0]!);
  });

  it("a identidade de um evento já conhecido (re-enrich) não ensina nome", async () => {
    mocks.resolve.mockResolvedValue(result(true));
    await resolvePinnacle17Identity({ ...bet, sharp: { providerMatchId: String(event.id) } },
      { home: "Unión Santa Fe", away: "Sarmiento" }, vi.fn(async () => {}));
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ matchId: event.id }));
    expect(mocks.learnTipster).not.toHaveBeenCalled();
  });

  it("quando o juiz decide, a aposta ganha o jogo mas nenhum nome é aprendido", async () => {
    mocks.judge.mockResolvedValue({
      applied: { match: { match_id: event.id } },
      verdict: { confidence: 82 },
      reason: "applied",
    });
    mocks.resolve.mockImplementation(async (req: { judgeCandidates?: (c: unknown[]) => Promise<unknown> }) => {
      if (req.judgeCandidates) await req.judgeCandidates([{ event, score: 0.4, swapped: false }]);
      return result(true);
    });
    const upsert = vi.fn(async () => {});
    await expect(resolvePinnacle17Identity({ ...bet }, { home: "Unión Santa Fe", away: "Sarmiento" }, upsert)).resolves.toEqual({ resolved: true, matched: true, identityApplied: true });
    // A IA decide só esta aposta: o jogo é gravado, a grafia não é aprendida.
    expect(mocks.betUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ evento: "Union de Santa Fe vs Sarmiento de Junin" }),
    }));
    expect(mocks.learnTipster).not.toHaveBeenCalled();
  });

  it("preserva a identidade oficial mesmo quando não há preço", async () => {
    mocks.resolve.mockResolvedValue(result(false));
    const upsert = vi.fn(async () => {});

    await expect(resolvePinnacle17Identity({ ...bet }, { home: "Unión Santa Fe", away: "Sarmiento" }, upsert)).resolves.toEqual({ resolved: false, matched: true, identityApplied: true });

    expect(mocks.betUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ evento: "Union de Santa Fe vs Sarmiento de Junin" }),
    }));
    expect(upsert).toHaveBeenCalledWith(
      bet.id,
      expect.objectContaining({ provider: "pinnacle17", priceReference: null, noOddsReason: "no_prices" }),
      expect.anything(),
    );
  });
});

describe("Pinnacle17 com times de vôlei e mercado de total", () => {
  const teams = { home: "Minas", away: "Sesi Bauru" };
  const volley = {
    id: "bet-1", evento: "Minas vs Sesi Bauru", esporte: "Volleyball",
    pais: "Brazil", competicao: "Superliga", mercado: "Total",
    selecao: "Over 180.5", odds: 1.9, data: new Date("2026-09-09T18:00:00Z"),
    registradoEm: new Date(), bankroll: { sharpMode: "CLV_ONLY" },
  };
  const volleyEvent = {
    id: 701, homeTeam: { name: teams.home }, awayTeam: { name: teams.away },
    league: { country: "Brazil", name: "Superliga" }, startTime: volley.data.toISOString(),
  };
  const reference = { provider: "pinnacle17", eventId: 701, period: 0, marketType: "total", line: "722", outcome: "over" };
  function volleyResult(priced = false) {
    return {
      matched: true, mainEvent: volleyEvent, swapped: false, score: 2,
      current: priced ? { fair: 2, raw: 1.9, maxBet: 500,
        snapshot: singlePriceSnapshot({ rawOdds: [1.9, 1.9], selectedIndex: 0, devig: "power", lineQ: 722 }) } : null,
      currentObservedAt: priced ? new Date() : null,
      priceReference: priced ? reference : null, closingReservationCreated: priced,
      unresolvedReason: priced ? null : "no_prices",
    };
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
    volley.registradoEm = new Date();
    vi.resetAllMocks();
    mocks.betFind.mockResolvedValue({ ...volley, deletedAt: null, bankroll: {}, liveScoreHome: null, liveScoreAway: null, kickoffInferido: false });
    mocks.betUpdate.mockImplementation(async ({ data }) => ({ ...volley, ...data }));
    mocks.resolveTeams.mockResolvedValue({ ...teams,
      homeResolution: { providerTeamId: null }, awayResolution: { providerTeamId: null } });
  });
  afterEach(() => vi.useRealTimers());

  it("preserva identidade mesmo sem linha de preço", async () => {
    mocks.resolve.mockResolvedValue(volleyResult());
    const upsert = vi.fn();
    await expect(resolvePinnacle17Identity({ ...volley }, teams, upsert)).resolves.toEqual({
      resolved: false, matched: true, identityApplied: true,
    });
    expect(upsert.mock.calls.at(-1)?.[1]).toMatchObject({
      provider: "pinnacle17", providerMatchId: "701", priceReference: null, noOddsReason: "no_prices",
    });
  });
  it("grava a referência tipada do fechamento, sem preço de entrada", async () => {
    mocks.resolve.mockResolvedValue(volleyResult(true));
    const upsert = vi.fn();
    await expect(resolvePinnacle17Identity({ ...volley, registradoEm: new Date() }, teams, upsert))
      .resolves.toEqual({ resolved: true, matched: true, identityApplied: true });
    expect(upsert.mock.calls.at(-1)?.[1]).toMatchObject({
      provider: "pinnacle17", providerMatchId: "701",
      priceReference: "pinnacle17:v1:701:0:total:722:over", noOddsReason: "clv_only",
    });
  });
  it.each(["CLV_ONLY", "IDENTITY_ONLY"])("remates em modo %s resolvem só identidade", async (mode) => {
    mocks.resolve.mockResolvedValue(volleyResult());
    const upsert = vi.fn();
    await resolvePinnacle17Identity({ ...volley, esporte: "Soccer", mercado: "Total (Shots) – Match",
      selecao: "Over 21.5", bankroll: { sharpMode: mode } }, teams, upsert);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ needOdds: false }));
    expect(upsert.mock.calls.at(-1)?.[1]).toMatchObject({ noOddsReason: "sem_referencia_sharp", priceReference: null });
  });

  describe("tryPinnacle17Identity: só BridgeOdds e Pinnacle17", () => {
    const volleyTotal = { ...volley, mercado: "Total Points" };
    it("resolve pela Pinnacle17", async () => {
      mocks.resolve.mockResolvedValue(volleyResult(true));
      await expect(tryPinnacle17Identity({ ...volleyTotal }, teams, vi.fn()))
        .resolves.toEqual({ resolved: true, provider: "pinnacle17" });
      expect(mocks.resolveTeams).toHaveBeenCalledOnce();
    });
    it.each(["quota", "HTTP 429"])("falha %s não consulta outro feed", async (message) => {
      mocks.resolveTeams.mockRejectedValue(new Error(message));
      await expect(tryPinnacle17Identity({ ...volleyTotal }, teams, vi.fn())).resolves.toEqual({ resolved: false });
      expect(mocks.resolveTeams).toHaveBeenCalledOnce();
      expect(mocks.resolve).not.toHaveBeenCalled();
    });
    it("conserva identidade confirmada sem linha de preço", async () => {
      mocks.resolve.mockResolvedValue(volleyResult());
      await expect(tryPinnacle17Identity({ ...volleyTotal }, teams, vi.fn()))
        .resolves.toEqual({ resolved: true, provider: "pinnacle17" });
    });
    it("na matriz Bridge também tenta a Pinnacle17", async () => {
      mocks.resolve.mockResolvedValue(volleyResult(true));
      await tryPinnacle17Identity({ ...volleyTotal, esporte: "Soccer", mercado: "Money Line – Match", selecao: "Minas" }, teams, vi.fn());
      expect(mocks.resolveTeams).toHaveBeenCalledOnce();
    });
    it("esporte sem cobertura não gera consultas", async () => {
      await expect(tryPinnacle17Identity({ ...volleyTotal, esporte: "Unknown" }, teams, vi.fn())).resolves.toEqual({ resolved: false });
      expect(mocks.resolveTeams).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    });
  });
});

/**
 * As fichas só ajudam a casar: nome ambíguo nelas não veta a identidade pela
 * Pinnacle17. O caso é a aposta c1762df1 (24/09, feminino de Israel): o tipster
 * escreveu "(F)" e a Pinnacle põe o feminino na liga.
 */
describe("as fichas não vetam a identidade pela Pinnacle17", () => {
  const kickoff = new Date("2026-09-24T13:30:00Z");
  const feminino = {
    id: "c1762df1-65a9-4a2b-89d5-81ce49f89ae6",
    evento: "Hapoel Jerusalem F vs Kiryat Gat F",
    esporte: "Soccer",
    pais: "Israel",
    competicao: "Ligat Al, Women",
    mercado: "Money Line – Match",
    selecao: "Hapoel Jerusalem F",
    odds: 1.8,
    data: kickoff,
    registradoEm: new Date("2026-09-24T02:40:00Z"),
    bankroll: { sharpMode: "CLV_ONLY" },
  };
  const teams = { home: "Hapoel Jerusalem F", away: "Kiryat Gat F" };
  const hapoel = {
    id: 1637159068,
    homeTeam: { name: "Hapoel Jerusalem" },
    awayTeam: { name: "Kiryat Gat" },
    league: { country: "Israel", name: "Premier League Women" },
    startTime: kickoff.toISOString(),
  };
  const reference = {
    provider: "pinnacle17", eventId: hapoel.id, period: 0, marketType: "moneyline", line: "ml", outcome: "home",
  };
  const matched = {
    matched: true, mainEvent: hapoel, swapped: false, score: 2,
    current: { fair: 1.85, raw: 1.8, maxBet: 300,
      snapshot: singlePriceSnapshot({ rawOdds: [1.8, 2.05], selectedIndex: 0, devig: "power", lineQ: null }) },
    currentObservedAt: new Date(), priceReference: reference, closingReservationCreated: true, unresolvedReason: null,
  };
  const original = (inputName: string, strategy: "original" | "ambiguous") => ({
    inputName, resolvedName: inputName, cardId: null, providerTeamId: null, strategy, alternativeNames: [],
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T02:46:00Z"));
    vi.resetAllMocks();
    mocks.betFind.mockResolvedValue({ ...feminino, deletedAt: null, bankroll: {}, liveScoreHome: null, liveScoreAway: null, kickoffInferido: false });
    mocks.betUpdate.mockImplementation(async ({ data }) => ({ ...feminino, ...data }));
    mocks.resolve.mockResolvedValue(matched);
    mocks.resolveTeams.mockResolvedValue({
      ...teams,
      homeResolution: original(teams.home, "original"), awayResolution: original(teams.away, "original"),
    });
  });
  afterEach(() => vi.useRealTimers());

  it("nome com mais de uma ficha: busca com o nome original e casa", async () => {
    mocks.resolveTeams.mockResolvedValue({
      ...teams,
      homeResolution: original(teams.home, "ambiguous"), awayResolution: original(teams.away, "original"),
    });
    const upsert = vi.fn();
    await expect(resolvePinnacle17Identity({ ...feminino }, teams, upsert))
      .resolves.toEqual({ resolved: true, matched: true, identityApplied: true });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      home: "Hapoel Jerusalem F", away: "Kiryat Gat F", competicao: "Ligat Al, Women",
    }));
    expect(upsert.mock.calls.at(-1)?.[1]).toMatchObject({ provider: "pinnacle17", providerMatchId: "1637159068" });
  });

  it("sem ficha nenhuma é a linha de base: casa e aprende", async () => {
    const upsert = vi.fn();
    await expect(resolvePinnacle17Identity({ ...feminino }, teams, upsert))
      .resolves.toEqual({ resolved: true, matched: true, identityApplied: true });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ home: "Hapoel Jerusalem F" }));
    expect(mocks.learnTipster).toHaveBeenCalledOnce();
  });
});


it("a Pinnacle17 mantém a ordem do placar ao vivo nos dois commits de identidade", async () => {
  mocks.betUpdate.mockClear();
  mocks.betFind.mockResolvedValue({ ...bet, deletedAt: null, bankroll: {}, liveScoreHome: 1, liveScoreAway: 0, kickoffInferido: false });
  mocks.resolveTeams.mockResolvedValue({ home: "Sarmiento", away: "Unión Santa Fe" });
  mocks.resolve.mockResolvedValue({ ...result(false), swapped: true });
  const upsert = vi.fn<UpsertSharpFn>(async () => {});
  await resolvePinnacle17Identity({ ...bet, evento: "Sarmiento vs Unión Santa Fe", selecao: "Sarmiento -0.5", mercado: "Asian Handicap", bankroll: { sharpMode: "IDENTITY_ONLY" } },
    { home: "Sarmiento", away: "Unión Santa Fe" }, upsert);
  expect(mocks.betUpdate).toHaveBeenCalledTimes(2);
  for (const [args] of mocks.betUpdate.mock.calls) {
    expect(args.data).toMatchObject({ evento: "Sarmiento de Junin vs Union de Santa Fe", selecao: "Sarmiento de Junin -0.5" });
  }
});
