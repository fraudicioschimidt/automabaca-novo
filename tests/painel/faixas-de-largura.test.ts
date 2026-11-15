import { describe, expect, it } from "vitest";
import { porFaixa } from "@/app/_design/kit/faixas";

describe("porFaixa", () => {
  it("define as três faixas juntas, com o médio e o compacto herdando quando omitidos", () => {
    const { className, style } = porFaixa({ display: "grid" }, {
      gridTemplateColumns: { largo: "repeat(4,1fr)", medio: "repeat(2,1fr)" },
      gap: { largo: 16, compacto: 10 },
    });
    expect(style).toMatchObject({
      display: "grid",
      "--fx-l-grid-template-columns": "repeat(4,1fr)",
      "--fx-m-grid-template-columns": "repeat(2,1fr)",
      "--fx-c-grid-template-columns": "repeat(2,1fr)",
      "--fx-l-gap": "16px",
      "--fx-m-gap": "16px",
      "--fx-c-gap": "10px",
    });
    // Nada inline para as responsivas: o inline venceria a classe.
    expect(style).not.toHaveProperty("gridTemplateColumns");
    expect(style).not.toHaveProperty("gap");
    expect(className.split(" ")).toHaveLength(2);
  });

  it("mantém a classe de quem chama e não põe px em propriedade sem unidade", () => {
    const { className, style } = porFaixa({}, { flex: { largo: "0 1 auto", compacto: 1 } }, "app-main");
    expect(className.split(" ")[0]).toBe("app-main");
    expect(style).toMatchObject({ "--fx-c-flex": "1" });
  });
});

