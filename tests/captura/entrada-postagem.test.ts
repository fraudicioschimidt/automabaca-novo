import { describe, expect, it } from "vitest";
import { entrouAoVivo } from "@/src/domain/entrada-ao-vivo";
import { instanteDaEntrada } from "@/src/domain/instante-da-entrada";
import { dentroDaJanelaDeEntrada } from "@/src/domain/janela-de-entrada";

describe("postagem pré-jogo com OCR atrasado", () => {
  const bet = {
    sourcePostedAt: new Date("2026-09-11T18:57:47Z"),
    registradoEm: new Date("2026-09-11T19:15:07Z"),
    kickoff: new Date("2026-09-11T19:00:00Z"),
  };
  it("preserva pré-jogo e mantém a janela da tip na hora do post", () => {
    expect(entrouAoVivo(bet)).toBe(false);
    expect(dentroDaJanelaDeEntrada(instanteDaEntrada(bet), bet.registradoEm)).toBe(false);
    expect(dentroDaJanelaDeEntrada(instanteDaEntrada(bet), new Date("2026-09-11T18:58:00Z"))).toBe(true);
  });
  it("mantém ao vivo quando a postagem original é posterior ao início, mesmo além de 3h", () => {
    expect(entrouAoVivo({ ...bet, sourcePostedAt: new Date("2026-09-11T22:15:00Z"), registradoEm: new Date("2026-09-12T02:00:00Z") })).toBe(true);
  });
  it("placar explícito prevalece sobre o horário; sem horário da origem vale o registro", () => {
    expect(entrouAoVivo({ ...bet, liveScoreHome: 0, liveScoreAway: 0 })).toBe(true);
    expect(entrouAoVivo({ ...bet, sourcePostedAt: null })).toBe(true);
    expect(entrouAoVivo({ ...bet, kickoffInferido: true })).toBe(false);
  });
});
