import { describe, expect, it } from "vitest";
import { classifyParseFailure } from "@/src/services/capture/parse-telemetry";

describe("taxonomia de falha de parse", () => {
  it("não classifica sucesso nem duplicata como falha", () => {
    expect(classifyParseFailure("registered")).toBeNull();
    expect(classifyParseFailure("duplicate")).toBeNull();
  });

  it("só considera indisponibilidade da cascata como reprocessável", () => {
    expect(classifyParseFailure("unparseable", "llm_exhausted")).toEqual({
      failureClass: "transient_provider",
      retryable: true,
    });
    expect(classifyParseFailure("unparseable", "not_bet")).toEqual({
      failureClass: "not_a_bet",
      retryable: false,
    });
    expect(classifyParseFailure("guard_rejected", "odds_invalidas")).toEqual({
      failureClass: "guard_rejected",
      retryable: false,
    });
    expect(classifyParseFailure("unparseable")).toEqual({
      failureClass: "content_incomplete",
      retryable: false,
    });
    expect(classifyParseFailure("unparseable", "rascunho_sem_stake")).toEqual({
      failureClass: "content_incomplete",
      retryable: false,
    });
  });
});
