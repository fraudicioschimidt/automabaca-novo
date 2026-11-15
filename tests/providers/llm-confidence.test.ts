import { describe, expect, it } from "vitest";
import { llmConfidenceSchema } from "@/src/domain/llm-confidence";

describe("confiança compartilhada pelos juízes de identidade e liquidação", () => {
  it.each([
    [0.85, 0.85], [85, 0.85], ["85%", 0.85], ["85", 0.85], ["0,85", 0.85],
    ["1%", 0.01], ["0.8%", 0.008], [" 0,8 % ", 0.008], [1, 1], ["100%", 1], [0, 0],
  ])("interpreta %s como %s", (raw, expected) => {
    expect(llmConfidenceSchema.parse(raw)).toBe(expected);
  });

  it.each(["", " ", "%", null, undefined, true, -1, 101, "101%", NaN, Infinity])("recusa confiança inválida: %s", (raw) => {
    expect(llmConfidenceSchema.safeParse(raw).success).toBe(false);
  });
});
