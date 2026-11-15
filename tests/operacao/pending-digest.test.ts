import { describe, expect, it } from "vitest";
import { truncatePendingDigestMessage } from "@/src/services/ops/digests/pending-digest";

describe("truncatePendingDigestMessage", () => {
  it("preserva mensagens curtas", () => {
    expect(truncatePendingDigestMessage("⏳ duas pendências")).toBe("⏳ duas pendências");
  });

  it("trunca por caractere Unicode e prefere linha completa", () => {
    const raw = `Cabeçalho\n${"⚽ aposta completa\n".repeat(300)}`;
    const result = truncatePendingDigestMessage(raw, 180);

    expect(Array.from(result).length).toBeLessThanOrEqual(180);
    expect(result).toContain("resumo truncado; veja Operações.");
    expect(result).not.toContain("\uFFFD");
    expect(result.split("\n").at(-2)).toBe("⚽ aposta completa");
  });

  it("o sufixo do corte aponta para a tela do resumo", () => {
    const result = truncatePendingDigestMessage(`Cabeçalho\n${"📋 canal\n".repeat(300)}`, 180, "Tipsters");

    expect(Array.from(result).length).toBeLessThanOrEqual(180);
    expect(result.endsWith("\n… resumo truncado; veja Tipsters.")).toBe(true);
  });
});
