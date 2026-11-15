import { describe, expect, it } from "vitest";
import { botSilence, channelSilence, type PostHour } from "@/src/domain/channel-silence";

const HOUR = 3_600_000;
const NOW = new Date("2026-10-20T12:00:00Z");
const WARM = new Date(NOW.getTime() - 20 * 24 * HOUR);

/** Um post a cada `everyHours`, dos últimos `days` dias até `lastAgoHours` atrás. */
function rhythm(everyHours: number, days: number, lastAgoHours: number): { hours: PostHour[]; lastPostAt: Date } {
  const last = NOW.getTime() - lastAgoHours * HOUR;
  const hours: PostHour[] = [];
  for (let at = last; at > NOW.getTime() - days * 24 * HOUR; at -= everyHours * HOUR) {
    hours.push({ hour: new Date(Math.floor(at / HOUR) * HOUR), posts: 1 });
  }
  return { hours, lastPostAt: new Date(last) };
}

describe("channelSilence", () => {
  it("mede cada canal contra o próprio ritmo, entre 6 h e 96 h", () => {
    const hourly = rhythm(2, 14, 7);
    expect(channelSilence({ ...hourly, historySince: WARM, now: NOW })).toMatchObject({ state: "mudo", limitHours: 6 });
    expect(channelSilence({ ...rhythm(2, 14, 5), historySince: WARM, now: NOW })).toMatchObject({ state: "ok", limitHours: 6 });

    const daily = rhythm(24, 27, 40);
    expect(channelSilence({ ...daily, historySince: WARM, now: NOW })).toMatchObject({ state: "ok", limitHours: 48 });
    expect(channelSilence({ ...rhythm(24, 27, 49), historySince: WARM, now: NOW })).toMatchObject({ state: "mudo" });

    const rare = rhythm(72, 27, 90);
    // Poucos posts: ainda aprendendo, não mudo.
    expect(channelSilence({ ...rare, historySince: WARM, now: NOW }).state).toBe("aprendendo");
  });

  it("não julga antes de 20 posts em 7 dias nem antes do aquecimento da tabela", () => {
    const busy = rhythm(1, 5, 30);
    expect(channelSilence({ ...busy, historySince: WARM, now: NOW }).state).toBe("aprendendo");
    const steady = rhythm(2, 14, 30);
    expect(channelSilence({ ...steady, historySince: new Date(NOW.getTime() - 6 * 24 * HOUR), now: NOW }).state).toBe("aprendendo");
    expect(channelSilence({ ...steady, historySince: null, now: NOW }).state).toBe("aprendendo");
    expect(channelSilence({ hours: [], lastPostAt: null, historySince: WARM, now: NOW })).toEqual({ state: "aprendendo", lastPostAt: null });
  });
});

/** Posts nas horas `hours` (UTC) dos dias da semana `weekdays` (0 = domingo), nas 4 semanas antes de `until`. */
function weekly(weekdays: number[], hours: number[], until: Date): { hours: PostHour[]; lastPostAt: Date } {
  const rows: PostHour[] = [];
  for (let day = 28; day >= 0; day -= 1) {
    const date = new Date(until.getTime() - day * 24 * HOUR);
    if (!weekdays.includes(date.getUTCDay())) continue;
    for (const hour of hours) {
      const at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour);
      if (at <= until.getTime()) rows.push({ hour: new Date(at), posts: 1 });
    }
  }
  return { hours: rows, lastPostAt: rows.at(-1)!.hour };
}

describe("channelSilence com pausa que se repete", () => {
  // 2026-10-18 é domingo.
  const SUNDAY = new Date("2026-10-18T18:00:00Z");

  it("canal de dia útil não fica calado no fim de semana, mas fica numa semana sem post", () => {
    const weekdays = weekly([1, 2, 3, 4, 5], [10, 12, 14, 16, 18, 20, 22], SUNDAY);
    expect(channelSilence({ ...weekdays, historySince: WARM, now: SUNDAY }).state).toBe("ok");
    const friday = new Date("2026-10-23T12:00:00Z");
    expect(channelSilence({ ...weekdays, historySince: WARM, now: friday }).state).toBe("mudo");
  });

  it("canal que só posta em dia de jogo (fim de semana) não fica calado no meio da semana", () => {
    const games = weekly([0, 6], [16, 18, 20, 21], SUNDAY);
    const friday = new Date("2026-10-23T19:00:00Z");
    expect(channelSilence({ ...games, historySince: WARM, now: friday }).state).toBe("ok");
    expect(channelSilence({ ...games, historySince: WARM, now: new Date("2026-10-26T12:00:00Z") }).state).toBe("mudo");
  });

  it("canal morto continua calado: o ritmo é medido até o último post, não até agora", () => {
    const daily = rhythm(24, 27, 0);
    const later = new Date(NOW.getTime() + 25 * 24 * HOUR);
    expect(channelSilence({ ...daily, historySince: WARM, now: later })).toMatchObject({ state: "mudo", limitHours: 48 });
  });
});

describe("botSilence", () => {
  it("alerta quando nada chega há 2 h numa faixa que costuma ter posts", () => {
    const base = { historySince: WARM, now: NOW, baselinePosts: 14 * 6 };
    expect(botSilence({ ...base, lastUpdateAt: new Date(NOW.getTime() - 2 * HOUR) })).toEqual({ silent: true, expectedPosts: 6 });
    expect(botSilence({ ...base, lastUpdateAt: null }).silent).toBe(true);
    expect(botSilence({ ...base, lastUpdateAt: new Date(NOW.getTime() - HOUR) }).silent).toBe(false);
    // Madrugada sem posts de costume: silêncio normal.
    expect(botSilence({ ...base, baselinePosts: 14 * 4, lastUpdateAt: null }).silent).toBe(false);
    expect(botSilence({ ...base, historySince: new Date(NOW.getTime() - 3 * 24 * HOUR), lastUpdateAt: null }).silent).toBe(false);
  });
});
