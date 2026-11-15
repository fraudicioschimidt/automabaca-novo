import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { playerPropRule } from "@/src/domain/settlement/player-prop-rules";
import { linkPlayerPropFlashscoreFixture } from "@/src/services/players/fixture";
import { enrichBetSharp } from "@/src/services/sharp/enrich/enrich-bet";
import { resolvePendingBetSport } from "@/src/services/bets/sport-resolution/resolve";

const mocks = vi.hoisted(() => ({ catalog: vi.fn(), pinnacleIdentity: vi.fn(), sportCandidates: vi.fn() }));
vi.mock("@/src/services/bets/sport-resolution/collect-candidates", () => ({ collectSportCandidates: mocks.sportCandidates }));
vi.mock("@/src/providers/flashscore/client", async (original) => ({
  ...await original<typeof import("@/src/providers/flashscore/client")>(),
  flashscoreConfigured: () => true,
}));
vi.mock("@/src/providers/flashscore/catalog", () => ({ getFlashscoreCatalog: mocks.catalog }));
vi.mock("@/src/services/sharp/enrich/sharp-identity", () => ({ resolveSharpIdentity: mocks.pinnacleIdentity }));
vi.mock("@/src/services/sharp/enrich/kickoff-provisional", async (original) => ({
  ...await original<typeof import("@/src/services/sharp/enrich/kickoff-provisional")>(), resolveProvisionalKickoff: vi.fn(),
}));
vi.mock("@/src/services/sharp/enrich/resolve-kickoff-flashscore", async (original) => ({
  ...await original<typeof import("@/src/services/sharp/enrich/resolve-kickoff-flashscore")>(), linkEarlyFlashscoreMatch: vi.fn(),
}));

let db: TestDb;
const kickoff = new Date("2026-09-09T00:00:00Z");
const match = {
  match_id: "flashscore-fixture", timestamp: kickoff.getTime() / 1000,
  home_team: { team_id: "fs-criciuma", name: "Criciuma" },
  away_team: { team_id: "fs-juventude", name: "Juventude" },
  tournament: { id: "fs-league", name: "BRAZIL: Serie B", countryName: "Brazil" },
  match_status: { is_started: false, is_finished: false, is_cancelled: false, is_postponed: false, is_in_progress: false, stage: null },
  scores: { home: null, away: null },
};
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); vi.clearAllMocks(); mocks.catalog.mockResolvedValue([match]); mocks.pinnacleIdentity.mockResolvedValue({ status: "pinnacle17_resolved" }); });

async function fixture(identityStatus?: "MATCHED" | "MANUAL") {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Igux", slug: "igux", sharpMode: "IDENTITY_ONLY" } });
  const bet = await db.prisma.bet.create({ data: {
    bankrollId: bankroll.id, evento: "Criciuma vs Juventude", pais: "Brazil", competicao: "Serie B",
    esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: kickoff,
    mercado: "Player Shots", selecao: "Mandaca Over 1.5", casaDeAposta: "Betano", data: kickoff,
    registradoEm: new Date(kickoff.getTime() - 3_600_000), odds: 2.07, stake: 1.75,
    ...(identityStatus ? { sharp: { create: { identityStatus, provider: "pinnacle17", providerMatchId: "1635345303", confidence: 100, noOddsReason: "identity_only" } } } : {}),
  } });
  await db.prisma.betPlayerProp.create({ data: { betId: bet.id, terms: buildPlayerPropTerms(bet)!, rule: playerPropRule("Betano", "shots_total") } });
  // Criar o contrato invalida a confirmação manual anterior. O vínculo de
  // evidência abaixo não altera terms/rule e deve conservar esta nova revisão.
  const withContract = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  expect(withContract.manualSettlementVersion).toBe(bet.manualSettlementVersion + 1);
  return withContract;
}

describe("Pinnacle identifica a aposta; Flashscore vincula a evidência do jogador", () => {
  it("a confirmação do esporte pelo Flashscore preserva país e competição canônicos", async () => {
    // Esporte ainda pendente: nem a resolução forçada reavalia esporte confirmado.
    const confirmed = await fixture("MATCHED");
    const bet = await db.prisma.bet.update({ where: { id: confirmed.id }, data: {
      esporte: "Unknown", sportResolutionStatus: "PENDING", sportResolvedAt: null, sportConfidence: 0, sportSource: "UNRESOLVED",
    } });
    mocks.sportCandidates.mockResolvedValue([{ sport: "Soccer", confidence: 100, source: "PROVIDER", provider: "flashscore", matchId: "flashscore-fixture", home: "Criciuma", away: "Juventude", country: "World", competition: "BRAZIL: Serie B", kickoffIso: kickoff.toISOString() }]);
    const result = await resolvePendingBetSport(bet.id, { force: true, now: kickoff });
    expect(result.status).toBe("resolved");
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toMatchObject({ pais: "Brazil", competicao: "Serie B", evento: bet.evento });
  });
  it.each(["MATCHED", "MANUAL"] as const)("vínculo auxiliar preserva integralmente aposta e identidade %s", async (status) => {
    const bet = await fixture(status);
    const sharp = await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } });
    expect(await linkPlayerPropFlashscoreFixture(bet.id)).toBe(true);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).toEqual(bet);
    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } })).toEqual(sharp);
    expect(await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({ providerMatchId: "flashscore-fixture" });
    expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: bet.id } })).toMatchObject({ resultProvider: "flashscore", resultMatchId: "flashscore-fixture" });
    expect(await db.prisma.betClosing.count({ where: { betId: bet.id } })).toBe(0);
  });

  it("sem identidade Pinnacle, o Flashscore não cria BetSharp nem nome de time", async () => {
    const bet = await fixture();
    expect(await linkPlayerPropFlashscoreFixture(bet.id)).toBe(true);
    expect(await db.prisma.betSharp.count()).toBe(0);
    expect(await db.prisma.teamTipsterName.count()).toBe(0);
  });

  it("o enrich usa a cascata Pinnacle mesmo quando existe uma prop e catálogo Flashscore disponível", async () => {
    const bet = await fixture();
    await enrichBetSharp({ betId: bet.id }, { now: new Date(kickoff.getTime() - 30 * 60_000) });
    expect(mocks.pinnacleIdentity).toHaveBeenCalledOnce();
    expect(mocks.pinnacleIdentity.mock.calls[0]?.[0]).toMatchObject({ id: bet.id, mercado: "Player Shots", bankroll: { sharpMode: "IDENTITY_ONLY" } });
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
});
