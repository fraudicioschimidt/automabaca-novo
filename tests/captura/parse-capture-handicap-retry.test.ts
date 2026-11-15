import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedBetPost } from "@/src/domain/bet-capture";

vi.mock("@/src/infra/llm/cascade", () => ({
  llmGenerateJson: vi.fn(),
}));

import { llmGenerateJson } from "@/src/infra/llm/cascade";
import {
  retryHandicapLineWhenTruncated,
  retryHandicapSideWhenMissingTeam,
} from "@/src/services/capture/preparation/parse-capture-handicap-retry";

const image = { base64: "abc", mimeType: "image/jpeg" };
const images = async () => [image];

function ahBet(selecao: string, evento = "Athletic Club MG vs Rival"): ParsedBetPost {
  return {
    evento,
    esporte: "Soccer",
    competicao: "",
    pais: "",
    mercado: "Asian Handicap",
    selecao,
    odds: 1.9,
    stake: 1,
    data: null,
    casaDeAposta: "",
  };
}

beforeEach(() => {
  vi.mocked(llmGenerateJson).mockReset();
});

describe("retryHandicapLineWhenTruncated", () => {
  it("0.0, -0.5 → média -0.25", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { selecao: "Athletic Club MG 0.0, -0.5" },
      provider: "gemini",
    });
    // Entrada sem time: zero isolado ainda dispara retry (split truncado).
    const r = await retryHandicapLineWhenTruncated({
      bet: ahBet("0"),
      images,
    });
    expect(r?.selecao).toBe("Athletic Club MG -0.25");
  });

  it("0.0,+0.5 → +0.25", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { selecao: "FC Flora Tallinn 0.0,+0.5" },
      provider: "gemini",
    });
    const r = await retryHandicapLineWhenTruncated({
      bet: ahBet("0.0", "FC Flora Tallinn vs Rival"),
      images,
    });
    expect(r?.selecao).toBe("FC Flora Tallinn +0.25");
  });

  it.each(["−", "–", "—"])("preserva o sinal %s da linha decimal na releitura", async (minus) => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { selecao: `Athletic Club MG ${minus}0,5` }, provider: "gemini",
    });
    const result = await retryHandicapLineWhenTruncated({ bet: ahBet("0"), images });
    expect(result?.selecao).toBe("Athletic Club MG -0.5");
  });

  it("AH 0 com time já completo → não chama LLM", async () => {
    const r = await retryHandicapLineWhenTruncated({
      bet: ahBet("Athletic Club MG 0"),
      images,
    });
    expect(r).toBeNull();
    expect(llmGenerateJson).not.toHaveBeenCalled();
  });

  it("retry ainda truncado → null", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { selecao: "0" },
      provider: "gemini",
    });
    const r = await retryHandicapLineWhenTruncated({
      bet: ahBet("0"),
      images,
    });
    expect(r).toBeNull();
  });

  it("seleção sem linha numérica relê o handicap completo", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { selecao: "Charlotte Independence +0.5" },
      provider: "gemini",
    });
    const r = await retryHandicapLineWhenTruncated({
      bet: ahBet(
        "Charlotte Independence",
        "Spokane Velocity vs Charlotte Independence",
      ),
      images,
    });
    expect(r?.selecao).toBe("Charlotte Independence +0.5");
  });

  it("Moneyline → null (sem LLM)", async () => {
    const r = await retryHandicapLineWhenTruncated({
      bet: { ...ahBet("Flamengo"), mercado: "Moneyline", selecao: "Flamengo" },
      images,
    });
    expect(r).toBeNull();
    expect(llmGenerateJson).not.toHaveBeenCalled();
  });
});

describe("retryHandicapSideWhenMissingTeam", () => {
  it("círculo no mandante: 0.0, -0.5 → Yanbian -0.25", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { selecao: "Yanbian Longding 0.0, -0.5" },
      provider: "gemini",
    });
    const r = await retryHandicapSideWhenMissingTeam({
      bet: ahBet("0.0, -0.5", "Yanbian Longding vs Nanjing City"),
      images,
    });
    expect(r?.selecao).toBe("Yanbian Longding -0.25");
  });

  it("círculo no visitante: +0.5, +1.0 → Copiapo +0.75", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { selecao: "Deportes Copiapo +0.5, +1.0" },
      provider: "gemini",
    });
    const r = await retryHandicapSideWhenMissingTeam({
      bet: ahBet("+0.5, +1.0", "Deportes Temuco vs Deportes Copiapo"),
      images,
    });
    expect(r?.selecao).toBe("Deportes Copiapo +0.75");
  });

  it("já tem time → null (sem LLM)", async () => {
    const r = await retryHandicapSideWhenMissingTeam({
      bet: ahBet("Plaza Colonia 0.0, -0.5", "Plaza Colonia vs Miramar Misiones"),
      images,
    });
    expect(r).toBeNull();
    expect(llmGenerateJson).not.toHaveBeenCalled();
  });

  it("LLM sem time válido → null", async () => {
    vi.mocked(llmGenerateJson).mockResolvedValueOnce({
      data: { selecao: "0.0, -0.5" },
      provider: "gemini",
    });
    const r = await retryHandicapSideWhenMissingTeam({
      bet: ahBet("0.0, -0.5", "Yanbian Longding vs Nanjing City"),
      images,
    });
    expect(r).toBeNull();
  });
});
