import { describe, expect, it } from "vitest";
import { computeLiquidezV1 } from "@/src/domain/analyzer/liquidez";
import { computePeriodoV1 } from "@/src/domain/analyzer/periodo";
import { computeSteamV1 } from "@/src/domain/analyzer/steam";
import { computeTimingV1 } from "@/src/domain/analyzer/timing";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import type { BetRowData } from "@/src/domain/bet-read-model";

/**
 * Asserções de VALOR diretas sobre o bucketing do analyzer. O golden de
 * FIDELIDADE do shim (tested-analyzer.test.ts) não pega um limiar ou sinal de
 * bucket invertido (steam vs reverse, o gate "provisório não vaza"): ficaria
 * VERDE e a leitura de decisão de canal enganaria. Aqui cravamos os cortes
 * exatos e os guards. Pura (sem DB). Cada valor é derivado passo-a-passo no
 * comentário ao lado.
 */

// Fixture mínima fiel ao BetRowData (espelha betRow de analyzer-decisao.test.ts).
function betRow(p: Partial<BetRowData> = {}): BetRowData {
  const data = p.data ?? new Date("2026-06-15T19:00:00Z");
  return {
    id: "b",
    data,
    settledAt: p.status === "PENDING" ? null : (p.settledAt ?? data),
    evento: "Time A x Time B",
    competicao: "",
    pais: "",
    esporte: "futebol",
    mercado: "Total",
    selecao: "Over 2.5",
    casaDeAposta: "",
    tipster: "",
    odds: 1.9,
    stake: 1,
    status: "WON",
    lucro: 0.9,
    closingOdd: null,
    closingMaxBet: null,
    openingMaxBet: null,
    closingMaxBetCurrency: "USD",
    openingMaxBetCurrency: "USD",
    openingOdd: null,
    openingRawOdd: null,
    closingRawOdd: null,
    registradoEm: new Date("2026-06-15T15:00:00Z"),
    clv: null,
    clvReliable: null,
    closingFetchedAt: new Date("2026-06-15T19:00:00Z"), // default = fechamento CONGELADO
    identityStatus: null,
    noOddsReason: null,
    closingNoOddsReason: null,
    source: "web",
    sourceExternalId: null,
    contaTitular: null,
    ...p,
  };
}

