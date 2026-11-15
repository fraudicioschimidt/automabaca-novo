import { describe, expect, it } from "vitest";
import { analyzerDateFilter, analyzerWindowWhere, parseAnalyzerQuery, ANALYZER_PERIODS } from "@/src/domain/analyzer-query";
import { inAnalyzerRange, inAnalyzerRangeAnterior, textoDaJanela } from "@/app/_design/lib/analyzer-range";
import { spDayKey } from "@/src/domain/dates";

describe("contrato do recorte do Analyzer", () => {
  it("declara os anos quando o histórico atravessa a virada", () => {
    expect(textoDaJanela({ inicio: "2025-01-01", fim: "2026-09-09" })).toBe("01/01/2025 – 09/09/2026");
  });
  it("normaliza parâmetros não confiáveis e limita paginação", () => {
    expect(parseAnalyzerQuery({ periodo: "ruim", pagina: "-3", esporte: ["Soccer"] }))
      .toEqual({ periodo: "tudo", pagina: 1, esporte: "", casa: "" });
    expect(parseAnalyzerQuery({ periodo: "30d", pagina: "99999999", casa: "  Casa A  " }))
      .toMatchObject({ periodo: "30d", pagina: 1_000_000, casa: "Casa A" });
    expect(parseAnalyzerQuery({ casa: "a".repeat(300), pagina: "1.5" }).casa).toHaveLength(100);
  });

  it("sem período na URL vale o padrão da tela; o escolhido, mesmo 'tudo', prevalece", () => {
    expect(parseAnalyzerQuery({}, "90d").periodo).toBe("90d");
    expect(parseAnalyzerQuery({ periodo: "ruim" }, "90d").periodo).toBe("90d");
    expect(parseAnalyzerQuery({ periodo: "tudo" }, "90d").periodo).toBe("tudo");
    expect(parseAnalyzerQuery({ periodo: "7d" }, "90d").periodo).toBe("7d");
  });

  it("o filtro do servidor abre o fim da janela só para a pendente", () => {
    expect(analyzerWindowWhere("tudo", "2026-09-09")).toEqual({});
    const window = analyzerDateFilter("7d", "2026-09-09", true)!;
    expect(analyzerWindowWhere("7d", "2026-09-09", true)).toEqual({
      data: { gte: window.gte }, OR: [{ data: { lt: window.lt } }, { status: "PENDING" }],
    });
  });

  it.each(ANALYZER_PERIODS)("servidor e gráfico usam a mesma população em %s", (periodo) => {
    const today = "2026-09-09";
    const current = analyzerDateFilter(periodo, today);
    const withPrevious = analyzerDateFilter(periodo, today, true);
    for (let offset = -190; offset <= 2; offset++) {
      for (const hour of [2, 3, 23]) {
        const date = new Date(Date.UTC(2026, 8, 9 + offset, hour));
        const day = spDayKey(date);
        const inside = !current || (date >= current.gte && date < current.lt);
        const full = !withPrevious || (date >= withPrevious.gte && date < withPrevious.lt);
        expect(inside, date.toISOString()).toBe(inAnalyzerRange(day, today, periodo));
        expect(full).toBe(inAnalyzerRange(day, today, periodo) || inAnalyzerRangeAnterior(day, today, periodo));
        // A pendente só ganha o que vem depois do fim da janela; o começo vale para todas.
        const future = current !== undefined && date >= current.lt;
        expect(inside || future, `pendente ${date.toISOString()}`).toBe(inAnalyzerRange(day, today, periodo, true));
      }
    }
  });
});
