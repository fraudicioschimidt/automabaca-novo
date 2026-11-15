import { describe, expect, it } from "vitest";
import { safeReturnPath } from "@/src/domain/safe-return-path";

describe("safeReturnPath", () => {
  it("aceita somente caminhos relativos seguros", () => {
    expect(safeReturnPath("/tipsters/treino?bk=treino")).toBe("/tipsters/treino?bk=treino");
    for (const unsafe of ["https://evil.test", "//evil.test", "/\\evil.test", "/%5cevil.test", "/%0d%0aevil"]) {
      expect(safeReturnPath(unsafe)).toBeNull();
    }
  });
});
