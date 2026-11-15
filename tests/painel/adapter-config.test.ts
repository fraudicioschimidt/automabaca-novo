import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  getConfigPageData: vi.fn(),
  listTeamCards: vi.fn(),
  listActiveDeviceSessions: vi.fn(),
  getCatalogPairingStatus: vi.fn(),
}));

vi.mock("@/src/services/painel/config", () => ({ getConfigPageData: services.getConfigPageData }));
vi.mock("@/src/services/painel/team-cards", () => ({ listTeamCards: services.listTeamCards }));
vi.mock("@/src/services/auth/device-sessions", () => ({ listActiveDeviceSessions: services.listActiveDeviceSessions }));
vi.mock("@/src/services/painel/catalog-pairing", () => ({ getCatalogPairingStatus: services.getCatalogPairingStatus }));

const { getConfigCatalogPairing, getConfigData } = await import("@/app/_design/adapters/config");
const now = new Date("2026-07-13T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  services.getCatalogPairingStatus.mockResolvedValue({ lastRound: null, linkedToday: 0, teamCards: 0, inProgress: null });
  services.getConfigPageData.mockResolvedValue({
    bankrolls: [
      { id: "b1", slug: "principal", nome: "Principal", sharpMode: "CLV_ONLY", valorUnidade: 10.4, telegramChannelId: "-1001", logoUrl: "/logo.png",
        channelSports: ["Basketball"], capturePausedAt: new Date("2026-07-12T18:30:00.000Z"),
        confirmedSports: [{ sport: "Basketball", bets: 40 }, { sport: "Soccer", bets: 3 }, { sport: "Tennis", bets: 2 }, { sport: "Volleyball", bets: 1 }] },
      { id: "b2", slug: "manual", nome: "Manual", sharpMode: "OFF", valorUnidade: 5, telegramChannelId: null, logoUrl: null,
        channelSports: [], capturePausedAt: null, confirmedSports: [] },
    ],
    mercados: [{ nome: "Asian Handicap", aliases: [{ alias: "AH" }, { alias: "AH" }, { alias: "Handicap Asiático" }] }],
  });
  services.listTeamCards.mockResolvedValue({ cards: [], total: 2310, nextOffset: 50, sports: [{ sport: "Soccer", count: 2310 }] });
  services.listActiveDeviceSessions.mockResolvedValue({
    total: 1,
    sessions: [
      { id: "s1", deviceName: "Chrome", createdAt: now, lastSeenAt: now, expiresAt: now, current: true },
    ],
  });
});

describe("getConfigData", () => {
  it("adapta bancas, deduplica mercados e expõe segurança do operador", async () => {
    const result = await getConfigData("fabricio", "s1");

    expect(result.bancas).toEqual([
      expect.objectContaining({ name: "Principal", sharpMode: "CLV_ONLY", unit: "R$10,4/u", channelRaw: "-1001",
        channelSports: ["Basketball"], capturePaused: true, pausedSince: "12/07 15:30",
        // A sugestão do modal mostra só os três esportes mais confirmados.
        confirmedSports: [{ sport: "Basketball", bets: 40 }, { sport: "Soccer", bets: 3 }, { sport: "Tennis", bets: 2 }] }),
      expect.objectContaining({ name: "Manual", sharpMode: "OFF", channel: "—", channelRaw: "",
        channelSports: [], capturePaused: false, pausedSince: null, confirmedSports: [] }),
    ]);
    expect(result.markets[0]!.aliases).toEqual(["AH", "Handicap Asiático"]);
    // A primeira página das fichas, sem busca.
    expect(result.teamCards).toMatchObject({ total: 2310, nextOffset: 50 });
    expect(services.listTeamCards).toHaveBeenCalledWith();
    expect(result.security).toMatchObject({ username: "fabricio", sessionsTotal: 1 });
    expect(result.security.sessions[0]).toMatchObject({ id: "s1", current: true });
    expect(services.listActiveDeviceSessions).toHaveBeenCalledWith("fabricio", "s1");
  });

  it("não consulta segurança quando não há usuário", async () => {
    const result = await getConfigData();
    expect(result.security).toEqual({ username: "operador", sessions: [], sessionsTotal: 0 });
  });
});

describe("getConfigCatalogPairing", () => {
  it("dá a hora de São Paulo da última rodada, com a data quando ela não é de hoje, e o motivo da parada", async () => {
    services.getCatalogPairingStatus.mockResolvedValueOnce({
      lastRound: { at: new Date("2026-07-13T11:37:00.000Z"), stoppedBy: null }, linkedToday: 184, teamCards: 2310, inProgress: true,
    });
    expect(await getConfigCatalogPairing(now)).toEqual({
      lastRound: "08:37", stoppedBy: null, linkedToday: 184, teamCards: 2310, inProgress: true,
    });

    services.getCatalogPairingStatus.mockResolvedValueOnce({
      lastRound: { at: new Date("2026-07-12T23:37:00.000Z"), stoppedBy: "budget" }, linkedToday: 0, teamCards: 5, inProgress: false,
    });
    expect(await getConfigCatalogPairing(now)).toMatchObject({ lastRound: "12/07 20:37", stoppedBy: "gasto do dia acima de 60% do teto" });
  });

  it("fila ilegível chega como \"não sei\", sem virar fila vazia", async () => {
    expect(await getConfigCatalogPairing(now)).toEqual({
      lastRound: null, stoppedBy: null, linkedToday: 0, teamCards: 0, inProgress: null,
    });
  });
});
