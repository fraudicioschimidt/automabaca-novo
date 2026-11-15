import { beforeEach, describe, expect, it, vi } from "vitest";

const getDetails = vi.fn();
vi.mock("@/src/providers/flashscore/client", () => ({
  getFlashscoreMatchDetails: (...args: unknown[]) => getDetails(...args),
}));

const { fetchMatchDetails } = await import("@/src/services/settlement/flashscore/settle");
type DetailsCache = Map<string, Promise<{ body: Record<string, unknown> | null; requestStartedAt: string; observedAt: string }>>;

describe("fetchMatchDetails cache", () => {
  beforeEach(() => {
    getDetails.mockReset();
  });

  it("reusa a mesma Promise em voo para o mesmo matchId", async () => {
    let release!: (body: Record<string, unknown>) => void;
    getDetails.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    const cache: DetailsCache = new Map();
    const a = fetchMatchDetails("m1", cache);
    const b = fetchMatchDetails("m1", cache);
    expect(a).toBe(b);
    expect(getDetails).toHaveBeenCalledTimes(1);
    release({ match_id: "m1" });
    const [obsA, obsB] = await Promise.all([a, b]);
    expect(obsA.body).toEqual({ match_id: "m1" });
    expect(obsB.body).toEqual({ match_id: "m1" });
  });

  it("expurga a entrada rejeitada para o próximo retry não herdar o poison", async () => {
    getDetails
      .mockRejectedValueOnce(new Error("quota"))
      .mockResolvedValueOnce({ match_id: "m1", ok: true });

    const cache: DetailsCache = new Map();
    await expect(fetchMatchDetails("m1", cache)).rejects.toThrow("quota");
    expect(cache.has("m1")).toBe(false);

    const recovered = await fetchMatchDetails("m1", cache);
    expect(recovered.body).toEqual({ match_id: "m1", ok: true });
    expect(getDetails).toHaveBeenCalledTimes(2);
  });

  it("sucesso permanece no cache do lote", async () => {
    getDetails.mockResolvedValue({ match_id: "m2" });
    const cache: DetailsCache = new Map();
    const first = await fetchMatchDetails("m2", cache);
    const second = await fetchMatchDetails("m2", cache);
    expect(first).toBe(second);
    expect(getDetails).toHaveBeenCalledTimes(1);
    expect(cache.has("m2")).toBe(true);
  });
});
