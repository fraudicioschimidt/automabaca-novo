import { describe, expect, it, vi } from "vitest";
import { SingleFlight } from "@/src/providers/core/single-flight";

describe("SingleFlight", () => {
  it("chamadas simultâneas com a mesma chave dividem uma execução", async () => {
    const flights = new SingleFlight<number>();
    let release!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const first = flights.run("k", load);
    const second = flights.run("k", load);
    expect(flights.inFlight("k")).toBe(first);
    release(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("libera a chave ao terminar, inclusive com erro", async () => {
    const flights = new SingleFlight<number>();
    await expect(flights.run("k", async () => { throw new Error("falhou"); })).rejects.toThrow("falhou");
    expect(flights.inFlight("k")).toBeUndefined();
    await expect(flights.run("k", async () => 2)).resolves.toBe(2);
    await expect(flights.run("outra", async () => 3)).resolves.toBe(3);
  });

  it("clear não deixa a execução antiga apagar a nova", async () => {
    const flights = new SingleFlight<number>();
    let releaseOld!: (value: number) => void;
    const old = flights.run("k", () => new Promise<number>((resolve) => { releaseOld = resolve; }));
    flights.clear();
    const fresh = flights.run("k", () => new Promise<number>(() => {}));
    releaseOld(1);
    await old;
    expect(flights.inFlight("k")).toBe(fresh);
  });
});
