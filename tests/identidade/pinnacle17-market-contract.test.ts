import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerCoversBet, providerCoversSport } from "@/src/providers/coverage";
import { resolvePinnacle17CurrentOdds } from "@/src/providers/pinnacle17/odds";
import { findPinnacle17Event } from "@/src/providers/pinnacle17/feed";
import { isBaseCategoryFixture } from "@/src/domain/team-category";
import { pinnacle17MarketContract } from "@/src/providers/pinnacle17/market-contract";
import { orientPinnacle17Selection, selectionFollowsEventOrder } from "@/src/providers/pinnacle17/sharp";
import {
  encodePinnacle17PriceReference,
  parsePinnacle17PriceReference,
  normalizePinnacle17Events,
  normalizePinnacle17Markets,
  pinnacle17SportId,
  PINNACLE17_SPORT_IDS,
  type Pinnacle17Event,
  type Pinnacle17Market,
} from "@/src/providers/pinnacle17/types";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";

const fixtures = JSON.parse(readFileSync(join(__dirname, "../fixtures/pinnacle17/multisport-20260908.json"), "utf8")) as Array<{
  event: Pinnacle17Event; observedAt: string; markets: Pinnacle17Market[];
}>;
const cases = fixtures.flatMap(fixture => fixture.markets.flatMap(market => market.outcomes.map(outcome => {
  const side = outcome.designation;
  const team = side === "home" ? fixture.event.homeTeam.name : side === "away" ? fixture.event.awayTeam.name : null;
  const line = outcome.line ?? market.line;
  const selection = market.type === "moneyline" ? team ?? "Draw" : market.type === "spread"
    ? `${team} ${line! >= 0 ? "+" : ""}${line}`
    : `${market.team ? `${market.team} ` : ""}${side === "over" ? "Over" : "Under"} ${line}`;
  return { label: `${fixture.event.sport.name}/${market.name}/${selection}`, fixture, market, outcome, selection };
})));

describe("Pinnacle17: contratos medidos em 13 esportes", () => {
  it.each(cases)("$label", ({ fixture, market, outcome, selection }) => {
    const input = { esporte: fixture.event.sport.name, mercado: market.name, selecao: selection };
    const resolved = resolvePinnacle17CurrentOdds({ ...input, event: fixture.event, markets: fixture.markets,
      observedAt: new Date(fixture.observedAt), now: new Date(fixture.observedAt) });
    if (market.periodName === "Period 3") {
      expect(resolved.ok).toBe(false); // Baseball: unnamed inning scope is not evidence.
      return;
    }
    expect(providerCoversBet("pinnacle17", input)).toBe(true);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.current.raw).toBe(outcome.oddsDecimal);
    expect(resolved.value.reference.period).toBe(market.period);
    expect(resolved.value.reference.unit).toBeTruthy();
    const reference = encodePinnacle17PriceReference(resolved.value.reference);
    expect(reference).toMatch(/^pinnacle17:v2:/);
    expect(parsePinnacle17PriceReference(reference)).toEqual(resolved.value.reference);
  });

  it.each(fixtures)("identidade do catálogo: $event.sport.name / $event.name", fixture => {
    // Jogo de base (Paulista U20) nunca é candidato: as casas brasileiras não o oferecem.
    const base = isBaseCategoryFixture({ home: fixture.event.homeTeam.name, away: fixture.event.awayTeam.name, league: fixture.event.league.name });
    expect(findPinnacle17Event({ events: [fixture.event], home: fixture.event.homeTeam.name,
      away: fixture.event.awayTeam.name, kickoffUtc: new Date(fixture.event.startTime) })?.event.id).toBe(base ? undefined : fixture.event.id);
  });

  it.each(Object.entries(PINNACLE17_SPORT_IDS))("catálogo e roteamento concordam: %s", (sport, id) => {
    expect(pinnacle17SportId(sport)).toBe(id);
    expect(providerCoversSport("pinnacle17", sport)).toBe(true);
    expect(providerCoversBet("pinnacle17", { esporte: sport, mercado: "Moneyline" })).toBe(true);
  });

  it.each([["Tênis", 33], ["Basquete", 4], ["Futebol americano", 15], ["e-sports", 12], ["Rugby League", 26], ["Rugby Union", 27]])("alias esportivo %s", (sport, id) => {
    expect(pinnacle17SportId(String(sport))).toBe(id);
  });
});

