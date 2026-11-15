import { describe, expect, it } from "vitest";
import { canonicalDoubleChanceSelection } from "@/src/domain/mercados/double-chance-selection";
import { effectiveSharpBet } from "@/src/domain/mercados/sharp-equivalent";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { parseUniversalBetPost } from "@/src/domain/parse-bet-post";
import { resolvePinnacle17CurrentOdds } from "@/src/providers/pinnacle17/odds";
import type { Pinnacle17Event, Pinnacle17Market } from "@/src/providers/pinnacle17/types";
import { canonicalizeBetForRegistration } from "@/src/services/bets/canonicalize-registration";

const input = { evento: "puerto montt vs rangers de talca", mercado: "Moneyline", esporte: "Soccer" };

describe("Dupla Chance na captura", () => {
  it.each([
    ["talca dc", "X2"], ["TALCA DC", "X2"], ["talca (DC)", "X2"],
    ["talca - dupla chance", "X2"], ["talca / DC", "X2"], ["talca dupla hipótese", "X2"],
    ["DC talca", "X2"], ["DC: talca", "X2"], ["Dupla Chance: talca", "X2"],
    ["Dupla hipótese – talca", "X2"], ["(DC) talca", "X2"],
    ["puerto dc", "1X"], ["casa dc", "1X"], ["visitante dc", "X2"],
    ["1X dc", "1X"], ["DC 2X", "X2"], ["12 dc", "12"],
    ["talca ou empate dc", "X2"], ["puerto ou empate dc", "1X"],
  ])("%s preserva as duas saídas como %s", (selecao, expected) => {
    expect(canonicalDoubleChanceSelection({ ...input, selecao })).toEqual({ mercado: "Double Chance", selecao: expected });
  });

  it.each(["talca", "rangers de talca", "Fora"])("mercado explícito aceita o lado %s", selecao => {
    expect(canonicalDoubleChanceSelection({ ...input, mercado: "Double Chance", selecao })?.selecao).toBe("X2");
  });

  it.each([
    ["United vs Manchester United", "United dc"],
    [input.evento, "outro time dc"], [input.evento, "talca +1 dc"],
    [input.evento, "talca e puerto dc"], [input.evento, "talca não vence dc"],
    [input.evento, "empate dc"], [input.evento, "dc"],
  ])("não escolhe uma cobertura ambígua: %s / %s", (evento, selecao) => {
    const result = canonicalDoubleChanceSelection({ ...input, evento, selecao });
    expect(result?.selecao).toBe(selecao);
  });

  it.each([
    ["DC United vs Toronto", "DC United"], ["Porto vs Washington DC", "Washington DC"],
    [input.evento, "talca"], [input.evento, "talca abcDC"],
  ])("não converte nomes nem seleções sem marcador: %s / %s", (evento, selecao) => {
    expect(canonicalDoubleChanceSelection({ ...input, evento, selecao })).toBeNull();
  });

  it("mantém o período e as estatísticas declarados", () => {
    expect(canonicalDoubleChanceSelection({ ...input, mercado: "1st Half Double Chance", selecao: "talca dc" }))
      .toEqual({ mercado: "1st Half Double Chance", selecao: "X2" });
    expect(canonicalDoubleChanceSelection({ ...input, mercado: "Moneyline Corners", selecao: "talca dc" })).toBeNull();
    expect(canonicalDoubleChanceSelection({ ...input, selecao: "talca 1st half dc" })).toBeNull();
    expect(canonicalDoubleChanceSelection({ ...input, mercado: "Asian Handicap", selecao: "talca dc" })).toBeNull();
  });

  it("não confunde categoria U-19 com uma linha de handicap", () => {
    const evento = "Chester U-19 vs North U-19";
    const result = canonicalDoubleChanceSelection({ ...input, evento, selecao: "North U-19 or Draw dc" });
    expect(result).toEqual({ mercado: "Double Chance", selecao: "X2" });
    expect(pinnacleizeSelecao({ evento, mercadoPinnacle: "Double Chance", selecao: "North U-19 or Draw" })).toBe("Draw or North U-19");
  });

  it.each(["talca dc", "puerto dc", "12 dc"])("preparação repetida preserva %s, com os nomes do tipster", async selecao => {
    const first = await canonicalizeBetForRegistration({ ...input, pais: "Chile", competicao: "Primera B", selecao });
    const second = await canonicalizeBetForRegistration(first);
    expect(second).toEqual(first);
    expect(first.evento).toBe("puerto montt vs rangers de talca");
    expect(first.selecao).toBe(selecao === "talca dc" ? "Draw or rangers de talca" : selecao === "puerto dc" ? "puerto montt or Draw" : "puerto montt or rangers de talca");
  });

  it("texto contraditório não vira 12 na normalização posterior", async () => {
    const bet = await canonicalizeBetForRegistration({ ...input, pais: "Chile", competicao: "Primera B", selecao: "talca +1 dc" });
    expect(bet.selecao).toBe("talca +1 dc");
    expect(pinnacleizeSelecao({ evento: bet.evento, mercadoPinnacle: bet.mercado, selecao: bet.selecao })).toBe(bet.selecao);
    expect(effectiveSharpBet(bet)).toMatchObject({ mercado: "Double Chance", selecao: "talca +1 dc" });
  });

  it("post real chega a uma linha sharp e liquida as duas saídas corretamente", async () => {
    const parsed = parseUniversalBetPost("Tipster: Target\nData: 08/09/2026\nJogo: Puerto Montt x CSD Rangers\nEntrada: rangers dc\nODD: 1.8\nStake: 0.666667u");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("parse falhou");
    const bet = await canonicalizeBetForRegistration(parsed.bet);
    expect(bet).toMatchObject({ mercado: "Double Chance", selecao: "Draw or CSD Rangers", odds: 1.8, stake: 0.666667 });
    expect(effectiveSharpBet(bet)).toMatchObject({ mercado: bet.mercado, selecao: bet.selecao });
    const effective = effectiveSharpBet({ ...bet, esporte: "Soccer" });
    expect(effective).toMatchObject({ mercado: "Asian Handicap", selecao: "CSD Rangers +0.5" });
    const event: Pinnacle17Event = { id: 1635697142, name: bet.evento, startTime: "2026-09-08T21:00:00Z",
      status: { isStarted: false, isInProgress: false, isInterrupted: false }, sport: { id: 29, name: "Soccer" },
      league: { id: 1, name: "Primera B", country: "Chile" }, homeTeam: { name: "Puerto Montt" }, awayTeam: { name: "CSD Rangers" }, units: "Regular" };
    // Livro preservado na consulta de 18:13:24 UTC, dentro da janela de entrada.
    const market: Pinnacle17Market = { name: "Handicap – Match", type: "spread", period: 0, periodName: "Match",
      team: null, units: "Regular", special: null, isLive: false, line: -0.5, status: "open", cutoffAt: event.startTime,
      limits: [{ type: "maxRiskStake", amount: 500 }], outcomes: [
        { name: "Puerto Montt -0.5", designation: "home", line: -0.5, oddsAmerican: 120, oddsDecimal: 2.2 },
        { name: "CSD Rangers +0.5", designation: "away", line: 0.5, oddsAmerican: -157, oddsDecimal: 1.636 },
      ] };
    const observedAt = new Date("2026-09-08T18:13:24.819Z");
    const price = resolvePinnacle17CurrentOdds({ event, markets: [market], esporte: "Soccer", mercado: bet.mercado, selecao: bet.selecao, observedAt, now: observedAt });
    expect(price).toMatchObject({ ok: true, value: { current: { raw: 1.636, maxBet: 500 }, reference: { outcome: "away", line: "2" } } });
    for (const [mercado, selecao, reason] of [
      ["Double Chance", "talca", "ambiguous_selection"],
      ["Double Chance", "12", "unsupported_market"],
      ["Double Chance (Corners)", "X2", "unsupported_market"],
      ["Double Chance", "X2 1st half", "unsupported_market"],
      ["1st Half Double Chance", "X2", "unsupported_market"],
    ] as const) {
      expect(resolvePinnacle17CurrentOdds({ event, markets: [market], esporte: "Soccer", mercado, selecao, observedAt, now: observedAt }))
        .toEqual({ ok: false, reason });
    }
    expect(resolvePinnacle17CurrentOdds({ event, markets: [{ ...market, isLive: true }], esporte: "Soccer", mercado: bet.mercado, selecao: bet.selecao, observedAt, now: observedAt }))
      .toEqual({ ok: false, reason: "market_not_listed" });
    expect(resolvePinnacle17CurrentOdds({ event, markets: [{ ...market, line: 0, outcomes: market.outcomes.map(o => ({ ...o, line: 0 })) }],
      esporte: "Soccer", mercado: "Draw No Bet", selecao: "CSD Rangers", observedAt, now: observedAt }))
      .toMatchObject({ ok: true, value: { reference: { outcome: "away", line: "0" } } });
    for (const [homeScore, awayScore, status] of [[0, 0, "WON"], [0, 1, "WON"], [1, 0, "LOST"]] as const) {
      expect(resolveResultFromScore({ ...bet, esporte: "Soccer", homeScore, awayScore })).toMatchObject({ ok: true, status });
    }
    expect(pinnacleizeSelecao({ evento: bet.evento, mercadoPinnacle: "Double Chance", selecao: bet.selecao })).toBe(bet.selecao);
  });
});


it("1X2 de futebol com marcador DC continua equivalente nos 90 minutos", () => {
  expect(canonicalDoubleChanceSelection({ ...input, mercado: "1X2", selecao: "talca DC" }))
    .toEqual({ mercado: "Double Chance", selecao: "X2" });
});

it.each(["Tennis", "Tênis", "Table Tennis", "Tênis de mesa", "Unknown"])("DNB em %s não vira handicap de outra regra no registro", async esporte => {
  const bet = { evento: "Alpha vs Beta", esporte, pais: "", competicao: "", mercado: "Draw No Bet", selecao: "Alpha" };
  expect(await canonicalizeBetForRegistration(bet)).toMatchObject({ mercado: bet.mercado, selecao: bet.selecao });
});
