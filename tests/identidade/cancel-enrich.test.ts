import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { cancelPendingSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { enrichSingletonKey } from "@/src/infra/queue-contract";

vi.mock("@/src/infra/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

const { prisma } = await import("@/src/infra/prisma");

describe("cancelPendingSharpEnrich", () => {
  it("cancela ids encontrados pelo singletonKey", async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "job-1" },
      { id: "job-2" },
    ]);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const boss = { cancel } as unknown as PgBoss;

    const n = await cancelPendingSharpEnrich(boss, "bet-abc");

    expect(n).toBe(2);
    expect(cancel).toHaveBeenCalledWith("sharp.enrich", ["job-1", "job-2"]);
    expect(enrichSingletonKey("bet-abc")).toBe("bet:bet-abc");
  });

  it("retorna 0 se não há jobs", async () => {
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const cancel = vi.fn();
    const boss = { cancel } as unknown as PgBoss;

    expect(await cancelPendingSharpEnrich(boss, "bet-x")).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });
});