// ─────────────────────────── STEAM (steam.ts) ───────────────────────────
// deltaPct(minha, ref) = (minha/ref − 1)*100. Cortes (steam.ts L62-65):
//   steam   = delta ≥ 2
//   reverse = delta < 0
//   neutro  = 0 ≤ delta < 2
describe("computeSteamV1 — classificação steam/neutro/reverse no limiar exato", () => {
  it("delta ≥ +2% → steam; 0..2% → neutro; < 0% → reverse (uma de cada)", () => {
    // openingRawOdd=2.0 em todas. Odds escolhidas pelos deltas:
    //   2.04 → +2.0% (≥2)   → steam
    //   2.03 → +1.5% (0..2) → neutro
    //   2.0  →  0.0% (0..2) → neutro (fronteira inferior do neutro)
    //   1.98 → −1.0% (<0)   → reverse
    const bets = [
      betRow({ id: "steam", odds: 2.04, openingRawOdd: 2.0 }),
      betRow({ id: "neutro1", odds: 2.03, openingRawOdd: 2.0 }),
      betRow({ id: "neutroZero", odds: 2.0, openingRawOdd: 2.0 }),
      betRow({ id: "reverse", odds: 1.98, openingRawOdd: 2.0 }),
    ];
    const s = computeSteamV1(bets);
    expect(s.withOpening).toBe(4);
    expect(s.steam.bets).toBe(1); // só a 2.04
    expect(s.noSteam.bets).toBe(2); // 2.03 e 2.00
    expect(s.reverseLine.bets).toBe(1); // só a 1.98
  });

  it("fronteira +2%: delta exatamente 2.0% conta como STEAM, não neutro", () => {
    // 2.04/2.0 = 1.02 → delta 2.0 (com ε de ponto flutuante = 2.0000000000000018,
    // ainda ≥ 2). Se o corte virasse `> 2`, esta bet cairia em neutro.
    const s = computeSteamV1([betRow({ odds: 2.04, openingRawOdd: 2.0 })]);
    expect(s.steam.bets).toBe(1);
    expect(s.noSteam.bets).toBe(0);
  });

  it.each([
    [5.1, "steam", "+2 a +5%"],
    [4.9, "reverseLine", "−2 a 0%"],
    [4.75, "reverseLine", "−5 a −2%"],
    [5.25, "steam", "≥ +5%"],
  ] as const)("odd %s contra 5 respeita a fronteira decimal em abertura e fechamento", (odds, group, label) => {
    const result = computeSteamV1([betRow({ odds, openingRawOdd: 5, closingRawOdd: 5, closingOdd: 5 })]);
    expect(result[group].bets).toBe(1);
    expect(result.openingDeltaDist.find((bucket) => bucket.count === 1)?.label).toBe(label);
    expect(result.closingDeltaDist.find((bucket) => bucket.count === 1)?.label).toBe(label);
  });

  it("a fronteira de +2% também vale para odds baixas", () => {
    const result = computeSteamV1([betRow({ odds: 1.1883, openingRawOdd: 1.165 })]);
    expect(result.steam.bets).toBe(1);
    expect(result.noSteam.bets).toBe(0);
  });

  it("não arredonda uma odd vizinha para a fronteira de 2%", () => {
    const result = computeSteamV1([betRow({ odds: 5.0999, openingRawOdd: 5 })]);
    expect(result.noSteam.bets).toBe(1);
    expect(result.steam.bets).toBe(0);
  });

  it("fronteira 0%: delta exatamente 0 é neutro, NÃO reverse (reverse é < 0)", () => {
    const s = computeSteamV1([betRow({ odds: 2.0, openingRawOdd: 2.0 })]);
    expect(s.noSteam.bets).toBe(1);
    expect(s.reverseLine.bets).toBe(0);
  });

  it("openingRawOdd null → fica fora de withOpening e de toda classificação", () => {
    const s = computeSteamV1([betRow({ odds: 2.04, openingRawOdd: null })]);
    expect(s.withOpening).toBe(0);
    expect(s.steam.bets).toBe(0);
    expect(s.reverseLine.bets).toBe(0);
  });

  it("odds brutas inválidas não contam como cobertura nem trajetória", () => {
    const s = computeSteamV1([
      betRow({ id: "zero", openingRawOdd: 0, closingRawOdd: 0 }),
      betRow({ id: "one", openingRawOdd: 1, closingRawOdd: 1 }),
    ]);
    expect(s.withOpening).toBe(0);
    expect(s.withClosing).toBe(0);
    expect(s.avgOpeningToEntry).toBeNull();
    expect(s.avgEntryToClosing).toBeNull();
    expect(s.pricePaths).toHaveLength(0);
  });
});