const soccer = fixtures.find(f => f.event.sport.id === 29)!;
const total = soccer.markets.find(m => m.type === "total" && m.period === 0)!;
const spread = soccer.markets.find(m => m.type === "spread" && m.period === 0)!;
function resolve(markets: Pinnacle17Market[], patch: Partial<Parameters<typeof resolvePinnacle17CurrentOdds>[0]> = {}) {
  return resolvePinnacle17CurrentOdds({ event: soccer.event, markets, esporte: "Soccer", mercado: "Total", selecao: `Over ${total.line}`,
    observedAt: new Date(soccer.observedAt), now: new Date(soccer.observedAt), ...patch });
}

describe("Pinnacle17: recusa de cotações incompatíveis", () => {
  it.each([
    { outcomes: [...total.outcomes, total.outcomes[0]!] },
    { outcomes: total.outcomes.map((o, i) => i ? { ...o, line: o.line! + 0.5 } : o) },
    { outcomes: total.outcomes.map((o, i) => i ? { ...o, oddsDecimal: NaN } : o) },
    { line: total.line! + 0.5 }, { line: 1.8 }, { units: "Corners" },
    { units: "Regular", name: "Total (Corners) – Match" }, { isLive: true },
    { period: 1, periodName: "Match" }, { period: 0, periodName: "1st Half" },
    { cutoffAt: "invalid" }, { cutoffAt: soccer.observedAt },
  ])("livro inválido: %j", patch => expect(resolve([{ ...total, ...patch }]).ok).toBe(false));

  it("exige handicaps opostos, incluindo a linha do mercado", () => {
    const input = { mercado: "Handicap", selecao: `${soccer.event.homeTeam.name} +${spread.line}` };
    expect(resolve([spread], input).ok).toBe(true);
    expect(resolve([{ ...spread, outcomes: spread.outcomes.map((o, i) => i ? { ...o, line: o.line! - 0.5 } : o) }], input).ok).toBe(false);
    expect(resolve([{ ...spread, line: spread.line! + 0.5 }], input).ok).toBe(false);
  });

  it.each([new Date("invalid"), new Date(new Date(soccer.observedAt).getTime() + 60_000),
    new Date(new Date(soccer.observedAt).getTime() - 16 * 60_000)])("recusa timestamp inválido/stale/futuro %s", observedAt => {
    expect(resolve([total], { observedAt })).toEqual({ ok: false, reason: "stale_price" });
  });

  it("não reduz livro 3-way removendo a odd inválida do empate", () => {
    const ml = soccer.markets.find(m => m.type === "moneyline")!;
    expect(normalizePinnacle17Markets([{ ...ml, outcomes: ml.outcomes.map(o => o.designation === "draw" ? { ...o, oddsDecimal: 0 } : o) }])).toEqual([]);
    expect(normalizePinnacle17Markets([{ ...ml, isLive: "true" }])).toEqual([]);
    expect(normalizePinnacle17Markets([{ ...total, line: false }])).toEqual([]);
    expect(normalizePinnacle17Events([{ ...soccer.event, status: { isStarted: "false" } }])).toEqual([]);
  });

  it.each([
    ["Tennis", "Total (Games) – Match", "Over 2.5 sets"],
    ["Basketball", "Total – Match", "Over 50.5 1st Quarter"],
    ["Soccer", "Total", "Over 2.5 Q1"], ["Baseball", "Total Period 3", "Over 2.5"],
    ["Soccer", "Total Shots", "Over 8.5"], ["eSports", "Total Dragons – Map 1", "Over 2.5"],
    ["Tennis", "Player Aces", "Over 4.5"], ["Soccer", "Correct Score", "2-1"],
    ["Golf", "Outright Winner", "Player A"],
    ["Golf", "Total", "Over 70.5"], ["Cycling", "Handicap", "Player A -1.5"],
  ])("preserva limites de escopo: %s/%s/%s", (esporte, mercado, selecao) => {
    expect(pinnacle17MarketContract({ esporte, mercado, selecao })).toBeNull();
  });

  it("preserva período/unidade carregados só pela seleção", () => {
    for (const selecao of ["Over 2.5 sets", "Over 9.5 corners", "Over 45.5 1st Quarter"]) {
      expect(pinnacleizeSelecao({ selecao, mercadoPinnacle: "Total", evento: "Alpha vs Beta" })).toBe(selecao);
    }
  });

  it("não funde homônimos de ligas/países diferentes", () => {
    const adult = { ...soccer.event, league: { id: 210900, name: "Paulista A1", country: "Brazil" } };
    const other = { ...adult, id: adult.id + 100, league: { id: 999, name: "Other", country: "Chile" } };
    const input = { events: [adult, other], home: adult.homeTeam.name,
      away: adult.awayTeam.name, kickoffUtc: new Date(adult.startTime) };
    expect(findPinnacle17Event(input)).toBeNull();
    expect(findPinnacle17Event({ ...input, country: adult.league.country })?.event.id).toBe(adult.id);
  });

  it.each([
    ["Moneyline", "Home", "Brazil"], ["Moneyline", "Away", "Germany"],
    ["Double Chance", "1X", "Brazil or Draw"], ["Double Chance", "X2", "Draw or Germany"],
    ["Handicap", "Casa +1.5", "Brazil +1.5"], ["Team Total", "Fora Over 1.5", "Germany Over 1.5"],
  ])("preserva orientação invertida %s/%s", (mercado, selecao, expected) => {
    expect(orientPinnacle17Selection({ mercado, selecao, home: "Brasil", away: "Alemanha",
      providerHome: "Germany", providerAway: "Brazil", swapped: true })).toBe(expected);
  });

  it.each([
    ["Handicap", "Time 1 -0.5", "Brazil -0.5"], ["Team Total", "Time 2 Over 1.5", "Germany Over 1.5"],
    ["Money Line – 1st Half", "1", "Brazil"], ["Money Line – 1st Half", "2", "Germany"],
  ])("o rótulo ordinal vira o nome do time antes da troca de mando %s/%s", (mercado, selecao, expected) => {
    const oriented = orientPinnacle17Selection({ mercado, selecao, home: "Brasil", away: "Alemanha",
      providerHome: "Germany", providerAway: "Brazil", swapped: true });
    expect(oriented).toBe(expected);
    expect(selectionFollowsEventOrder(mercado, oriented)).toBe(false);
  });

  it.each([
    ["Correct Score", "2-1"], ["Half Time/Full Time", "1/2"], ["Race to 3 Corners", "Time 1"],
  ])("seleção que fala pela posição dos times pede o evento na ordem do post %s/%s", (mercado, selecao) => {
    const oriented = orientPinnacle17Selection({ mercado, selecao, home: "Galo", away: "Raposa",
      providerHome: "Cruzeiro", providerAway: "Atletico Mineiro", swapped: true });
    expect(oriented).toBe(selecao);
    expect(selectionFollowsEventOrder(mercado, oriented)).toBe(true);
  });

  it.each([
    ["Total – Match", "Over 2.5"], ["Handicap – Match", "Cruzeiro -0.5"], ["Money Line – Match", "Draw"],
    ["Both Teams To Score", "Yes"], ["Anytime Goalscorer", "Hulk"],
  ])("seleção sem posição deixa o evento na ordem da Pinnacle %s/%s", (mercado, selecao) => {
    expect(selectionFollowsEventOrder(mercado, selecao)).toBe(false);
  });
});

