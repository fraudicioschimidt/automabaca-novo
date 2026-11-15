import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTOMATIC_RESULT_PROVIDER } from "@/src/providers/coverage";
import * as client from "@/src/providers/pinnacle17/client";
import * as feed from "@/src/providers/pinnacle17/feed";
import * as odds from "@/src/providers/pinnacle17/odds";
import * as sharp from "@/src/providers/pinnacle17/sharp";
import * as types from "@/src/providers/pinnacle17/types";
import { findPinnacle17Event } from "@/src/providers/pinnacle17/feed";
import { resolvePinnacle17CurrentOdds } from "@/src/providers/pinnacle17/odds";
import {
  encodePinnacle17PriceReference,
  parsePinnacle17PriceReference,
  normalizePinnacle17Events,
  normalizePinnacle17Markets,
  pinnacle17SportId,
} from "@/src/providers/pinnacle17/types";
import { scrubSecrets } from "@/src/infra/redaction";

const raw = JSON.parse(readFileSync(join(__dirname, "../fixtures/pinnacle17-soccer.json"), "utf8"));
const event = normalizePinnacle17Events([raw.event])![0]!;
const markets = normalizePinnacle17Markets(raw.markets)!;
const observedAt = new Date("2026-08-24T15:00:00Z");

describe("adapter Pinnacle17", () => {
  it("aceita o dia bissexto válido sem deslocar a data", () => {
    expect(types.normalizePinnacle17Events([{ ...raw.event, startTime: "2028-02-29T18:00:00Z" }])?.[0]?.startTime)
      .toBe("2028-02-29T18:00:00.000Z");
  });

  it.each([null, undefined])("preserva corte de mercado ausente (%j)", (cutoffAt) => {
    const parsed = types.parsePinnacle17Markets([{ ...raw.markets[0], cutoffAt }]);
    expect(parsed?.rejected).toBe(0);
    expect(parsed?.rows[0]?.cutoffAt).toBeNull();
  });

  it.each(["2026-02-31T18:00:00Z", "2026-09-31T18:00:00Z", "2026-08-28T22:00:00", "2026-08-28"])("recusa horário de evento inválido ou sem fuso: %s", (startTime) => {
    expect(types.parsePinnacle17Events([{ ...raw.event, startTime }])).toEqual({ rows: [], rejected: 1 });
  });

  it.each(["2026-02-31T18:00:00Z", "2026-09-31T18:00:00Z", "2026-08-28T22:00:00", "horário desconhecido"])("recusa corte de mercado inválido ou sem fuso: %s", (cutoffAt) => {
    expect(types.parsePinnacle17Markets([{ ...raw.markets[0], cutoffAt }])).toEqual({ rows: [], rejected: 1 });
  });

  it.each(["2026-08-28T19:00:00-03:00", "2026-08-29T01:00:00+03:00"])("preserva o instante de um horário válido com offset: %s", (startTime) => {
    expect(types.normalizePinnacle17Events([{ ...raw.event, startTime }])?.[0]?.startTime).toBe("2026-08-28T22:00:00.000Z");
  });

  it("não chama ausência de cantos de divergência de linha de gols", () => {
    expect(resolvePinnacle17CurrentOdds({ event, markets, esporte: "Soccer",
      mercado: "Total (Corners) – Match", selecao: "Over 9.0", observedAt, now: observedAt,
    })).toEqual({ ok: false, reason: "market_not_listed" });
    expect(resolvePinnacle17CurrentOdds({ event, markets, esporte: "Soccer",
      mercado: "Total – Match", selecao: "Under 99.5", observedAt, now: observedAt,
    })).toEqual({ ok: false, reason: "line_mismatch" });
  });
  it("preserva exatamente a identidade Pinnacle validada e descarta resultado", () => {
    expect(event).toMatchObject({
      id: 1634172613,
      startTime: "2026-08-28T22:00:00.000Z",
      league: { name: "Liga Pro", country: "Argentina" },
      homeTeam: { name: "Union de Santa Fe" },
      awayTeam: { name: "Sarmiento de Junin" },
    });
    expect(event).not.toHaveProperty("score");
    expect(event).not.toHaveProperty("result");
    expect(findPinnacle17Event({
      events: [event],
      home: "Unión Santa Fe",
      away: "Sarmiento",
      kickoffUtc: new Date("2026-08-28T22:00:00Z"),
      competition: "Liga Profesional",
      country: "Argentina",
    })?.event.id).toBe(1634172613);
  });

  it.each([
    ["Money Line – Match", "Union de Santa Fe", "moneyline", "ml", "home", 450],
    ["Handicap – Match", "Union de Santa Fe -0.25", "spread", "-1", "home", 300],
    ["Total – Match", "Under 2.5", "total", "10", "under", 400],
    ["Team Total – Match", "Union de Santa Fe Over 1.5", "team_total", "6", "home_over", 180],
    ["Money Line – 1st Half", "Draw", "moneyline", "ml", "draw", 100],
  ])("resolve livro completo de %s", (mercado, selecao, type, line, outcome, maxBet) => {
    const result = resolvePinnacle17CurrentOdds({
      event,
      markets,
      esporte: "Soccer",
      mercado,
      selecao,
      observedAt,
      now: new Date("2026-08-24T15:01:00Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.current.raw).toBeGreaterThan(1);
    expect(result.value.current.fair).toBeGreaterThan(1);
    expect(result.value.current.maxBet).toBe(maxBet);
    expect(result.value.reference).toMatchObject({ marketType: type, line, outcome });
  });

  it("o horário do jogo vem do corte de um mercado do jogo inteiro, também para a aposta de período", () => {
    const resolve = (mercado: string, selecao: string, rows = markets) => resolvePinnacle17CurrentOdds({
      event, markets: rows, esporte: "Soccer", mercado, selecao, observedAt, now: new Date("2026-08-24T15:01:00Z"),
    });
    const match = resolve("Money Line – Match", "Union de Santa Fe");
    const firstHalf = resolve("Money Line – 1st Half", "Draw");
    expect(match.ok && match.value.gameStartAt).toEqual(new Date("2026-08-28T22:00:00Z"));
    expect(firstHalf.ok && firstHalf.value.gameStartAt).toEqual(new Date("2026-08-28T22:00:00Z"));
    // O corte do próprio mercado de período não diz quando o jogo começa.
    const onlyPeriods = resolve("Money Line – 1st Half", "Draw", markets.filter((market) => market.period !== 0));
    expect(onlyPeriods.ok && onlyPeriods.value.gameStartAt).toBeNull();
  });

  it("preserva limite fracionário da linha Pinnacle17 no snapshot", () => {
    const rows = structuredClone(markets);
    for (const market of rows) market.limits = [{ type: "maxRiskStake", amount: 499.75 }];
    const result = resolvePinnacle17CurrentOdds({ event, markets: rows, esporte: "Soccer", mercado: "Money Line – Match",
      selecao: "Union de Santa Fe", observedAt, now: new Date("2026-08-24T15:01:00Z") });
    expect(result.ok && result.value.current.maxBet).toBe(499.75);
    expect(result.ok && result.value.current.snapshot.maxBet).toBe(499.75);
  });

  it("resolve linhas de escanteios (Corners) com units dedicadas", () => {
    const cornerMarket = {
      name: "Total (Corners) – Match",
      type: "total" as const,
      period: 0,
      periodName: "Match",
      team: null,
      units: "Corners",
      special: null,
      isLive: false,
      line: 9.5,
      status: "open",
      cutoffAt: "2026-08-28T22:00:00Z",
      limits: [{ amount: 250, type: "maxRiskStake" }],
      outcomes: [
        { designation: "over" as const, name: "Over 9.5", line: 9.5, oddsAmerican: 100, oddsDecimal: 2.0 },
        { designation: "under" as const, name: "Under 9.5", line: 9.5, oddsAmerican: -120, oddsDecimal: 1.833 },
      ],
    };

    const result = resolvePinnacle17CurrentOdds({
      event,
      markets: [...markets, cornerMarket],
      esporte: "Soccer",
      mercado: "Total de Escanteios",
      selecao: "Mais de 9.5",
      observedAt,
      now: new Date("2026-08-24T15:01:00Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.current.raw).toBe(2.0);
    expect(result.value.current.maxBet).toBe(250);
    expect(result.value.reference).toMatchObject({
      marketType: "total",
      line: "38",
      outcome: "over",
    });
  });

  it("resolve tênis com unidades de Sets e Games", () => {
    const tennisEvent = {
      ...event,
      id: 1634880765,
      sport: { id: 33, name: "Tennis" },
      homeTeam: { name: "Heather Watson" },
      awayTeam: { name: "Harriet Dart" },
    };
    const tennisMarkets = [
      {
        name: "Money Line (Sets) – Match",
        type: "moneyline" as const,
        period: 0,
        periodName: "Match",
        team: null,
        units: "Sets",
        special: null,
        isLive: false,
        line: null,
        status: "open",
        cutoffAt: "2026-08-28T22:00:00Z",
        limits: [{ amount: 500, type: "maxRiskStake" }],
        outcomes: [
          { designation: "home" as const, name: "Heather Watson", line: null, oddsAmerican: 110, oddsDecimal: 2.1 },
          { designation: "away" as const, name: "Harriet Dart", line: null, oddsAmerican: -133, oddsDecimal: 1.75 },
        ],
      },
      {
        name: "Handicap (Games) – Match",
        type: "spread" as const,
        period: 0,
        periodName: "Match",
        team: null,
        units: "Games",
        special: null,
        isLive: false,
        line: 1.5,
        status: "open",
        cutoffAt: "2026-08-28T22:00:00Z",
        limits: [{ amount: 350, type: "maxRiskStake" }],
        outcomes: [
          { designation: "home" as const, name: "Heather Watson +1.5", line: 1.5, oddsAmerican: -111, oddsDecimal: 1.9 },
          { designation: "away" as const, name: "Harriet Dart -1.5", line: -1.5, oddsAmerican: -105, oddsDecimal: 1.95 },
        ],
      },
    ];

    const mlResult = resolvePinnacle17CurrentOdds({
      event: tennisEvent,
      markets: tennisMarkets,
      esporte: "Tennis",
      mercado: "Moneyline",
      selecao: "Heather Watson",
      observedAt,
      now: new Date("2026-08-24T15:01:00Z"),
    });
    expect(mlResult.ok).toBe(true);
    if (!mlResult.ok) return;
    expect(mlResult.value.current.raw).toBe(2.1);
    expect(mlResult.value.current.maxBet).toBe(500);

    const spreadResult = resolvePinnacle17CurrentOdds({
      event: tennisEvent,
      markets: tennisMarkets,
      esporte: "Tennis",
      mercado: "Handicap (Games) – Match",
      selecao: "Heather Watson +1.5",
      observedAt,
      now: new Date("2026-08-24T15:01:00Z"),
    });
    expect(spreadResult.ok).toBe(true);
    if (!spreadResult.ok) return;
    expect(spreadResult.value.current.raw).toBe(1.9);
    expect(spreadResult.value.current.maxBet).toBe(350);
  });

  it("falha fechado em livro incompleto, stale, live ou fechado", () => {
    const incomplete = markets.map((market) => market.type === "total"
      ? { ...market, outcomes: market.outcomes.slice(0, 1) }
      : market);
    expect(resolvePinnacle17CurrentOdds({
      event,
      markets: incomplete,
      esporte: "Soccer",
      mercado: "Total – Match",
      selecao: "Under 2.5",
      observedAt,
      now: new Date("2026-08-24T15:01:00Z"),
    })).toEqual({ ok: false, reason: "line_mismatch" });
    expect(resolvePinnacle17CurrentOdds({
      event,
      markets,
      esporte: "Soccer",
      mercado: "Total – Match",
      selecao: "Under 2.5",
      observedAt,
      now: new Date("2026-08-24T15:16:00Z"),
    })).toEqual({ ok: false, reason: "stale_price" });
    for (const patch of [{ isLive: true }, { status: "closed" }]) {
      const changed = markets.map((market) => market.type === "total" ? { ...market, ...patch } : market);
      expect(resolvePinnacle17CurrentOdds({
        event,
        markets: changed,
        esporte: "Soccer",
        mercado: "Total – Match",
        selecao: "Under 2.5",
        observedAt,
        now: new Date("2026-08-24T15:01:00Z"),
      }).ok).toBe(false);
    }
  });

  it("mantém referência tipada sem misturar IDs de outros feeds", () => {
    const encoded = encodePinnacle17PriceReference({
      provider: "pinnacle17",
      eventId: 1634172613,
      period: 0,
      marketType: "total",
      line: "10",
      outcome: "under",
    });
    expect(encoded).toBe("pinnacle17:v1:1634172613:0:total:10:under");
    expect(parsePinnacle17PriceReference(encoded)).toMatchObject({ eventId: 1634172613 });
    expect(parsePinnacle17PriceReference("bridgeodds:v1:1634172613")).toBeNull();
  });

  it.each([
    "0:moneyline:10:home", "0:moneyline:ml:over", "0:total:ml:under",
    "0:total:2_5:over", "0:total:-2:over", "0:total:10:home",
    "0:spread:2:draw", "0:team_total:10:under", "0:team_total:10:away_draw",
    "9007199254740992:total:10:over", "0:total:9007199254740992:over",
  ])("recusa referência com termos impossíveis: %s", terms => {
    expect(parsePinnacle17PriceReference(`pinnacle17:v1:123:${terms}`)).toBeNull();
  });

  it("nunca fornece resultado, não exporta settlement e mantém moeda desconhecida", () => {
    expect(AUTOMATIC_RESULT_PROVIDER).not.toBe("pinnacle17");
    const exported = [client, feed, odds, sharp, types].flatMap((module) => Object.keys(module));
    expect(exported.some((key) => /settle|result/i.test(key))).toBe(false);
    expect(pinnacle17SportId("American Football")).toBe(15);
    expect(pinnacle17SportId("Unknown Sport")).toBeNull();
    expect(scrubSecrets("x-rapidapi-key=super-secret-pinnacle17-key"))
      .not.toContain("super-secret-pinnacle17-key");
  });

  it("não aplica AUTO entre reserva numérica e o time principal", () => {
    const reserve = {
      ...event,
      id: event.id + 1,
      homeTeam: { name: "River Plate 2" },
      awayTeam: { name: "Independiente 2" },
    };
    expect(findPinnacle17Event({
      events: [reserve],
      home: "River Plate",
      away: "Independiente",
      kickoffUtc: new Date("2026-08-28T22:00:00Z"),
      competition: "Liga Profesional",
      country: "Argentina",
    })).toBeNull();
    expect(findPinnacle17Event({
      events: [reserve],
      home: "River Plate 2",
      away: "Independiente 2",
      kickoffUtc: new Date("2026-08-28T22:00:00Z"),
    })?.event.id).toBe(reserve.id);
  });
});