describe("computeSteamV1 — guard 'provisório não vaza' (closingFetchedAt)", () => {
  it("closing com fetchedAt=null NÃO entra em withClosing nem em avgEntryToClosing", () => {
    // steam.ts L53: comFechamento exige closingRawOdd != null E closingFetchedAt != null.
    // Bet com closing provisório (raw presente, fetchedAt null) é ignorada na trilha de
    // fechamento — senão a média entrada→fechamento seria poluída pela linha móvel.
    const provisoria = betRow({
      odds: 2.0,
      closingRawOdd: 1.8, // delta entrada→fechamento existiria (−10%)
      closingFetchedAt: null, // mas provisório
    });
    const s = computeSteamV1([provisoria]);
    expect(s.withClosing).toBe(0);
    expect(s.avgEntryToClosing).toBeNull(); // nenhuma amostra de fechamento congelado
  });

  it("closing CONGELADO (fetchedAt set) entra; média entrada→fechamento é o delta", () => {
    // odds=2.0, closingRawOdd=2.2, congelado → delta = (2.0/2.2 − 1)*100 = −9.0909…%
    const congelada = betRow({
      odds: 2.0,
      closingRawOdd: 2.2,
      closingFetchedAt: new Date("2026-06-15T19:00:00Z"),
    });
    const s = computeSteamV1([congelada]);
    expect(s.withClosing).toBe(1);
    expect(s.avgEntryToClosing).toBeCloseTo((2.0 / 2.2 - 1) * 100, 6); // ≈ −9.0909
  });

  it("pricePaths: closing provisório vira null; congelado mostra o raw", () => {
    // steam.ts L85: closing exibido só se closingFetchedAt != null.
    const provisoria = betRow({
      id: "prov",
      openingRawOdd: 2.0,
      odds: 1.95,
      closingRawOdd: 1.85,
      closingFetchedAt: null,
    });
    const congelada = betRow({
      id: "cong",
      openingRawOdd: 2.0,
      odds: 1.95,
      closingRawOdd: 1.85,
      closingFetchedAt: new Date("2026-06-15T19:00:00Z"),
    });
    const paths = computeSteamV1([provisoria, congelada]).pricePaths;
    const provPath = paths.find((p) => p.opening === 2.0 && p.taken === 1.95 && p.closing === null);
    const congPath = paths.find((p) => p.closing === 1.85);
    expect(provPath).toBeDefined(); // provisória: closing null (provisório não vaza)
    expect(congPath).toBeDefined(); // congelada: closing 1.85
  });
});