describe("Pinnacle17: tempo regulamentar", () => {
  it("basquete sem mercado do tempo regulamentar na Pinnacle fica sem contrato", () => {
    expect(pinnacle17MarketContract({ esporte: "Basketball", mercado: "Money Line – Regulation Time", selecao: "Lakers", evento: "Lakers vs Celtics" }))
      .toBeNull();
  });

  it("hóquei aponta para o período regulamentar, que a Pinnacle lista", () => {
    expect(pinnacle17MarketContract({ esporte: "Ice Hockey", mercado: "Money Line – Regulation Time", selecao: "Rangers", evento: "Rangers vs Bruins" }))
      .toMatchObject({ scope: "regulation" });
  });
});

describe("Pinnacle17: vencedor de parte do jogo ou pelo método não usa o moneyline", () => {
  /** O livro medido do esporte, com a seleção escrita a partir do mandante. */
  const at = (sportId: number) => {
    const fixture = fixtures.find((f) => f.event.sport.id === sportId)!;
    return (mercado: string, selecao: (home: string) => string) => resolvePinnacle17CurrentOdds({
      event: fixture.event, markets: fixture.markets, esporte: fixture.event.sport.name, mercado,
      selecao: selecao(fixture.event.homeTeam.name), observedAt: new Date(fixture.observedAt), now: new Date(fixture.observedAt),
    });
  };
  const esports = at(12);
  const mma = at(22);

  it.each([
    ["Vencedor do Pistol Round", (home: string) => home],
    ["Money Line – Pistol Round", (home: string) => home],
    ["Vencedor do Pistol Round - Mapa 1", (home: string) => home],
    ["Money Line – Map 1 Pistol Round", (home: string) => home],
    ["Vencedor", (home: string) => `${home} - Pistol Round`],
  ])("eSports %s", (mercado, selecao) => {
    expect(esports(mercado, selecao).ok).toBe(false);
  });

  it.each([
    ["Vencedor", (home: string) => `${home} por KO/TKO`],
    ["Money Line – Match", (home: string) => `${home} por KO/TKO`],
    ["Vencedor por Decisão", (home: string) => home],
    ["Vencedor e Método", (home: string) => `${home} KO`],
  ])("MMA %s", (mercado, selecao) => {
    expect(mma(mercado, selecao).ok).toBe(false);
  });

  it("o vencedor do jogo e da luta continua no moneyline", () => {
    expect(esports("Money Line – Match", (home) => home).ok).toBe(true);
    expect(mma("Vencedor da Luta", (home) => home).ok).toBe(true);
  });
});

