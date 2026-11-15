import { describe, expect, it } from "vitest";
import { spToUtc } from "@/src/domain/dates";
import { moonIllumination, moonPhase, moonPhaseName, spSky, spSunTimes } from "@/src/domain/sky";

/** Um instante pelo relógio de São Paulo: `sp(9, 25, "05:53")`. */
const sp = (month: number, day: number, time: string, year = 2026) => {
  const [hour, minute] = time.split(":").map(Number);
  return spToUtc({ year, month, day, hour, minute });
};
const minutesApart = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60_000;

describe("céu de São Paulo para a saudação do Dashboard", () => {
  it("nascer e pôr do sol a no máximo um minuto do Observatório Naval dos EUA", () => {
    // aa.usno.navy.mil para São Paulo (-23,55; -46,63), em UTC-3.
    const reference = [
      [6, 21, "06:48", "17:29"],
      [9, 25, "05:53", "18:04"],
      [12, 21, "05:17", "18:52"],
    ] as const;
    for (const [month, day, rise, set] of reference) {
      const { sunrise, sunset } = spSunTimes(sp(month, day, "12:00"));
      expect(minutesApart(sunrise, sp(month, day, rise)), `nascer ${day}/${month}`).toBeLessThanOrEqual(1);
      expect(minutesApart(sunset, sp(month, day, set)), `pôr ${day}/${month}`).toBeLessThanOrEqual(1);
    }
  });

  it("os horários são do dia de SP, mesmo de madrugada", () => {
    const { sunrise } = spSunTimes(sp(9, 25, "00:30"));
    expect(minutesApart(sunrise, sp(9, 25, "05:53"))).toBeLessThanOrEqual(1);
  });

  it("a fase bate com as luas cheias e novas de 2026 do Observatório Naval", () => {
    const full = [Date.UTC(2026, 5, 29, 23, 56), Date.UTC(2026, 8, 26, 16, 49), Date.UTC(2026, 11, 24, 1, 28)];
    const fresh = [Date.UTC(2026, 5, 15, 2, 54), Date.UTC(2026, 8, 11, 3, 27), Date.UTC(2026, 11, 9, 0, 52)];
    for (const t of full) {
      const phase = moonPhase(new Date(t));
      expect(moonIllumination(phase)).toBeGreaterThan(0.99);
      expect(moonPhaseName(phase)).toBe("Lua cheia");
    }
    for (const t of fresh) {
      const phase = moonPhase(new Date(t));
      expect(moonIllumination(phase)).toBeLessThan(0.01);
      expect(moonPhaseName(phase)).toBe("Lua nova");
    }
  });

  it("dá nome às oito fases e à volta do mês", () => {
    const names = [[0, "Lua nova"], [0.1, "Lua crescente"], [0.25, "Quarto crescente"], [0.4, "Gibosa crescente"], [0.5, "Lua cheia"], [0.6, "Gibosa minguante"], [0.75, "Quarto minguante"], [0.9, "Lua minguante"], [0.97, "Lua nova"]] as const;
    for (const [phase, name] of names) expect(moonPhaseName(phase), String(phase)).toBe(name);
    expect(moonIllumination(0)).toBe(0);
    expect(moonIllumination(0.25)).toBeCloseTo(0.5);
    expect(moonIllumination(0.5)).toBe(1);
  });

  it("o momento segue o sol: nascer e pôr baixos por 1h12, manhã e tarde divididas ao meio-dia", () => {
    // 25/09/2026: o sol nasce às 05:53 e se põe às 18:03.
    const moments = [
      ["04:30", "night"], ["06:30", "sunrise"], ["07:00", "sunrise"], ["07:15", "morning"], ["11:59", "morning"],
      ["12:00", "afternoon"], ["16:45", "afternoon"], ["17:00", "sunset"], ["18:10", "night"], ["23:00", "night"],
    ] as const;
    for (const [time, moment] of moments) expect(spSky(sp(9, 25, time)).moment, time).toBe(moment);
    // No inverno, 17h40 ainda é "Boa tarde", mas o sol já se pôs.
    expect(spSky(sp(6, 21, "17:40")).moment).toBe("night");
  });

  it("o balão diz os horários do sol de dia e a lua à noite", () => {
    expect(spSky(sp(9, 25, "10:00")).label).toMatch(/^Nascer do sol às 05:5\d · pôr do sol às 18:0\d$/);
    const night = spSky(sp(9, 25, "22:00"));
    expect(night.label).toMatch(/^Lua cheia, (99|100)% iluminada$/);
    expect(night.moonPhase).toBeGreaterThan(0.44);
    expect(night.moonPhase).toBeLessThan(0.5);
  });

  it("recusa data inválida dizendo quem recebeu", () => {
    const invalid = new Date(Number.NaN);
    expect(() => spSky(invalid)).toThrow("spSky");
    expect(() => spSunTimes(invalid)).toThrow("spSunTimes");
    expect(() => moonPhase(invalid)).toThrow("moonPhase");
  });
});
