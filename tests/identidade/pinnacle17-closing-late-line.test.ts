import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as Pinnacle17Client from "@/src/providers/pinnacle17/client";
import type * as Pinnacle17Sharp from "@/src/providers/pinnacle17/sharp";
import type { Pinnacle17Event, Pinnacle17Market } from "@/src/providers/pinnacle17/types";
const mocks = vi.hoisted(() => ({ odds: vi.fn(), reserve: vi.fn(), release: vi.fn(), attempt: vi.fn() }));
vi.mock("@/src/providers/pinnacle17/client", async (original) => ({
  ...await original<typeof Pinnacle17Client>(),
  fetchPinnacle17Odds: mocks.odds,
}));
vi.mock("@/src/providers/pinnacle17/sharp", async (original) => ({
  ...await original<typeof Pinnacle17Sharp>(),
  reservePinnacle17Closing: mocks.reserve,
  releasePinnacle17ClosingReservation: mocks.release,
  pinnacle17ClosingReservedAttempt: () => mocks.attempt,
}));
import { capturePinnacle17Closing } from "@/src/services/sharp/closing/pinnacle17-clv";

const bet = { evento: "Alpha vs Beta", esporte: "Soccer", mercado: "Total (Corners) – Match", selecao: "Over 9.0",
  data: new Date("2026-09-09T23:30:00Z"), sharp: { providerMatchId: "1635205194", priceReference: null as string | null } };
