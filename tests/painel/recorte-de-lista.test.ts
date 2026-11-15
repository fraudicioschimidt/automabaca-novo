import { describe, expect, it } from "vitest";
import { textoDoRecorte } from "@/src/domain/recorte-de-lista";

describe("textoDoRecorte", () => {
  it("declara N de T quando a página não é o universo", () => {
    expect(textoDoRecorte(30, 31)).toBe("Exibindo 30 de 31");
  });

  it("acrescenta a janela quando o recorte também é temporal", () => {
    expect(textoDoRecorte(200, 512, "últimos 7 dias")).toBe("Exibindo 200 de 512 · últimos 7 dias");
  });

  it("some quando a lista mostrou tudo ou o total é desconhecido", () => {
    expect(textoDoRecorte(12, 12)).toBeNull();
    expect(textoDoRecorte(12, 3)).toBeNull();
    expect(textoDoRecorte(12, Number.NaN)).toBeNull();
  });
});
