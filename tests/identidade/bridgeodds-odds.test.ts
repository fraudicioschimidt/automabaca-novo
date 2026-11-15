import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerCoversBet } from "@/src/providers/coverage";
import { resolveBridgeOddsForBet } from "@/src/providers/bridgeodds/odds";
import { BRIDGEODDS_CURRENT_PRICE_MAX_AGE_MS } from "@/src/providers/bridgeodds/limits";
import { parseBridgeLeague, type BridgeMatch, type BridgeQueryPage } from "@/src/providers/bridgeodds/types";

/** Fixtures REAIS capturados da API BridgeOdds. */
const page = JSON.parse(
  readFileSync(new URL("../fixtures/bridgeodds/connecticut-match.json", import.meta.url), "utf8"),
) as BridgeQueryPage;
const connecticut = page.results.find((m) => m.away === "Vermont Green")!;

describe("resolveBridgeOddsForBet (fixture real)", () => {
  it.each(["Over 2.5 1st Half", "Under 2.5 Q1", "Over 2.5 pontos"])("não apaga qualificador da seleção: %s", selecao => {
    expect(resolveBridgeOddsForBet(connecticut, { mercado: "Total", selecao }))
      .toEqual({ ok: false, reason: "unsupported_market" });
  });
  it.each(["Money Line – Regulation Time", "Handicap – Regulation Time", "Total – Regulation Time"])(
    "tempo regulamentar não tem par no Bridge, que cota o jogo com prorrogação: %s",
    (mercado) => {
      expect(resolveBridgeOddsForBet(connecticut, { mercado, selecao: connecticut.home }))
        .toEqual({ ok: false, reason: "unsupported_market" });
    },
  );

  it("aceita a borda de frescor e recusa preço BridgeOdds acima de 15 minutos", () => {
    const observedAt = new Date("2026-08-26T12:00:00Z");
    const atBoundary = resolveBridgeOddsForBet(
      connecticut,
      { mercado: "Moneyline", selecao: connecticut.home },
      { observedAt, now: new Date(observedAt.getTime() + BRIDGEODDS_CURRENT_PRICE_MAX_AGE_MS) },
    );
    const stale = resolveBridgeOddsForBet(
      connecticut,
      { mercado: "Moneyline", selecao: connecticut.home },
      { observedAt, now: new Date(observedAt.getTime() + BRIDGEODDS_CURRENT_PRICE_MAX_AGE_MS + 1) },
    );
    expect(atBoundary.ok).toBe(true);
    expect(stale).toEqual({ ok: false, reason: "stale_price" });
  });

  it("Total Under 4.75 (a aposta real do Big Data): quarter line via componentes ou direta", () => {
    const result = resolveBridgeOddsForBet(connecticut, {
      mercado: "Total",
      selecao: "Under 4.75",
    });
    // O fixture tem 7 linhas de total; 4.75 resolve direto ou por 4.5+5.0.
    if (result.ok) {
      const phase = result.odds.current ?? result.odds.opening;
      expect(phase).not.toBeNull();
      expect(phase!.fair).toBeGreaterThan(1);
      expect(phase!.fair).toBeGreaterThan(phase!.raw * 0.95); // fair sem juice ≥ raw devigado
    } else {
      expect(result.reason).toBe("line_mismatch"); // linha fora do book de hoje
    }
  });

  it("quarter sintética não inventa limite da seleção a partir dos componentes", () => {
    const match = structuredClone(connecticut);
    match.total = match.total?.filter((line) => line.hdp_points !== 4.75);
    const lower = match.total?.find((line) => line.hdp_points === 4.5);
    const upper = match.total?.find((line) => line.hdp_points === 5);
    expect(lower?.closing && upper?.closing).toBeTruthy();
    lower!.closing!.max_bet = 80;
    upper!.closing!.max_bet = 120;
    const complete = resolveBridgeOddsForBet(match, {
      mercado: "Total",
      selecao: "Under 4.75",
    });
    expect(complete.ok && complete.odds.current?.maxBet).toBeNull();
    expect(complete.ok && complete.odds.current?.fair).toBeGreaterThan(1);

    delete lower!.closing!.max_bet;
    const missingOne = resolveBridgeOddsForBet(match, {
      mercado: "Total",
      selecao: "Under 4.75",
    });
    expect(missingOne.ok && missingOne.odds.current?.maxBet).toBeNull();
  });

  it("resolve direção de total em português", () => {
    const pt = resolveBridgeOddsForBet(connecticut, {
      mercado: "Total",
      selecao: "Mais de 4.5",
    });
    const en = resolveBridgeOddsForBet(connecticut, {
      mercado: "Total",
      selecao: "Over 4.5",
    });
    expect(pt).toEqual(en);
  });

  it("Moneyline pelo nome do time devolve fair > raw (juice removido)", () => {
    const result = resolveBridgeOddsForBet(connecticut, {
      mercado: "Moneyline",
      selecao: "AC Connecticut",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const phase = result.odds.opening ?? result.odds.current;
    expect(phase!.fair).toBeGreaterThan(phase!.raw);
  });

  it("Moneyline 1X2 aceita os tokens 1, X e 2", () => {
    expect(resolveBridgeOddsForBet(connecticut, { mercado: "1X2", selecao: "1" }))
      .toEqual(resolveBridgeOddsForBet(connecticut, { mercado: "1X2", selecao: connecticut.home }));
    expect(resolveBridgeOddsForBet(connecticut, { mercado: "1X2", selecao: "X" }))
      .toEqual(resolveBridgeOddsForBet(connecticut, { mercado: "1X2", selecao: "Draw" }));
    expect(resolveBridgeOddsForBet(connecticut, { mercado: "1X2", selecao: "2" }))
      .toEqual(resolveBridgeOddsForBet(connecticut, { mercado: "1X2", selecao: connecticut.away }));
  });

  it("Moneyline com DNB na seleção usa a linha AH 0.0", () => {
    const canonical = resolveBridgeOddsForBet(connecticut, {
      mercado: "Draw No Bet",
      selecao: connecticut.home,
    });
    const generic = resolveBridgeOddsForBet(connecticut, {
      mercado: "Moneyline",
      selecao: `${connecticut.home} DNB`,
    });
    expect(generic).toEqual(canonical);
  });

  it("mercado fora do contrato e linha inexistente recusam com motivo", () => {
    expect(
      resolveBridgeOddsForBet(connecticut, { mercado: "Corners", selecao: "Over 9.5" }),
    ).toEqual({ ok: false, reason: "unsupported_market" });
    expect(
      resolveBridgeOddsForBet(connecticut, { mercado: "Total", selecao: "Under 99.5" }),
    ).toEqual({ ok: false, reason: "line_mismatch" });
    expect(
      resolveBridgeOddsForBet(connecticut, { mercado: "H1 Total", selecao: "Under 4.5" }),
    ).toEqual({ ok: false, reason: "unsupported_market" });
    expect(
      resolveBridgeOddsForBet(connecticut, { mercado: "Total Hits", selecao: "Under 9.5" }),
    ).toEqual({ ok: false, reason: "unsupported_market" });
    expect(
      resolveBridgeOddsForBet(connecticut, {
        mercado: "Draw No Bet (Corners)",
        selecao: connecticut.home,
      }),
    ).toEqual({ ok: false, reason: "unsupported_market" });
    expect(
      resolveBridgeOddsForBet(connecticut, {
        mercado: "Double Chance (Bookings)",
        selecao: `${connecticut.home} or Draw`,
      }),
    ).toEqual({ ok: false, reason: "unsupported_market" });
  });
});

describe("parseBridgeLeague", () => {
  it("separa país e competição", () => {
    expect(parseBridgeLeague("USA - USL League 2")).toEqual({
      pais: "USA",
      competicao: "USL League 2",
    });
    expect(parseBridgeLeague("Copa Libertadores")).toEqual({
      pais: "",
      competicao: "Copa Libertadores",
    });
  });
});

describe("devig em 3-way real (sanidade matemática)", () => {
  it("probabilidades do moneyline somam ~1 após devig", () => {
    const m: BridgeMatch = connecticut;
    const ml = m.moneyline?.opening ?? m.moneyline?.closing;
    if (!ml?.draw) return; // fixture sem 3-way completo
    const home = resolveBridgeOddsForBet(m, { mercado: "Moneyline", selecao: m.home });
    const away = resolveBridgeOddsForBet(m, { mercado: "Moneyline", selecao: m.away });
    const draw = resolveBridgeOddsForBet(m, { mercado: "Moneyline", selecao: "Draw" });
    if (home.ok && away.ok && draw.ok) {
      const phase = (r: typeof home) =>
        r.ok ? (r.odds.opening ?? r.odds.current)! : null;
      const sum =
        1 / phase(home)!.fair + 1 / phase(away)!.fair + 1 / phase(draw)!.fair;
      expect(sum).toBeCloseTo(1, 6);
    }
  });
});

describe("resolveBridgeOddsForBet: linha de quarto sintética", () => {
  // Books sem margem (o devig power devolve as próprias odds) montados da
  // distribuição de gols do teste de `combineQuarterLineOdds`.
  const twoWay = (w: number, l: number) => ({ home: 1 + l / w, away: 1 + w / l });
  const match: BridgeMatch = {
    ...structuredClone(connecticut),
    spread: [
      { hdp_points: 0, closing: twoWay(0.45, 0.28) },
      { hdp_points: -0.5, closing: twoWay(0.45, 0.55) },
      { hdp_points: -1, closing: twoWay(0.2, 0.55) },
    ],
    total: [
      { hdp_points: 2, closing: { over: 1 + 0.25 / 0.5, under: 1 + 0.5 / 0.25 } },
      { hdp_points: 2.5, closing: { over: 2, under: 2 } },
    ],
  };
  const fairOf = (selecao: string, mercado = "Handicap – Match") => {
    const result = resolveBridgeOddsForBet(match, { mercado, selecao });
    return result.ok ? result.odds.current?.fair : result.reason;
  };

  it("casa −0,25, casa −0,75 e fora +0,25 com a justa exata", () => {
    expect(fairOf(`${match.home} -0.25`)).toBeCloseTo(1 + (0.28 + 0.55) / (0.45 + 0.45), 9);
    expect(fairOf(`${match.home} -0.75`)).toBeCloseTo(1 + (0.55 + 0.55) / (0.45 + 0.2), 9);
    expect(fairOf(`${match.away} +0.25`)).toBeCloseTo(1 + (0.45 + 0.45) / (0.28 + 0.55), 9);
  });

  it("over e under 2,25 com a justa exata", () => {
    expect(fairOf("Over 2.25", "Total")).toBeCloseTo(1.75, 9);
    expect(fairOf("Under 2.25", "Total")).toBeCloseTo(7 / 3, 9);
  });
});

describe("resolveBridgeOddsForBet: moneyline sem a chave draw", () => {
  const withMoneyline = (sport: string, moneyline: BridgeMatch["moneyline"]): BridgeMatch =>
    ({ ...structuredClone(connecticut), sport, moneyline });
  const mandante = (match: BridgeMatch) =>
    resolveBridgeOddsForBet(match, { mercado: "Money Line – Match", selecao: match.home });

  it("no futebol, a fase sem empate não vira livro 2-way com justa inventada", () => {
    // 1,184 + 15,12 passa no piso de soma do livro; como 2-way a justa do
    // mandante sairia 1,078, abaixo da própria odd bruta.
    expect(mandante(withMoneyline("Futebol", { closing: { home: 1.184, away: 15.12 } })))
      .toEqual({ ok: false, reason: "no_prices" });
  });

  it("no futebol, a abertura 3-way completa vale mesmo com o fechamento sem empate", () => {
    const result = mandante(withMoneyline("Futebol", {
      opening: { home: 1.184, draw: 6.67, away: 15.12 },
      closing: { home: 1.184, away: 15.12 },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.odds.current).toBeNull();
    expect(result.odds.opening?.fair).toBeCloseTo(1.2238, 3);
  });

  it("no basquete, sem empate, continua 2-way", () => {
    const result = mandante(withMoneyline("Basquete", { closing: { home: 1.5, away: 2.7 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.odds.current?.raw).toBe(1.5);
    expect(result.odds.current?.fair).toBeGreaterThan(1.5);
  });
});


describe("BridgeOdds: entrada e fechamento no mesmo escopo", () => {
  it.each(["Including OT", "Incluindo Prorrogação", "Com Prorrogação"])("futebol %s não usa o livro dos 90 minutos", rule => {
    for (const bet of [
      { mercado: `Total – ${rule}`, selecao: "Over 4.5" },
      { mercado: `Draw No Bet – ${rule}`, selecao: connecticut.home },
      { mercado: "Total", selecao: `Over 4.5 – ${rule}` },
    ]) {
      expect(providerCoversBet("bridgeodds", { ...bet, esporte: "Soccer" })).toBe(false);
      expect(resolveBridgeOddsForBet(connecticut, bet)).toEqual({ ok: false, reason: "unsupported_market" });
    }
  });

  it.each(["Tempo Regular", "Tempo Normal", "Regulamentar", "Regular Time", "(TR)", "1X2", "3-way"])("basquete %s não usa o livro com OT", rule => {
    const match = { ...structuredClone(connecticut), sport: "Basquete", moneyline: { closing: { home: 1.5, away: 2.7 } } };
    for (const bet of [
      { mercado: `Moneyline – ${rule}`, selecao: match.home },
      { mercado: "Moneyline", selecao: `${match.home} – ${rule}` },
    ]) {
      expect(providerCoversBet("bridgeodds", { ...bet, esporte: "Basketball" })).toBe(false);
      expect(resolveBridgeOddsForBet(match, bet)).toEqual({ ok: false, reason: "unsupported_market" });
    }
  });

  it("basquete incluindo OT continua usando o livro completo", () => {
    const match = { ...structuredClone(connecticut), sport: "Basquete", moneyline: { closing: { home: 1.5, away: 2.7 } } };
    const bet = { mercado: "Moneyline – Including OT", selecao: match.home };
    expect(providerCoversBet("bridgeodds", { ...bet, esporte: "Basketball" })).toBe(true);
    expect(resolveBridgeOddsForBet(match, bet).ok).toBe(true);
  });
});
