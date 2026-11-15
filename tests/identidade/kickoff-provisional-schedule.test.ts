import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FlashscoreCatalogMatch } from "@/src/providers/flashscore/types";
import type { Pinnacle17Event } from "@/src/providers/pinnacle17/types";

const mocks = vi.hoisted(() => ({ catalog: vi.fn(), events: vi.fn() }));
vi.mock("@/src/infra/prisma", () => ({ prisma: {} }));
vi.mock("@/src/infra/circuit-breaker", () => ({
  CircuitOpenError: class CircuitOpenError extends Error {},
  isBreakerOpen: async () => false,
  withBreaker: async (_: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock("@/src/infra/env", () => ({ getEnv: () => ({ SHARP_AUTO_MATCH_MIN_SCORE: 1.5 }) }));
vi.mock("@/src/providers/flashscore/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/client")>()),
  flashscoreConfigured: () => true,
}));
vi.mock("@/src/providers/flashscore/sports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/providers/flashscore/sports")>()),
  flashscoreSportId: () => 1,
  FLASHSCORE_SPORTS: [{ sport: "Soccer", sportId: 1 }],
}));
vi.mock("@/src/providers/flashscore/catalog", () => ({ getFlashscoreCatalog: mocks.catalog }));
vi.mock("@/src/providers/pinnacle17/client", () => ({
  pinnacle17Configured: () => true, fetchPinnacle17Events: mocks.events,
}));
vi.mock("@/src/services/teams/resolve", () => ({
  resolveTeamsForProvider: async (teams: { home: string; away: string }) => ({
    ...teams,
    homeResolution: { providerTeamId: null, alternativeNames: [] }, awayResolution: { providerTeamId: null, alternativeNames: [] },
  }),
}));

import { resolveKickoffViaFlashscoreSchedule, findFlashscoreMatchIdForBet } from "@/src/services/sharp/enrich/resolve-kickoff-flashscore";
import { resolveKickoffViaPinnacle17Schedule } from "@/src/services/sharp/enrich/resolve-kickoff-pinnacle17";
import { provisionalScheduleAnchor } from "@/src/services/sharp/enrich/kickoff-schedule";

const bet = { evento: "Clube Aurora vs Clube Horizonte", esporte: "Soccer", pais: "Brazil", competicao: "",
  data: new Date("2026-09-13T03:05:00Z") };
const tomorrow = "2026-09-15T00:30:00Z";
function flash(id: string, kickoff: string): FlashscoreCatalogMatch {
  return { match_id: id, timestamp: new Date(kickoff).getTime() / 1000,
    home_team: { name: "Clube Aurora", team_id: "h" }, away_team: { name: "Clube Horizonte", team_id: "a" },
    tournament: { id: "league", name: "Serie B", countryName: "Brazil" },
  } as FlashscoreCatalogMatch;
}
function pinnacle(id: number, kickoff: string): Pinnacle17Event {
  return { id, startTime: kickoff, units: "Regular", sport: { id: 29 },
    league: { id: 1, name: "Serie B", country: "Brazil" },
    homeTeam: { name: "Clube Aurora" }, awayTeam: { name: "Clube Horizonte" },
    status: { isStarted: false, isInProgress: false, isInterrupted: false },
  } as Pinnacle17Event;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-13T03:10:00Z"));
  mocks.catalog.mockReset().mockResolvedValue([]); mocks.events.mockReset().mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

it("centraliza o dia de São Paulo sem trocar pela data UTC", () => {
  expect(provisionalScheduleAnchor(new Date("2026-09-13T02:50:00Z")).toISOString()).toBe("2026-09-12T15:00:00.000Z");
});
it("Flashscore encontra amanhã à noite em post sem horário recebido de madrugada", async () => {
  mocks.catalog.mockImplementation(async (day: string) => day === "2026-09-14" ? [flash("next", tomorrow)] : []);
  expect(await resolveKickoffViaFlashscoreSchedule(bet)).toMatchObject({ matchId: "next", kickoff: new Date(tomorrow) });
});
it("Flashscore compara os dias e recusa dois confrontos possíveis sem horário real", async () => {
  mocks.catalog.mockImplementation(async (day: string) => day === "2026-09-13"
    ? [flash("today", "2026-09-13T18:00:00Z")] : day === "2026-09-14" ? [flash("next", tomorrow)] : []);
  expect(await resolveKickoffViaFlashscoreSchedule(bet)).toBeNull();
});
it("vinculação por horário conhecido conserva sua janela restrita", async () => {
  mocks.catalog.mockImplementation(async (day: string) => day === "2026-09-14" ? [flash("next", tomorrow)] : []);
  expect(await findFlashscoreMatchIdForBet(bet)).toBeNull();
});
it("Pinnacle encontra amanhã à noite sem usar a hora de postagem como kickoff", async () => {
  mocks.events.mockResolvedValue({ data: [pinnacle(1, tomorrow)], observedAt: new Date() });
  expect(await resolveKickoffViaPinnacle17Schedule(bet)).toMatchObject({ kickoff: new Date(tomorrow), source: "pinnacle17" });
});
it("Pinnacle recusa dois confrontos possíveis sem desempatar pela hora artificial", async () => {
  mocks.events.mockResolvedValue({ data: [pinnacle(1, "2026-09-13T18:00:00Z"), pinnacle(2, tomorrow)], observedAt: new Date() });
  expect(await resolveKickoffViaPinnacle17Schedule(bet)).toBeNull();
});
it("Pinnacle conserva a janela de 36h da âncora e recusa jogos distantes", async () => {
  mocks.events.mockResolvedValue({ data: [pinnacle(1, "2026-09-16T00:30:00Z")], observedAt: new Date() });
  expect(await resolveKickoffViaPinnacle17Schedule(bet)).toBeNull();
});
it("Flashscore não confunde o time principal com o sub-20", async () => {
  const match = flash("youth", "2026-09-13T18:00:00Z"); match.home_team.name += " U20";
  mocks.catalog.mockResolvedValue([match]);
  expect(await resolveKickoffViaFlashscoreSchedule(bet)).toBeNull();
});
