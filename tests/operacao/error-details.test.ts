import { describe, expect, it } from "vitest";
import { errorMessageWithCode } from "@/src/infra/error-details";

describe("errorMessageWithCode", () => {
  it("preserva código nativo sem duplicá-lo", () => {
    expect(errorMessageWithCode(Object.assign(new Error("conexão recusada"), {
      code: "ECONNREFUSED",
    }))).toBe("conexão recusada (ECONNREFUSED)");
    expect(errorMessageWithCode(Object.assign(new Error("ECONNRESET no socket"), {
      code: "ECONNRESET",
    }))).toBe("ECONNRESET no socket");
    expect(errorMessageWithCode("falha")).toBe("falha");
  });
});
