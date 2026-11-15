import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";
import { jobLagMs } from "@/src/services/ops/telemetry";

afterEach(() => vi.useRealTimers());
describe("atraso desde a elegibilidade do job", () => {
  it("desconta agendamento e backoff, mantendo o atraso real do worker", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T22:00:05Z"));
    const job = (startAfter?: string) => ({ createdOn: "2026-09-09T20:00:00Z", startAfter } as unknown as Job);
    expect(jobLagMs([job("2026-09-09T22:00:00Z")])).toBe(5000);
    expect(jobLagMs([job("2026-09-09T21:30:00Z")])).toBe(1_805_000);
    expect(jobLagMs([job("2026-09-10T00:00:00Z")])).toBe(0);
    expect(jobLagMs([job()])).toBe(7_205_000);
    expect(jobLagMs([job("invalid")])).toBe(7_205_000);
    expect(jobLagMs([{} as Job])).toBeUndefined();
  });
});
