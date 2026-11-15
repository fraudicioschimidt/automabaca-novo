import { describe, expect, it } from "vitest";
import { linhaClv, linhaMovimento } from "@/src/domain/mensagem-operador";

describe("peças das mensagens do bot", () => {
  it("movimento da linha: abertura e fechamento justos e a variação", () => {
    expect(linhaMovimento(2.1, 1.95)).toBe("Abertura → fechamento (justas): 2.100 → 1.950 (-7.1%)");
    expect(linhaMovimento(1.9, 2)).toBe("Abertura → fechamento (justas): 1.900 → 2.000 (+5.3%)");
  });

  it("CLV com cor e sem número quando não há", () => {
    expect(linhaClv(22.7)).toBe("CLV +22.7% 🟢");
    expect(linhaClv(-3)).toBe("CLV -3.0% 🔴");
    expect(linhaClv(null)).toBe("CLV indisponível");
  });
});