// ─────────────────────────── TIMING (timing.ts) ───────────────────────────
// horas = (data − registradoEm)/3_600_000. JANELAS (timing.ts L27-35):
//   0–1h [0,1) · 1–3h [1,3) · 3–6h [3,6) · 6–12h · 12–24h · 24–48h · ≥48h
describe("computeTimingV1 — janela de antecedência no corte exato", () => {
  it("4h cai em '3–6h'; 0.5h em '0–1h'; 1h em '1–3h' (fronteira ≥1)", () => {
    const reg = (date: string, dt: string) =>
      betRow({ data: new Date(date), registradoEm: new Date(dt) });
    const bets = [
      // 19:00 − 15:00 = 4h → 3–6h
      reg("2026-06-15T19:00:00Z", "2026-06-15T15:00:00Z"),
      // 19:00 − 18:30 = 0.5h → 0–1h
      reg("2026-06-15T19:00:00Z", "2026-06-15T18:30:00Z"),
      // 19:00 − 18:00 = 1h → 1–3h (corte inferior do bucket, h ≥ 1)
      reg("2026-06-15T19:00:00Z", "2026-06-15T18:00:00Z"),
    ];
    const t = computeTimingV1(bets);
    const get = (label: string) => t.byAntecedencia.find((b) => b.label === label);
    expect(get("3–6h")?.bets).toBe(1);
    expect(get("0–1h")?.bets).toBe(1);
    expect(get("1–3h")?.bets).toBe(1);
    expect(get("6–12h")).toBeUndefined(); // bucket vazio é filtrado
    // média de antecedência = (4 + 0.5 + 1)/3 = 1.8333…h
    expect(t.avgAntecedenciaHours).toBeCloseTo((4 + 0.5 + 1) / 3, 6);
  });

  it("registro DEPOIS do kickoff entra no bucket explícito", () => {
    // data 15:00, registradoEm 19:00 → −4h → Pós-kickoff, sem esconder o dado ruim.
    const t = computeTimingV1([
      betRow({ data: new Date("2026-06-15T15:00:00Z"), registradoEm: new Date("2026-06-15T19:00:00Z") }),
    ]);
    expect(t.coveragePct).toBe(100);
    expect(t.avgAntecedenciaHours).toBe(-4);
    expect(t.byAntecedencia).toHaveLength(1);
    expect(t.byAntecedencia[0]).toMatchObject({ label: "Pós-kickoff", bets: 1 });
  });

  it("kickoff inferido fica fora da cobertura temporal", () => {
    const t = computeTimingV1([
      betRow({
        data: new Date("2026-06-16T03:00:00Z"),
        registradoEm: new Date("2026-06-15T15:00:00Z"),
        kickoffInferido: true,
      }),
    ]);
    expect(t.coveredBets).toBe(0);
    expect(t.coveragePct).toBe(0);
    expect(t.byAntecedencia).toEqual([]);
  });

  it("heatmap: registro 15:00 UTC = 12:00 SP numa segunda → dow 1, slot 3", () => {
    // utcToSpParts(15:00Z) = 12:00 SP; getUTCHours 12 → slot floor(12/4)=3.
    // 2026-06-15 é segunda → getUTCDay 1. Heatmap tem 7×6 = 42 células sempre.
    const t = computeTimingV1([betRow({ registradoEm: new Date("2026-06-15T15:00:00Z") })]);
    expect(t.heatmap).toHaveLength(42);
    const cell = t.heatmap.find((c) => c.dow === 1 && c.slot === 3);
    expect(cell?.count).toBe(1);
    // nenhuma outra célula tem contagem
    expect(t.heatmap.filter((c) => c.count > 0)).toHaveLength(1);
  });

  it("não considera pendente como segunda resolvida ao escolher melhor janela", () => {
    const bets = [
      betRow({ id: "final", status: "WON", lucro: 1 }),
      betRow({ id: "pending", status: "PENDING", lucro: 0 }),
    ];
    const timing = computeTimingV1(bets);
    expect(timing.byAntecedencia[0]?.bets).toBe(2);
    expect(timing.byAntecedencia[0]?.resolvedBets).toBe(1);
    expect(timing.bestWindow).toBeNull();
  });

  it("não chama de ROI+CLV uma melhor janela sem qualquer CLV medido", () => {
    const timing = computeTimingV1([
      betRow({ id: "won", status: "WON", lucro: 1, clv: null, clvReliable: null }),
      betRow({ id: "lost", status: "LOST", lucro: -1, clv: null, clvReliable: null }),
    ]);
    expect(timing.byAntecedencia[0]?.resolvedBets).toBe(2);
    expect(timing.byAntecedencia[0]?.avgClv).toBeNull();
    expect(timing.bestWindow).toBeNull();
    expect(timing.worstWindow).toBeNull();
  });

  it("não mistura ROI resolvido com CLV pertencente apenas a aposta pendente", () => {
    const timing = computeTimingV1([
      betRow({ id: "won", status: "WON", lucro: 1, clv: null, clvReliable: null }),
      betRow({ id: "lost", status: "LOST", lucro: -1, clv: null, clvReliable: null }),
      betRow({ id: "pending-clv", status: "PENDING", lucro: 0, clv: 20, clvReliable: true }),
    ]);
    expect(timing.byAntecedencia[0]?.avgClv).toBe(20);
    expect(timing.bestWindow).toBeNull();
  });

  it("compara ROI e CLV na mesma amostra de resolvidas com fechamento", () => {
    const timing = computeTimingV1([
      betRow({ id: "won", status: "WON", lucro: 1, clv: 4, clvReliable: true }),
      betRow({ id: "lost", status: "LOST", lucro: -0.5, clv: 2, clvReliable: true }),
    ]);
    expect(timing.bestWindow).toMatchObject({
      label: "3–6h",
      resolvedBets: 2,
      avgClv: 3,
    });
    expect(timing.bestWindow?.roi).toBeCloseTo(25, 8);
  });
});

