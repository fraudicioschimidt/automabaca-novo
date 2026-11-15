import { describe, expect, it } from "vitest";
import { loteAlcancaAposta, lotePodeDesfazer } from "@/src/domain/settlement/manual-batch";

describe("lote de liquidação manual de Operações", () => {
  it("retorna true para PENDING em destinos terminais", () => {
    expect(loteAlcancaAposta("PENDING", "WON")).toBe(true);
    expect(loteAlcancaAposta("PENDING", "LOST")).toBe(true);
    expect(loteAlcancaAposta("PENDING", "HALF_WON")).toBe(true);
    expect(loteAlcancaAposta("PENDING", "HALF_LOST")).toBe(true);
    expect(loteAlcancaAposta("PENDING", "VOID")).toBe(true);
  });

  it("retorna false para qualquer status diferente de PENDING quando destino !== 'PENDING'", () => {
    expect(loteAlcancaAposta("WON", "LOST")).toBe(false);
    expect(loteAlcancaAposta("LOST", "WON")).toBe(false);
    expect(loteAlcancaAposta("VOID", "WON")).toBe(false);
    expect(loteAlcancaAposta("HALF_WON", "LOST")).toBe(false);
    expect(loteAlcancaAposta("CANCELLED", "WON")).toBe(false);
    expect(loteAlcancaAposta("DRAFT", "WON")).toBe(false);
    expect(loteAlcancaAposta("UNKNOWN", "WON")).toBe(false);
  });

  it("retorna true para qualquer status quando destino === 'PENDING' (operação de desfazer)", () => {
    expect(loteAlcancaAposta("WON", "PENDING")).toBe(true);
    expect(loteAlcancaAposta("LOST", "PENDING")).toBe(true);
    expect(loteAlcancaAposta("VOID", "PENDING")).toBe(true);
    expect(loteAlcancaAposta("HALF_WON", "PENDING")).toBe(true);
    expect(loteAlcancaAposta("HALF_LOST", "PENDING")).toBe(true);
    expect(loteAlcancaAposta("PENDING", "PENDING")).toBe(true);
  });

  it("desfazer do lote só a liquidação manual deste operador", () => {
    expect(lotePodeDesfazer("WON", "manual:tester", "tester")).toBe(true);
    expect(lotePodeDesfazer("WON", "flashscore", "tester")).toBe(false);
    expect(lotePodeDesfazer("WON", "manual:outro", "tester")).toBe(false);
    expect(lotePodeDesfazer("PENDING", "manual:tester", "tester")).toBe(false);
  });
});
