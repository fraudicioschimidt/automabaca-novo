import { describe, expect, it } from "vitest";
import { adaptiveBatchSize } from "@/src/services/sharp/batch-size";

describe("adaptiveBatchSize", () => {
  it("mantém piso quando elegíveis ≤ min", () => {
    expect(adaptiveBatchSize(0)).toBe(50);
    expect(adaptiveBatchSize(50)).toBe(50);
  });

  it("cresce com backlog e respeita teto", () => {
    expect(adaptiveBatchSize(100)).toBe(75); // 50 + floor(50/2)
    expect(adaptiveBatchSize(250)).toBe(150); // cap
    expect(adaptiveBatchSize(1000, 50, 150)).toBe(150);
  });
});