describe("Pinnacle17: natureza da unidade declarada na seleção", () => {
  it.each([
    ["Total", "Under 1.5 red cards"],
    ["Total (Bookings) – Match", "Under 2.5 cartões amarelos"],
    ["Total Yellow Cards", "Under 2.5"],
    ["Total", "Under 4.5 shots on target"],
    ["Total", "Over 15.5 passes"],
  ])("%s / %s não usa preço de outra contagem", (mercado, selecao) => {
    expect(pinnacle17MarketContract({ esporte: "Soccer", mercado, selecao })).toBeNull();
    expect(providerCoversBet("pinnacle17", { esporte: "Soccer", mercado, selecao })).toBe(false);
  });
});


describe("Pinnacle17: qualificadores originais na equivalência", () => {
  it.each(["Including OT", "Incluindo Prorrogação", "Com Prorrogação"])("DNB de futebol %s não se torna AH de 90 minutos", rule => {
    const market: Pinnacle17Market = { ...spread, line: 0, outcomes: spread.outcomes.map(o => ({ ...o, line: 0 })) };
    expect(resolve([market], { mercado: `Draw No Bet – ${rule}`, selecao: soccer.event.homeTeam.name }))
      .toEqual({ ok: false, reason: "unsupported_market" });
  });

  it("no futebol a menção ao tempo regulamentar não tira o preço da dupla chance nem do empate anula", () => {
    const home = soccer.event.homeTeam.name;
    const at = (line: number): Pinnacle17Market => ({ ...spread, line, outcomes: spread.outcomes.map(o => ({ ...o, line: o.designation === "home" ? line : -line })) });
    for (const [market, plain, labelled] of [
      [at(0.5), { mercado: "Double Chance", selecao: `${home} or Draw` }, { mercado: "Dupla Chance - 1X2", selecao: `${home} or Draw` }],
      [at(0.5), { mercado: "Double Chance", selecao: `${home} or Draw` }, { mercado: "Resultado Final 1X2 - Dupla Chance", selecao: `${home} or Draw` }],
      [at(0), { mercado: "Draw No Bet", selecao: home }, { mercado: "Draw No Bet", selecao: `${home} (TR)` }],
    ] as const) {
      const expected = resolve([market], plain);
      expect(expected.ok).toBe(true);
      expect(resolve([market], labelled)).toEqual(expected);
    }
  });

  it.each(["Tempo Regular", "Tempo Normal", "Regulamentar", "Regular Time", "(TR)", "1X2", "3-way"])("%s seleciona regulamentar no hóquei e recusa basquete sem esse livro", rule => {
    for (const sportId of [4, 19]) {
      const fixture = fixtures.find(f => f.event.sport.id === sportId)!;
      for (const input of [
        { mercado: `Moneyline – ${rule}`, selecao: fixture.event.homeTeam.name },
        { mercado: "Moneyline", selecao: `${fixture.event.homeTeam.name} – ${rule}` },
      ]) {
        const contract = pinnacle17MarketContract({ ...input, esporte: fixture.event.sport.name,
          evento: `${fixture.event.homeTeam.name} vs ${fixture.event.awayTeam.name}` });
        if (sportId === 19) expect(contract).toMatchObject({ scope: "regulation" });
        else expect(contract).toBeNull();
        const quote = resolvePinnacle17CurrentOdds({ ...input, event: fixture.event, markets: fixture.markets,
          esporte: fixture.event.sport.name, observedAt: new Date(fixture.observedAt), now: new Date(fixture.observedAt) });
        if (sportId === 19) {
          expect(quote.ok).toBe(true);
          if (quote.ok) expect(quote.value.reference.period).not.toBe(0);
        } else expect(quote).toEqual({ ok: false, reason: "unsupported_market" });
      }
    }
  });
});


