import { describe, expect, it } from "vitest";
import { entrouAoVivo } from "@/src/domain/entrada-ao-vivo";
import { formatLeadTime } from "@/app/_design/screens/analyzer/timing-tab";

describe("antecedência média no Analyzer", () => {
  it("registro depois do início mostra o atraso sem presumir entrada ao vivo", () => {
    // Média de −0,1 h = 6 min depois do apito; sem o sinal virava "<1 min".
    expect(formatLeadTime(-0.1)).toBe("-6 min (após início)");
    expect(formatLeadTime(-3)).toBe("-3.0 h (após início)");
    // Registro retrospectivo manual: não prova bola rolando, pela janela do produto.
    expect(entrouAoVivo({ kickoff: new Date("2026-09-09T12:00:00Z"),
      registradoEm: new Date("2026-09-09T16:00:00Z") })).toBe(false);
    expect(formatLeadTime(-4)).toBe("-4.0 h (após início)");
    expect(formatLeadTime(-0.005)).toBe("<1 min (após início)");
  });

  it("antecedência positiva segue a escrita de duração do painel", () => {
    expect(formatLeadTime(2.5)).toBe("2.5 h");
    expect(formatLeadTime(0.25)).toBe("15 min");
    expect(formatLeadTime(null)).toBe("—");
  });
});
