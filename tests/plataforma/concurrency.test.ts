import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "@/src/services/shared/concurrency";

describe("mapWithConcurrency", () => {
  it("preserva ordem e respeita limite", async () => {
    const active: number[] = [];
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      active.push(n);
      peak = Math.max(peak, active.length);
      await new Promise((r) => setTimeout(r, 20));
      active.splice(active.indexOf(n), 1);
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
    // `<= 2` também passa numa implementação SERIAL: diria "respeita o limite"
    // sem provar que existe paralelismo nenhum. Com 5 itens de 20ms e limite 2,
    // o pico é deterministicamente 2 — uma regressão que serialize o mapa deixa
    // os ciclos de revival/closing N× mais lentos em silêncio.
    expect(peak).toBe(2);
  });

  it("limite maior que a lista não trava — todos entram juntos", async () => {
    const active: number[] = [];
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3], 10, async (n) => {
      active.push(n);
      peak = Math.max(peak, active.length);
      await new Promise((r) => setTimeout(r, 20));
      active.splice(active.indexOf(n), 1);
      return n;
    });
    expect(results).toEqual([1, 2, 3]);
    expect(peak).toBe(3);
  });
});
