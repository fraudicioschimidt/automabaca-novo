import { describe, expect, it } from "vitest";
import { parseLlmJsonText } from "@/src/infra/llm/parse-json";

describe("parseLlmJsonText", () => {
  it("parseia JSON direto", () => {
    expect(parseLlmJsonText('{"a":1}')).toEqual({ a: 1 });
  });

  it("extrai de fence markdown", () => {
    expect(parseLlmJsonText('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("extrai objeto embutido em texto", () => {
    expect(parseLlmJsonText('aqui: {"x":2} fim')).toEqual({ x: 2 });
  });

  it("retorna null para lixo", () => {
    expect(parseLlmJsonText("não é json")).toBeNull();
    expect(parseLlmJsonText("")).toBeNull();
  });

  it("tira a vírgula sobrando sem mexer em números nem em texto", () => {
    expect(parseLlmJsonText('{"isBet": true, "odds": 1.8333, "stake": 0.3333,}')).toEqual({ isBet: true, odds: 1.8333, stake: 0.3333 });
    expect(parseLlmJsonText('Aqui está: {"odds": 1.83333, "selecao": "Over 2.12345",} fim'))
      .toEqual({ odds: 1.83333, selecao: "Over 2.12345" });
    expect(parseLlmJsonText('```json\n{"odds": 2.0125,}\n```')).toEqual({ odds: 2.0125 });
    expect(parseLlmJsonText('{"bets":[{"odds": 1.8333},]}')).toEqual({ bets: [{ odds: 1.8333 }] });
    expect(parseLlmJsonText('{"selecao": "Over 2.5,}", "nota": "a \\",]", "odds": 1.9,}'))
      .toEqual({ selecao: "Over 2.5,}", nota: 'a ",]', odds: 1.9 });
  });

  it("não inventa } em JSON truncado (input hostil)", () => {
    expect(parseLlmJsonText('{"isBet":true,"evento":"A vs B","stake":1')).toBeNull();
  });

  // A geração recusada da Groq e a anotação do OCR chegam sem teto de tamanho:
  // a string que não fecha, cheia de aspas escapadas, não pode travar o worker.
  it("string sem fechar com muitas aspas escapadas não trava o event loop", () => {
    const degenerate = `{"nota": "${'\\"'.repeat(32_000)}`;
    const started = performance.now();
    expect(parseLlmJsonText(degenerate)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
    expect(parseLlmJsonText('{"nota": "a \\"b\\" c",} "sobra')).toEqual({ nota: 'a "b" c' });
  });
});
