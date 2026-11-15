import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveKickoffViaBridgeSchedule: vi.fn(),
  resolveKickoffViaFlashscoreSchedule: vi.fn(),
  resolveKickoffViaPinnacle17Schedule: vi.fn(),
  resolveKickoffViaWebSearch: vi.fn(),
  recordKickoffResolveAttempt: vi.fn(),
  reopenSharpIdentityAfterKickoffChange: vi.fn(),
  recordOperationalMetric: vi.fn(),
  prisma: {
    $transaction: vi.fn(),
    bet: { updateMany: vi.fn() },
    iaJudgeCooldown: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/src/infra/logger", () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/src/infra/operational-metrics", () => ({
  recordOperationalMetric: mocks.recordOperationalMetric,
}));
vi.mock("@/src/infra/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/src/services/sharp/kickoff-revive", () => ({
  reopenSharpIdentityAfterKickoffChange: mocks.reopenSharpIdentityAfterKickoffChange,
}));
vi.mock("@/src/services/sharp/enrich/kickoff-attempts", async (original) => ({
  ...await original<typeof import("@/src/services/sharp/enrich/kickoff-attempts")>(),
  recordKickoffResolveAttempt: mocks.recordKickoffResolveAttempt,
}));
vi.mock("@/src/services/sharp/enrich/kickoff-schedule", () => ({
  resolveKickoffViaBridgeSchedule: mocks.resolveKickoffViaBridgeSchedule,
}));
vi.mock("@/src/services/sharp/enrich/resolve-kickoff-flashscore", () => ({
  resolveKickoffViaFlashscoreSchedule: mocks.resolveKickoffViaFlashscoreSchedule,
}));
vi.mock("@/src/services/sharp/enrich/resolve-kickoff-pinnacle17", () => ({
  resolveKickoffViaPinnacle17Schedule: mocks.resolveKickoffViaPinnacle17Schedule,
}));
vi.mock("@/src/services/sharp/enrich/resolve-kickoff-web", () => ({
  resolveKickoffViaWebSearch: mocks.resolveKickoffViaWebSearch,
}));

import { resolveProvisionalKickoff } from "@/src/services/sharp/enrich/kickoff-provisional";

const bet = {
  id: "bet-1",
  evento: "De Minaur A. vs Nakashima B.",
  esporte: "Tennis",
  pais: "",
  competicao: "",
  data: new Date("2026-07-31T03:00:00Z"),
  kickoffInferido: true,
};

const kickoff = new Date("2026-07-31T18:00:00Z");

