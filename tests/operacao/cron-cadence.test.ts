import { describe, expect, it } from "vitest";
import { cronMaxGapMinutes, latestCronFiring } from "@/src/domain/cron-cadence";

describe("cronMaxGapMinutes", () => {
  it.each([
    ["* * * * *", 1],
    ["*/5 * * * *", 5],
    ["2-59/5 * * * *", 5],
    ["3/15 * * * *", 15],
    ["6,16,26,36,46,56 * * * *", 10],
    ["15 1-23/2 * * *", 120],
    ["20 3-21/6 * * *", 360],
    ["40 3 * * *", 24 * 60],
    ["0 9 * * 1", 7 * 24 * 60],
  ])("%s dispara no máximo a cada %i min", (cron, gap) => {
    expect(cronMaxGapMinutes(cron)).toBe(gap);
  });

  it("conta a volta do dia e o intervalo desigual", () => {
    // 09:00 e 21:00: 12 h nos dois sentidos; 03:00 e 05:00: 22 h pela volta.
    expect(cronMaxGapMinutes("0 9,21 * * *")).toBe(720);
    expect(cronMaxGapMinutes("0 3,5 * * *")).toBe(22 * 60);
    // Segunda e quinta às 09:00: 3 dias de segunda a quinta, 4 de quinta a segunda.
    expect(cronMaxGapMinutes("0 9 * * 1,4")).toBe(4 * 24 * 60);
  });

  it("recusa forma que não sabe ler em vez de inventar cadência", () => {
    expect(() => cronMaxGapMinutes("0 0 1 * *")).toThrow(/dia do mês ou mês/);
    expect(() => cronMaxGapMinutes("0 0 * 1 *")).toThrow(/dia do mês ou mês/);
    expect(() => cronMaxGapMinutes("0 9 * * 7")).toThrow(/limites/);
    expect(() => cronMaxGapMinutes("L * * * *")).toThrow(/fora do suportado/);
    expect(() => cronMaxGapMinutes("70 * * * *")).toThrow(/limites/);
    expect(() => cronMaxGapMinutes("* * * *")).toThrow(/cinco campos/);
  });
});

describe("latestCronFiring", () => {
  const utc = (iso: string) => new Date(iso);

  it("acha o disparo mais recente no relógio de São Paulo", () => {
    // 15 1-23/2 no relógio de São Paulo: as horas ímpares locais, 19:15 local = 22:15 UTC.
    expect(latestCronFiring("15 1-23/2 * * *", utc("2026-09-23T22:00:00Z"), utc("2026-09-23T23:30:00Z"), 3)?.toISOString())
      .toBe("2026-09-23T22:15:00.000Z");
    expect(latestCronFiring("15 1-23/2 * * *", utc("2026-09-23T22:15:00Z"), utc("2026-09-24T00:14:00Z"), 3)).toBeNull();
  });

  it("atravessa a meia-noite do relógio e respeita os dois extremos", () => {
    // 5 0 no relógio de São Paulo = 03:05 UTC do dia seguinte.
    expect(latestCronFiring("5 0 * * *", utc("2026-09-23T12:00:00Z"), utc("2026-09-24T03:05:00Z"), 3)?.toISOString())
      .toBe("2026-09-24T03:05:00.000Z");
    expect(latestCronFiring("5 0 * * *", utc("2026-09-24T03:05:00Z"), utc("2026-09-24T12:00:00Z"), 3)).toBeNull();
    expect(latestCronFiring("5 0 * * *", utc("2026-09-24T03:04:00Z"), utc("2026-09-24T03:04:59Z"), 3)).toBeNull();
  });

  it("o cron semanal só dispara no dia da semana dele", () => {
    // 21/09/2026 é segunda: 09:00 em São Paulo = 12:00 UTC.
    expect(latestCronFiring("0 9 * * 1", utc("2026-09-21T11:00:00Z"), utc("2026-09-24T12:00:00Z"), 3)?.toISOString())
      .toBe("2026-09-21T12:00:00.000Z");
    expect(latestCronFiring("0 9 * * 1", utc("2026-09-21T12:00:00Z"), utc("2026-09-28T11:59:00Z"), 3)).toBeNull();
    expect(latestCronFiring("0 9 * * 1", utc("2026-09-10T00:00:00Z"), utc("2026-09-28T12:00:00Z"), 3)?.toISOString())
      .toBe("2026-09-28T12:00:00.000Z");
  });
});
