import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { cancelPendingSportResolution } from "@/src/services/scheduling/enqueue-sport-resolution";

vi.mock("@/src/infra/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

const { prisma } = await import("@/src/infra/prisma");

describe("cancelPendingSportResolution", () => {
  it("cancela todos os attempts pendentes da aposta", async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "sport-job-1" },
      { id: "sport-job-2" },
    ]);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const boss = { cancel } as unknown as PgBoss;

    const cancelled = await cancelPendingSportResolution(boss, "bet-abc");

    expect(cancelled).toBe(2);
    expect(cancel).toHaveBeenCalledWith(
      "capture.sport_resolve",
      ["sport-job-1", "sport-job-2"],
    );
  });

  it("não chama o pg-boss quando não há job pendente", async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { cancel } as unknown as PgBoss;

    await expect(
      cancelPendingSportResolution(boss, "bet-empty"),
    ).resolves.toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });
});