// ─────────────────────────── LIQUIDEZ (liquidez.ts) ───────────────────────────
// FAIXAS (L27-33): <$500 · $500–2k · $2k–5k · $5k–20k · ≥$20k.
// Momentum (L58-62): razao = closingMaxBet/openingMaxBet; ≥1.15 crescendo · ≤0.85 secando · senão estável.
describe("computeLiquidezV1 — bucket de liquidez e momentum no limiar", () => {
  it("closingMaxBet=3000 cai em '$2k–5k'", () => {
    const l = computeLiquidezV1([betRow({ closingMaxBet: 3000 })]);
    const bucket = l.byClosingLiq.find((b) => b.label === "$2k–5k");
    expect(bucket?.bets).toBe(1);
    // os demais buckets vazios são filtrados (.filter bets > 0)
    expect(l.byClosingLiq).toHaveLength(1);
    expect(l.totalWithClosingLiq).toBe(1);
  });

  it("razão exatamente 1.15 → crescendo; 0.85 → secando; 1.0 → estável", () => {
    // crescendo: closing/opening = 1150/1000 = 1.15 (≥1.15)
    // secando:   850/1000 = 0.85 (≤0.85)
    // estavel:   1000/1000 = 1.0
    const bets = [
      betRow({ id: "cresc", openingMaxBet: 1000, closingMaxBet: 1150 }),
      betRow({ id: "seca", openingMaxBet: 1000, closingMaxBet: 850 }),
      betRow({ id: "estavel", openingMaxBet: 1000, closingMaxBet: 1000 }),
    ];
    const l = computeLiquidezV1(bets);
    const mom = (key: string) => l.momentum.find((m) => m.key === key);
    expect(mom("crescendo")?.bets).toBe(1);
    expect(mom("secando")?.bets).toBe(1);
    expect(mom("estavel")?.bets).toBe(1);
  });

  it("momentum só conta bets com AMBAS as liquidezes (abertura e fechamento)", () => {
    // sem openingMaxBet → fora de comAmbas. momentum total = 0.
    const l = computeLiquidezV1([betRow({ openingMaxBet: null, closingMaxBet: 1500 })]);
    expect(l.momentum.reduce((s, m) => s + m.bets, 0)).toBe(0);
  });

  it("ignora liquidez zero/não-finita e exige duas resolvidas para melhor faixa", () => {
    const l = computeLiquidezV1([
      betRow({ id: "zero", openingMaxBet: 0, closingMaxBet: 0 }),
      betRow({ id: "final", closingMaxBet: 3000, status: "WON", lucro: 1 }),
      betRow({ id: "pending", closingMaxBet: 3000, status: "PENDING", lucro: 0 }),
    ]);
    expect(l.totalWithOpeningLiq).toBe(0);
    expect(l.totalWithClosingLiq).toBe(2);
    expect(l.byClosingLiq[0]?.resolvedBets).toBe(1);
    expect(l.bestBucket).toBeNull();
  });

  it("liquidez de fechamento só conta com o fechamento confirmado", () => {
    const l = computeLiquidezV1([
      betRow({ id: "confirmado", openingMaxBet: 500, closingMaxBet: 1000 }),
      betRow({ id: "provisorio", openingMaxBet: 600, closingMaxBet: 5000, closingFetchedAt: null }),
    ]);

    expect(l.totalWithOpeningLiq).toBe(2);
    expect(l.totalWithClosingLiq).toBe(1);
    expect(l.avgClosingLiq).toBe(1000);
    expect(l.byClosingLiq.flatMap((bucket) => bucket.membros).map((bet) => bet.id))
      .toEqual(["confirmado"]);
    expect(l.momentum.flatMap((row) => row.membros).map((bet) => bet.id))
      .toEqual(["confirmado"]);
  });
});

