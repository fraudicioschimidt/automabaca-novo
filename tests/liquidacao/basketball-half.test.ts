import { describe, expect, it } from "vitest";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { supportsBasketballFirstHalf } from "@/src/domain/settlement/basketball-half";
import { verifyBasketballHalfDetails } from "@/src/providers/flashscore/basketball-half";
import measured from "../fixtures/flashscore-basketball-half-20260913.json";
import { halfFixture } from "../helpers/basketball-half";

const bet = { mercado: "Total de Pontos - 1º Tempo", selecao: "Over 82.5", evento: "Alpha vs Beta",
  esporte: "Basketball", homeScore: 47, awayScore: 39, odds: 2, stake: 1, scorePeriod: "HT" as const };

describe("basquete no 1º tempo: contrato e aritmética", () => {
  it.each([
    ["Over 82.5", "WON", 1], ["Under 82.5", "LOST", -1], ["Over 86", "VOID", 0],
    ["Over 85.75", "HALF_WON", 0.5], ["Over 86.25", "HALF_LOST", -0.5],
  ])("total %s", (selecao, status, lucro) => {
    expect(resolveResultFromScore({ ...bet, selecao })).toEqual({ ok: true, status, lucro });
  });
  it.each([["Alpha -5.5", "WON"], ["Alpha -8", "VOID"], ["Beta +5.5", "LOST"]])("handicap %s", (selecao, status) => {
    expect(resolveResultFromScore({ ...bet, mercado: "Handicap Asiático - 1º Tempo", selecao })).toMatchObject({ ok: true, status });
  });
  it("FT continua incapaz de liquidar HT", () => {
    expect(resolveResultFromScore({ ...bet, scorePeriod: undefined, homeScore: 87, awayScore: 79 })).toEqual({ ok: false, reason: "wrong_period" });
  });
  it.each([
    { mercado: "Total - 1º Tempo incluindo OT" },
    { mercado: "Total incluindo OT", selecao: "Over 82.5 HT including overtime" },
  ])("período contraditório não aceita o placar FT: %j", (change) => {
    expect(resolveResultFromScore({ ...bet, ...change, scorePeriod: undefined, homeScore: 87, awayScore: 79 }))
      .toEqual({ ok: false, reason: "wrong_period" });
  });
  it.each([
    { esporte: "Soccer" }, { mercado: "Moneyline - 1º Tempo", selecao: "Alpha" },
    { mercado: "Total de Pontos - 2º Tempo" }, { mercado: "Total - 1º Quarto" },
    { mercado: "Total - 1º Tempo", selecao: "Over 82.5 2H" },
    { mercado: "Rebotes - 1º Tempo" }, { mercado: "European Handicap - 1º Tempo", selecao: "Alpha -1" },
    { mercado: "Total - 1º Tempo incluindo OT" }, { mercado: "Total - Match" },
    { mercado: "Total - 1º Tempo", selecao: "Alpha Over 42.5" },
  ])("recusa contrato incompatível %j", (change) => {
    expect(supportsBasketballFirstHalf({ ...bet, ...change })).toBe(false);
    expect(resolveResultFromScore({ ...bet, ...change }).ok).toBe(false);
  });
  it("aceita período declarado apenas na seleção", () => {
    expect(resolveResultFromScore({ ...bet, mercado: "Total de Pontos", selecao: "Over 82.5 HT" })).toMatchObject({ ok: true, status: "WON" });
  });
  it.each([{ liveScoreHome: 0, liveScoreAway: 0 }, { liveTextAtCapture: true }])("recusa live %j", (change) => {
    expect(resolveResultFromScore({ ...bet, ...change })).toMatchObject({ ok: false });
  });
});

describe("basquete no 1º tempo: prova de parciais Flashscore", () => {
  it.each(measured.observations)("aceita contrato real medido $body.match_id", (o) => {
    const proof = verifyBasketballHalfDetails({ body: o.body,
      candidate: { match: o.listed, score: 2, swapped: false, strategy: "provider_id" },
      requestStartedAt: o.requestStartedAt, observedAt: o.observedAt, now: new Date(o.observedAt) });
    expect(proof.ok).toBe(true);
  });
  it("orienta quartos e total HT quando os times estão invertidos", () => {
    const f = halfFixture(); f.candidate.swapped = true;
    expect(verifyBasketballHalfDetails(f)).toMatchObject({ ok: true, proof: { score: { home: 39, away: 47 }, quarters: [{ home: 20, away: 25 }, { home: 19, away: 22 }, { home: 20, away: 20 }, { home: 20, away: 20 }] } });
  });
  it.each([
    ["quarto ausente", (f: ReturnType<typeof halfFixture>) => { Object.assign(f.body.scores, { home_2nd_quarter: null }); }],
    ["quarto negativo", (f: ReturnType<typeof halfFixture>) => { f.body.scores.home_2nd_quarter = -1; }],
    ["soma divergente", (f: ReturnType<typeof halfFixture>) => { f.body.scores.home_2nd_quarter++; }],
    ["outra partida", (f: ReturnType<typeof halfFixture>) => { f.body.match_id = "other"; }],
    ["outro time", (f: ReturnType<typeof halfFixture>) => { f.body.home_team.team_id = "other"; }],
    ["observação anterior ao jogo", (f: ReturnType<typeof halfFixture>) => { f.candidate.match.timestamp = f.now.getTime() / 1_000 + 1; }],
    ["esporte errado", (f: ReturnType<typeof halfFixture>) => { Object.assign(f.body.sport, { sport_id: 1 }); }],
    ["ao intervalo", (f: ReturnType<typeof halfFixture>) => { Object.assign(f.body.match_status, { stage: "Half Time", is_finished: false }); }],
    ["final contraditório", (f: ReturnType<typeof halfFixture>) => { f.candidate.match.scores.home = 88; }],
    ["OT sem flag", (f: ReturnType<typeof halfFixture>) => { f.body.scores.home_overtime = 3; }],
    ["flag OT sem pontos", (f: ReturnType<typeof halfFixture>) => { f.body.match_status.is_finished_after_extra_time = true; }],
    ["placar HT contraditório", (f: ReturnType<typeof halfFixture>) => { f.body.scores.home_1st_half = 48; }],
    ["observação vencida", (f: ReturnType<typeof halfFixture>) => { f.now = new Date(f.now.getTime() + 360_000); }],
  ] as const)("recusa %s", (_label, mutate) => {
    const f = halfFixture(); mutate(f); expect(verifyBasketballHalfDetails(f).ok).toBe(false);
  });
  it("exclui prorrogação comprovada do placar HT", () => {
    const f = halfFixture(); f.body.scores.away_4th_quarter = 28;
    Object.assign(f.body.scores, { home_overtime: 8, away_overtime: 5, home: 95, home_total: 95, away: 92, away_total: 92 });
    f.body.match_status.is_finished_after_extra_time = true;
    f.candidate.match.match_status.is_finished_after_extra_time = true;
    f.candidate.match.scores = { home: 95, away: 92 };
    expect(verifyBasketballHalfDetails(f)).toMatchObject({ ok: true, proof: { score: { home: 47, away: 39 } } });
  });
});
