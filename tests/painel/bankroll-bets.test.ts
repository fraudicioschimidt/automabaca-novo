import { describe, expect, it } from "vitest";
import { mergeUniqueBets } from "@/app/_design/lib/bankroll-bets";

describe("mergeUniqueBets", () => {
  it("mantém o registro do servidor quando o otimista já foi persistido", () => {
    const optimistic = [{ id: "same", status: "pending", source: "optimistic" }];
    const server = [{ id: "same", status: "won", source: "server" }];
    expect(mergeUniqueBets(optimistic, server)).toEqual(server);
  });

  it("preserva novos otimistas e elimina duplicatas locais", () => {
    const optimistic = [{ id: "new" }, { id: "new" }, { id: "other" }];
    const server = [{ id: "saved" }];
    expect(mergeUniqueBets(optimistic, server).map((bet: { id: string }) => bet.id)).toEqual([
      "new",
      "other",
      "saved",
    ]);
  });
});