describe("computePeriodoV1 — agregação mensal/semanal e acumulado", () => {
  it("agrupa por mês SP, soma lucro por mês e acumula corretamente", () => {
    // Jan/26: duas WON, lucro 10 + 5 = 15. Fev/26: uma LOST, lucro −4.
    // Datas ao meio-dia UTC → mesmo dia em SP (sem virada de mês).
    const bets = [
      betRow({ status: "WON", stake: 100, lucro: 10, data: new Date("2026-01-15T15:00:00Z") }),
      betRow({ status: "WON", stake: 100, lucro: 5, data: new Date("2026-01-20T15:00:00Z") }),
      betRow({ status: "LOST", stake: 100, lucro: -4, data: new Date("2026-02-10T15:00:00Z") }),
    ];
    const p = computePeriodoV1(bets);
    expect(p.monthly).toHaveLength(2);
    const jan = p.monthly.find((m) => m.label === "Jan/26");
    const fev = p.monthly.find((m) => m.label === "Fev/26");
    expect(jan?.lucro).toBeCloseTo(15, 6);
    expect(fev?.lucro).toBeCloseTo(-4, 6);
    // acumulado: Jan = 15, Fev = 15 + (−4) = 11 (ordem cronológica)
    expect(jan?.cumLucro).toBeCloseTo(15, 6);
    expect(fev?.cumLucro).toBeCloseTo(11, 6);
    // totalLucro = soma dos meses = 11
    expect(p.totalLucro).toBeCloseTo(11, 6);
    // melhor mês = Jan (+15); pior = Fev (−4)
    expect(p.bestMonth?.label).toBe("Jan/26");
    expect(p.worstMonth?.label).toBe("Fev/26");
  });

  it("daily90 ignora PENDING; agrega lucro por dia SP", () => {
    // duas resolvidas no mesmo dia SP (2026-01-15) + uma PENDING (não entra).
    const bets = [
      betRow({ status: "WON", lucro: 3, data: new Date("2026-01-15T15:00:00Z") }),
      betRow({ status: "LOST", lucro: -1, data: new Date("2026-01-15T18:00:00Z") }),
      betRow({ status: "PENDING", lucro: 0, data: new Date("2026-01-15T20:00:00Z") }),
    ];
    const p = computePeriodoV1(bets);
    expect(p.daily90).toHaveLength(1);
    expect(p.daily90[0]?.dayKey).toBe("2026-01-15");
    expect(p.daily90[0]?.lucro).toBeCloseTo(2, 6); // 3 + (−1)
  });

  it("o lucro cai no dia, na semana e no mês do jogo, não nos da liquidação", () => {
    // Sábado 31/01, liquidada na segunda 02/02: outro dia, outra semana e outro mês.
    const atrasada = betRow({
      data: new Date("2026-01-31T15:00:00Z"),
      settledAt: new Date("2026-02-02T15:00:00Z"),
      lucro: 2,
    });
    // O inverso: jogo em fevereiro com a liquidação gravada antes dele.
    const adiantada = betRow({
      data: new Date("2026-02-03T15:00:00Z"),
      settledAt: new Date("2026-01-30T15:00:00Z"),
      lucro: 5,
    });
    const p = computePeriodoV1([adiantada, atrasada]);
    expect(p.monthly.map((m) => [m.label, m.lucro])).toEqual([["Jan/26", 2], ["Fev/26", 5]]);
    expect(p.weekly.map((w) => w.lucro)).toEqual([2, 5]);
    expect(p.daily90).toEqual([{ dayKey: "2026-01-31", lucro: 2 }, { dayKey: "2026-02-03", lucro: 5 }]);
  });

  it("daily90 usa 90 dias corridos, não 90 dias com apostas", () => {
    const p = computePeriodoV1([
      betRow({ id: "antiga", lucro: 10, data: new Date("2025-01-01T15:00:00Z") }),
      betRow({ id: "limite", lucro: 2, data: new Date("2026-04-17T15:00:00Z") }),
      betRow({ id: "recente", lucro: 3, data: new Date("2026-07-15T15:00:00Z") }),
    ]);

    expect(p.daily90.map((d) => d.dayKey)).toEqual(["2026-04-17", "2026-07-15"]);
  });

  it("preserva as seis casas de lucro no diário e no acumulado", () => {
    const p = computePeriodoV1([
      betRow({ id: "micro-1", lucro: 0.000004, data: new Date("2026-01-15T15:00:00Z") }),
      betRow({ id: "micro-2", lucro: 0.000004, data: new Date("2026-01-15T16:00:00Z") }),
    ]);
    expect(p.daily90[0]?.lucro).toBe(0.000008);
    expect(p.monthly[0]?.cumLucro).toBe(0.000008);
    expect(p.totalLucro).toBe(0.000008);
  });

  it("VOID não cria ponto diário nem vira melhor/pior mês financeiro", () => {
    const p = computePeriodoV1([
      betRow({ status: "VOID", stake: 20, lucro: 0, data: new Date("2026-01-15T15:00:00Z") }),
      betRow({ status: "LOST", stake: 1, lucro: -1, data: new Date("2026-02-15T15:00:00Z") }),
    ]);
    expect(p.daily90.map((d) => d.dayKey)).toEqual(["2026-02-15"]);
    expect(p.bestMonth?.label).toBe("Fev/26");
    expect(p.worstMonth?.label).toBe("Fev/26");
  });

  it("rótulo semanal usa a chave ISO SP (S03 para 2026-01-15)", () => {
    // spWeekKey(2026-01-15) = 2026-W03 → label "S03".
    const p = computePeriodoV1([betRow({ status: "WON", lucro: 1, data: new Date("2026-01-15T15:00:00Z") })]);
    expect(p.weekly.map((w) => w.label)).toContain("S03");
  });
});