describe("kickoff waterfall FS→Bridge→Pinnacle17→web", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.iaJudgeCooldown.findUnique.mockResolvedValue(null);
    mocks.prisma.iaJudgeCooldown.upsert.mockResolvedValue({});
    mocks.prisma.iaJudgeCooldown.deleteMany.mockResolvedValue({ count: 0 });
    mocks.prisma.$transaction.mockImplementation(async (operation) => operation(mocks.prisma));
    mocks.prisma.bet.updateMany.mockResolvedValue({ count: 1 });
    mocks.resolveKickoffViaBridgeSchedule.mockResolvedValue(null);
    mocks.resolveKickoffViaFlashscoreSchedule.mockResolvedValue(null);
    mocks.resolveKickoffViaPinnacle17Schedule.mockResolvedValue(null);
    mocks.resolveKickoffViaWebSearch.mockResolvedValue(null);
  });

  it("FlashScore hit evita Pinnacle17/web", async () => {
    mocks.resolveKickoffViaFlashscoreSchedule.mockResolvedValue({
      kickoff,
      sport: "Tennis",
      confidence: 0.95,
      country: null,
      competition: "ATP",
    });

    await resolveProvisionalKickoff({ ...bet }, { now: new Date("2026-07-31T12:00:00Z") });

    expect(mocks.resolveKickoffViaFlashscoreSchedule).toHaveBeenCalled();
    expect(mocks.resolveKickoffViaBridgeSchedule).not.toHaveBeenCalled();
    expect(mocks.resolveKickoffViaPinnacle17Schedule).not.toHaveBeenCalled();
    expect(mocks.resolveKickoffViaWebSearch).not.toHaveBeenCalled();
    expect(mocks.prisma.bet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: bet.id, deletedAt: null, data: bet.data, evento: bet.evento,
        esporte: bet.esporte },
      data: expect.objectContaining({ data: kickoff, kickoffInferido: false }),
    }));
    expect(mocks.recordKickoffResolveAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ source: "flashscore", aplicado: true }),
    );
  });

  it("FlashScore miss consulta BridgeOdds antes de Pinnacle17", async () => {
    mocks.resolveKickoffViaBridgeSchedule.mockResolvedValue(kickoff);

    await resolveProvisionalKickoff({ ...bet }, { now: new Date("2026-07-31T12:00:00Z") });

    expect(mocks.resolveKickoffViaFlashscoreSchedule).toHaveBeenCalled();
    expect(mocks.resolveKickoffViaBridgeSchedule).toHaveBeenCalled();
    expect(mocks.resolveKickoffViaPinnacle17Schedule).not.toHaveBeenCalled();
    expect(mocks.resolveKickoffViaWebSearch).not.toHaveBeenCalled();
  });

  it("Pinnacle17 hit evita web", async () => {
    mocks.resolveKickoffViaPinnacle17Schedule.mockResolvedValue({
      kickoff,
      sport: "Tennis",
      country: null,
      competition: "ATP",
      source: "pinnacle17",
    });

    await resolveProvisionalKickoff({ ...bet }, { now: new Date("2026-07-31T12:00:00Z") });

    expect(mocks.resolveKickoffViaPinnacle17Schedule).toHaveBeenCalled();
    expect(mocks.resolveKickoffViaWebSearch).not.toHaveBeenCalled();
    expect(mocks.prisma.bet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ competicao: "ATP" }),
    }));
  });

  it("calendário Flashscore resolve horário sem substituir país e competição da Pinnacle", async () => {
    mocks.resolveKickoffViaFlashscoreSchedule.mockResolvedValue({ kickoff, sport: "Tennis", country: "World", competition: "ATP - SINGLES: Example" });
    const local = { ...bet, pais: "USA", competicao: "ATP Washington" };
    await resolveProvisionalKickoff(local, { now: new Date("2026-07-31T12:00:00Z") });
    expect(local).toMatchObject({ pais: "USA", competicao: "ATP Washington", data: kickoff });
    expect(mocks.prisma.bet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pais: "USA", competicao: "ATP Washington" }),
    }));
  });

  it("web só após miss de todos os catálogos", async () => {
    mocks.resolveKickoffViaWebSearch.mockResolvedValue({
      kickoff,
      sport: "Tennis",
      country: null,
      competition: null,
    });

    await resolveProvisionalKickoff({ ...bet }, { now: new Date("2026-07-31T12:00:00Z") });

    expect(mocks.resolveKickoffViaFlashscoreSchedule).toHaveBeenCalled();
    expect(mocks.resolveKickoffViaPinnacle17Schedule).toHaveBeenCalled();
    expect(mocks.resolveKickoffViaWebSearch).toHaveBeenCalled();
  });

  it("não aplica efeitos de um calendário quando a aposta mudou durante a busca", async () => {
    const { EnrichObsoleteError } = await import("@/src/services/sharp/enrich/write-guard");
    mocks.resolveKickoffViaFlashscoreSchedule.mockResolvedValue({ kickoff, sport: "Tennis", country: null, competition: null });
    mocks.prisma.bet.updateMany.mockResolvedValueOnce({ count: 0 });
    const local = { ...bet };

    await expect(resolveProvisionalKickoff(local, { now: new Date("2026-07-31T12:00:00Z") }))
      .rejects.toBeInstanceOf(EnrichObsoleteError);

    expect(local).toEqual(bet);
    expect(mocks.recordKickoffResolveAttempt).not.toHaveBeenCalled();
    expect(mocks.reopenSharpIdentityAfterKickoffChange).not.toHaveBeenCalled();
    expect(mocks.prisma.iaJudgeCooldown.deleteMany).not.toHaveBeenCalled();
    expect(mocks.resolveKickoffViaPinnacle17Schedule).not.toHaveBeenCalled();
    expect(mocks.resolveKickoffViaWebSearch).not.toHaveBeenCalled();
  });
});
