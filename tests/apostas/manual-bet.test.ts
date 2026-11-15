import { describe, expect, it } from "vitest";
import { normalizeManualBetInput } from "@/src/domain/manual-bet";

const input = { home: " Santos ", away: " Grêmio ", date: "2026-09-09", time: "15:30", odds: "2,10", stake: "0,5" };

describe("entrada manual comum ao cadastro e à edição", () => {
  it("normaliza decimais, fuso, modalidade e campos opcionais sem I/O", () => {
    expect(normalizeManualBetInput(input)).toEqual({
      data: new Date("2026-09-09T18:30:00Z"), kickoffInferido: false,
      evento: "Santos vs Grêmio", esporte: "Soccer", odds: 2.1, stake: 0.5,
      mercado: "Total", selecao: "Total", casaDeAposta: "", competicao: "", pais: "",
    });
  });

  it.each([
    { odds: "NaN" }, { odds: Infinity }, { odds: 1 }, { stake: 0 }, { stake: -1 },
    { home: " " }, { date: "2026-02-30" }, { time: "25:00" }, { esporte: "inventado" },
  ])("recusa entrada inválida %j", (invalid) => {
    expect(() => normalizeManualBetInput({ ...input, ...invalid })).toThrow();
  });

  it("usa o mercado normalizado quando a seleção está vazia", () => {
    expect(normalizeManualBetInput({ ...input, market: " Moneyline ", line: " " }))
      .toMatchObject({ mercado: "Moneyline", selecao: "Moneyline" });
  });

  // Hora em branco é "não sei o horário": o mesmo marcador de meia-noite da tip
  // que só traz o dia, para a busca de horário corrigir antes do fechamento.
  it.each([undefined, "", " "])("hora %j vira horário a confirmar no dia informado", (time) => {
    expect(normalizeManualBetInput({ ...input, time })).toMatchObject({
      data: new Date("2026-09-09T03:00:00Z"), kickoffInferido: true,
    });
  });

  it("meia-noite digitada é horário confirmado", () => {
    expect(normalizeManualBetInput({ ...input, time: "00:00" })).toMatchObject({
      data: new Date("2026-09-09T03:00:00Z"), kickoffInferido: false,
    });
  });
});