// ─────────────────────────── BAI-1 (shim: steamPct, dAb) ───────────────────────────
// P(): steam = odd tomada pelo menos 2% acima da odd bruta de abertura.
// dAb usa a mesma base, sem misturar fair odd ou fechamento.
describe("testedAnData.P — steamPct e dAb pela abertura bruta", () => {
  it.each([
    [5.1, 5, 1],
    [1.1883, 1.165, 1],
    [5.0999, 5, 0],
  ])("casa e execução concordam no corte de 2%: %s contra %s", (odds, openingRawOdd, above) => {
    const bets = [betRow({ casaDeAposta: "Casa", odds, openingRawOdd })];
    const execution = computeSteamV1(bets);
    const house = testedAnData.P(bets).casas[0]!;
    expect(house.steamN).toBe(above);
    expect(house.steamN).toBe(execution.steam.bets);
    expect(house.dAb).toBeCloseTo(execution.avgOpeningToEntry!, 8);
  });

  it("steamPct usa somente apostas com openingRawOdd válida", () => {
    const bets = [
      betRow({ casaDeAposta: "Pinnacle", odds: 2.04, openingRawOdd: 2 }),
      betRow({ casaDeAposta: "Pinnacle", odds: 2.03, openingRawOdd: 2 }),
      betRow({ casaDeAposta: "Pinnacle", odds: 9, openingRawOdd: 1 }),
    ];
    const p = testedAnData.P(bets);
    expect(p.casas).toHaveLength(1);
    expect(p.casas[0]).toMatchObject({ steamN: 1, steamSamples: 2 });
    expect(p.casas[0]?.steamPct).toBeCloseTo(50, 6);
  });

  it("dAb mede odds tomada / openingRawOdd e exclui referência inválida", () => {
    const bets = [
      betRow({ casaDeAposta: "Casa", odds: 2.1, openingRawOdd: 2 }),
      betRow({ casaDeAposta: "Casa", odds: 1.9, openingRawOdd: 2 }),
      betRow({ casaDeAposta: "Casa", openingRawOdd: 0, odds: 5 }),
    ];
    const p = testedAnData.P(bets);
    expect(p.casas[0]?.dAb).toBeCloseTo(0, 6);
  });
});