it.each(["Points", "Sets", "Games"])("DNB de futebol em %s não usa handicap de gols", unit => {
  const market: Pinnacle17Market = { ...spread, line: 0, outcomes: spread.outcomes.map(o => ({ ...o, line: 0 })) };
  expect(resolve([market], { mercado: `Draw No Bet (${unit})`, selecao: soccer.event.homeTeam.name }))
    .toEqual({ ok: false, reason: "unsupported_market" });
});

it("DNB de tênis em sets não presume a mesma regra de retirada do handicap", () => {
  const fixture = fixtures.find(f => f.event.sport.id === 33)!;
  const base = fixture.markets.find(m => m.type === "spread" && m.period === 0)!;
  const market: Pinnacle17Market = { ...base, name: "Handicap (Sets) – Match", units: "Sets", line: 0,
    outcomes: base.outcomes.map(o => ({ ...o, line: 0 })) };
  const result = resolvePinnacle17CurrentOdds({ event: fixture.event, markets: [market], esporte: "Tennis",
    mercado: "Draw No Bet (Sets)", selecao: fixture.event.homeTeam.name,
    observedAt: new Date(fixture.observedAt), now: new Date(fixture.observedAt) });
  expect(result).toEqual({ ok: false, reason: "unsupported_market" });
});


it.each(["Tennis", "Table Tennis"])("roteamento não promete DNB/DC equivalente em %s", esporte => {
  for (const mercado of ["Draw No Bet", "Double Chance"]) {
    expect(providerCoversBet("pinnacle17", { esporte, mercado })).toBe(false);
  }
  expect(providerCoversBet("pinnacle17", { esporte, mercado: "Moneyline" })).toBe(true);
});