const market = { name: "Total (Corners) – Match", type: "total", period: 0, periodName: "Match", team: null,
  units: "Corners", special: null, isLive: false, line: 9, status: "open", cutoffAt: null, limits: [],
  outcomes: [{ designation: "over", name: "Over", line: 9, oddsAmerican: null, oddsDecimal: 1.9 },
    { designation: "under", name: "Under", line: 9, oddsAmerican: null, oddsDecimal: 1.95 }],
};
describe("closing com linha que abriu após a captura", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T22:00:00Z"));
    mocks.reserve.mockResolvedValue({ ok: true, created: true });
    mocks.odds.mockResolvedValue({ data: [market], observedAt: new Date() });
  });
  afterEach(() => { vi.useRealTimers(); });
  it("busca o preço exato pela identidade confirmada mesmo sem referência de entrada", async () => {
    const result = await capturePinnacle17Closing(bet);
    expect(result).toMatchObject({ raw: 1.9, reference: "pinnacle17:v2:1635205194:0:total:36:over:corners" });
    expect(mocks.odds).toHaveBeenCalledWith(1635205194, expect.any(Function), expect.objectContaining({
      id: 1635205194, startTime: bet.data.toISOString(), homeTeam: { name: "Alpha" }, awayTeam: { name: "Beta" },
    }), undefined);
    // A tentativa paga a reserva de fechamento.
    await mocks.odds.mock.calls[0]?.[1]();
    expect(mocks.attempt).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith(mocks.reserve.mock.calls[0]?.[0]);
  });
  it("fecha Dupla Chance pela mesma referência AH +0.5 da entrada", async () => {
    const reference = "pinnacle17:v1:1635205194:0:spread:2:away";
    mocks.odds.mockResolvedValue({ observedAt: new Date(), data: [{ ...market,
      name: "Handicap – Match", units: "Regular", type: "spread", line: -0.5,
      outcomes: [
        { designation: "home", name: "Alpha -0.5", line: -0.5, oddsAmerican: 120, oddsDecimal: 2.2 },
        { designation: "away", name: "Beta +0.5", line: 0.5, oddsAmerican: -157, oddsDecimal: 1.636 },
      ],
    }] });
    expect(await capturePinnacle17Closing({ ...bet, mercado: "Double Chance", selecao: "Draw or Beta",
      sharp: { ...bet.sharp, priceReference: reference } })).toMatchObject({ raw: 1.636, reference });
  });
  it.each([{ units: "Regular", name: "Total – Match" }, { line: 9.5 }, { isLive: true }, { period: 1 }])("não aceita livro de outros termos: %j", async (patch) => {
    mocks.odds.mockResolvedValue({ data: [{ ...market, ...patch }], observedAt: new Date() });
    expect(await capturePinnacle17Closing(bet)).toBeNull();
    expect(mocks.release).toHaveBeenCalled();
  });
  it("não contorna referência corrompida nem identidade ausente", async () => {
    expect(await capturePinnacle17Closing({ ...bet, sharp: { ...bet.sharp, priceReference: "invalid" } })).toBeNull();
    expect(await capturePinnacle17Closing({ ...bet, sharp: null })).toBeNull();
    expect(mocks.odds).not.toHaveBeenCalled();
  });
  it("recusa referência de outro evento antes de reservar cota ou consultar", async () => {
    const reference = "pinnacle17:v2:999:0:total:36:over:corners";
    expect(await capturePinnacle17Closing({ ...bet, sharp: { ...bet.sharp, priceReference: reference } })).toBeNull();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.odds).not.toHaveBeenCalled();
  });
  it("mantém a exigência de igualdade quando já existe referência de preço", async () => {
    expect(await capturePinnacle17Closing({ ...bet, sharp: { ...bet.sharp, priceReference: "pinnacle17:v1:1635205194:0:total:38:over" } })).toBeNull();
  });
  it("v2 exige a mesma unidade da entrada e v1 continua compatível", async () => {
    const correct = "pinnacle17:v2:1635205194:0:total:36:over:corners";
    expect(await capturePinnacle17Closing({ ...bet, sharp: { ...bet.sharp, priceReference: correct } }))
      .toMatchObject({ reference: correct });
    expect(await capturePinnacle17Closing({ ...bet, sharp: { ...bet.sharp, priceReference: correct.replace(/corners$/, "goals") } })).toBeNull();
    const legacy = "pinnacle17:v1:1635205194:0:total:36:over";
    expect(await capturePinnacle17Closing({ ...bet, sharp: { ...bet.sharp, priceReference: legacy } }))
      .toMatchObject({ reference: legacy });
  });
  it.each([
    [33, "Sets", 0, "sets"], [33, "Games", 1, "games"], [34, "Points", 1, "points"],
    [12, "Kills", 1, "kills"], [15, "Regular", 3, "points"], [19, "Regular", 6, "goals"],
    [3, "Regular", 1, "runs"],
  ] as const)("closing mantém livro %s/%s/período %s", async (sportId, units, period, unit) => {
    const fixtures = JSON.parse(readFileSync(join(__dirname, "../fixtures/pinnacle17/multisport-20260908.json"), "utf8")) as Array<{
      event: Pinnacle17Event; observedAt: string; markets: Pinnacle17Market[];
    }>;
    const fixture = fixtures.find(f => f.event.sport.id === sportId)!;
    const line = fixture.markets.find(m => m.units === units && m.period === period && m.type === "total")!;
    const reference = `pinnacle17:v2:${fixture.event.id}:${period}:total:${line.line! * 4}:over:${unit}`;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixture.observedAt));
    try {
      mocks.odds.mockResolvedValue({ data: fixture.markets, observedAt: new Date(fixture.observedAt) });
      expect(await capturePinnacle17Closing({ evento: fixture.event.name, esporte: fixture.event.sport.name,
        mercado: line.name, selecao: `Over ${line.line}`, data: new Date(fixture.event.startTime),
        sharp: { providerMatchId: String(fixture.event.id), priceReference: reference } }))
        .toMatchObject({ reference, raw: line.outcomes.find(o => o.designation === "over")!.oddsDecimal });
    } finally { vi.useRealTimers(); }
  });
  it("recusa cotação observada depois do kickoff", async () => {
    mocks.odds.mockResolvedValue({ data: [market], observedAt: new Date("2026-09-09T23:31:00Z") });
    expect(await capturePinnacle17Closing(bet)).toBeNull();
    expect(mocks.release).toHaveBeenCalled();
  });
  it("respeita falta de orçamento", async () => {
    mocks.reserve.mockResolvedValue({ ok: false, created: false });
    expect(await capturePinnacle17Closing(bet)).toBeNull();
    expect(mocks.odds).not.toHaveBeenCalled();
  });
});