describe("testedAnData — contratos matemáticos da interface", () => {
  it.each(["aposta_ao_vivo", "closing_quote_too_early", "kickoff_sem_captura"])(
    "fechamento rejeitado por %s não conta como execução coberta", (closingNoOddsReason) => {
      const bets = [betRow({ closingOdd: 2, closingRawOdd: 1.9, closingNoOddsReason,
        clv: null, clvReliable: false })];
      const execution = testedAnData.S(bets);
      expect(computeSteamV1(bets).withClosing).toBe(0);
      expect(execution.withClose).toHaveLength(0);
      expect(execution.fechamentoCobertura.cobertas).toHaveLength(0);
      expect(execution.fechamentoCobertura[closingNoOddsReason === "aposta_ao_vivo" ? "naoSeAplica" : "faltando"])
        .toHaveLength(1);
      expect(execution.meanEF).toBeNull();
    },
  );

  it("expõe ROI esperado ponderado e gap calculados pelo serviço", () => {
    const d = testedAnData.D([
      betRow({ status: "WON", stake: 100, lucro: 10, clv: 5, clvReliable: true }),
      betRow({ status: "PENDING", stake: 900, lucro: 0, clv: 20, clvReliable: true }),
    ]);
    expect(d.expectedRoi).toBeCloseTo(5, 6);
    expect(d.realizedRoiClv).toBeCloseTo(10, 6);
    expect(d.realizedRoiClvN).toBe(1);
    expect(d.roiClvGap).toBeCloseTo(5, 6);
    expect(d.settled).toHaveLength(1);
    expect(d.pendingBets).toBe(1);
    expect(d.voidBets).toBe(0);
  });

  it("VOID não infla o subtítulo de resolvidas nem o lucro", () => {
    const won = betRow({ id: "w", status: "WON", stake: 100, lucro: 10 });
    const voided = betRow({ id: "v", status: "VOID", stake: 50, lucro: 0 });
    const pending = betRow({ id: "p", status: "PENDING", stake: 20, lucro: 0 });
    const d = testedAnData.D([won, voided]);
    expect(d.settled.map((b) => b.id)).toEqual(["w"]);
    expect(d.lucro).toBe(testedAnData.D([won]).lucro);
    expect(d.settled).toHaveLength(1);
    expect(d.pendingBets).toBe(0);
    expect(d.voidBets).toBe(1);
    const comPendente = testedAnData.D([won, voided, pending]);
    expect(comPendente.settled).toHaveLength(1);
    expect(comPendente.pendingBets).toBe(1);
    expect(comPendente.voidBets).toBe(1);
    expect(comPendente.lucro).toBe(d.lucro);
  });

  it("cobertura de steam usa abertura raw e fechamento congelado", () => {
    const s = testedAnData.S([
      betRow({ openingOdd: 2, openingRawOdd: null }),
      betRow({ closingOdd: 2, closingRawOdd: 1.9, closingFetchedAt: null }),
      betRow({ closingOdd: null, closingRawOdd: 1.8, closingFetchedAt: new Date() }),
    ]);
    expect(s.withOpen).toHaveLength(0);
    expect(s.withClose).toHaveLength(1);
  });

  it("melhor faixa de liquidez vem do bucket calculado, não da primeira faixa", () => {
    const z = testedAnData.Z([
      betRow({ id: "low1", closingMaxBet: 300, status: "LOST", lucro: -1 }),
      betRow({ id: "low2", closingMaxBet: 300, status: "LOST", lucro: -1 }),
      betRow({ id: "high1", closingMaxBet: 3000, status: "WON", lucro: 1 }),
      betRow({ id: "high2", closingMaxBet: 3000, status: "WON", lucro: 1 }),
    ]);
    expect(z.lqClosingRows[0]?.l).toBe("< $500");
    expect(z.lqBest?.l).toBe("$2k–5k");
  });
});
