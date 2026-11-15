import { describe, expect, it } from "vitest";
import { DEFAULT_BANKROLL_FILTERS, normalizeBankrollFilters, selectBankrollHistory } from "@/app/_design/lib/bankroll-filters";
import { SPORT_OPTIONS, sportLabel } from "@/app/_design/lib/sport-options";

describe("Filtros do Bankroll", () => {
  it("inicia com o filtro de esporte zerado em 'todos'", () => {
    expect(DEFAULT_BANKROLL_FILTERS.sport).toBe("todos");
  });

  it("mapeia modalidades conhecidas para rótulos em pt-BR", () => {
    const sportMap = Object.fromEntries(SPORT_OPTIONS.map((o) => [o.value, o.label]));
    expect(sportMap["Soccer"]).toBe("Futebol");
    expect(sportMap["Basketball"]).toBe("Basquete");
    expect(sportMap["Tennis"]).toBe("Tênis");
    expect(sportMap["eSports"]).toBe("eSports");
    expect(sportLabel("Soccer")).toBe("Futebol");
    expect(sportLabel("Unknown")).toBe("A confirmar");
  });

  it("filtra apostas por modalidade corretamente", () => {
    const bets = [
      { id: "1", status: "pending", profit: null, odds: 2, esporte: "Soccer", line: "Under 2.5", region: "Brazil" },
      { id: "2", status: "won", profit: 1, odds: 2, esporte: "Basketball", line: "Over 210.5", region: "USA" },
      { id: "3", status: "lost", profit: -1, odds: 2, esporte: "eSports", line: "Map 1 Winner", region: "Europe" },
    ];

    const filterBySport = (list: typeof bets, sport: string) =>
      selectBankrollHistory(list, { tab: "todas", query: "", filters: { ...DEFAULT_BANKROLL_FILTERS, sport } }).filtered;

    expect(filterBySport(bets, "todos")).toHaveLength(3);
    expect(filterBySport(bets, "Soccer")).toEqual([bets[0]]);
    expect(filterBySport(bets, "Basketball")).toEqual([bets[1]]);
    expect(filterBySport(bets, "eSports")).toEqual([bets[2]]);
  });
});

describe("filtro de movimento da linha", () => {
  it("\"Estável\" não inclui aposta sem movimento medido", () => {
    const bets = [
      { id: "1", status: "won", profit: 1, odds: 2, esporte: "Soccer", line: "A", region: "BR", d: { moveType: "estavel" } },
      { id: "2", status: "won", profit: 1, odds: 2, esporte: "Soccer", line: "B", region: "BR", d: { moveType: null } },
      { id: "3", status: "won", profit: 1, odds: 2, esporte: "Soccer", line: "C", region: "BR", d: { moveType: "steam" } },
    ];
    const porMovimento = (movement: string) =>
      selectBankrollHistory(bets, { tab: "todas", query: "", filters: { ...DEFAULT_BANKROLL_FILTERS, movement } }).filtered.map((b) => b.id);
    expect(porMovimento("estavel")).toEqual(["1"]);
    expect(porMovimento("steam")).toEqual(["3"]);
    expect(porMovimento("todas")).toEqual(["1", "2", "3"]);
  });
});

describe("histórico real e preferências persistidas", () => {
  it.each([null, [], 1, "corrompido", {}])("recupera filtros ausentes ou inválidos: %j", (stored) => {
    expect(normalizeBankrollFilters(stored)).toEqual(DEFAULT_BANKROLL_FILTERS);
  });

  it("preserva preferências válidas e completa campos de versões antigas", () => {
    // Campo que o filtro não conhece mais (`minEv`) é ignorado.
    expect(normalizeBankrollFilters({ sport: "Tennis", minEv: 10, odds: "antiga" }))
      .toEqual({ ...DEFAULT_BANKROLL_FILTERS, sport: "Tennis" });
  });

  const bets = [
    { id: "a", status: "pending", profit: null, esporte: "Soccer", home: "Santos", region: "BR", line: "Over", odds: 1.89 },
    { id: "b", status: "halfwon", profit: 0.5, esporte: "Soccer", home: "Santos", region: "BR", line: "Over", odds: 1.90 },
    { id: "c", status: "half", profit: -0.5, esporte: "Tennis", home: "Sinner", region: "IT", line: "Over", odds: 1.95 },
    { id: "d", status: "void", profit: 0, region: "BR", line: "Under", odds: 2 },
  ];

  it("conta o histórico completo e cruza aba, consulta e modalidade", () => {
    const result = selectBankrollHistory(bets, {
      tab: "ganhas", query: "  SANTOS ", filters: { ...DEFAULT_BANKROLL_FILTERS, sport: "Soccer" },
    });
    expect(result.filtered).toEqual([bets[1]]);
    expect(result.counts).toEqual({ todas: 4, pendentes: 1, ganhas: 1, perdidas: 1 });
    expect(result.activeFilterCount).toBe(1);
  });

  it.each([
    ["<1.90", "a"], ["1.90–1.95", "b"], ["1.95–2.00", "c"], ["2.00+", "d"],
  ])("mantém as fronteiras de odds sem sobreposição: %s", (odds, id) => {
    const result = selectBankrollHistory(bets, { tab: "todas", query: "", filters: { ...DEFAULT_BANKROLL_FILTERS, odds } });
    expect(result.filtered.map((bet) => bet.id)).toEqual([id]);
  });

  it("não transforma esporte ausente em futebol", () => {
    const result = selectBankrollHistory(bets, { tab: "todas", query: "", filters: { ...DEFAULT_BANKROLL_FILTERS, sport: "Soccer" } });
    expect(result.filtered.map((bet) => bet.id)).toEqual(["a", "b"]);
  });
});

describe("abas de resultado financeiro", () => {
  const bets = [
    { id: "cash-positive", status: "cashout", profit: 0.25, odds: 2, region: "BR", line: "A" },
    { id: "cash-negative", status: "cashout", profit: -0.25, odds: 2, region: "BR", line: "A" },
    { id: "cash-zero", status: "cashout", profit: 0, odds: 2, region: "BR", line: "A" },
    { id: "half-win", status: "halfwon", profit: 0.5, odds: 2, region: "BR", line: "A" },
    { id: "half-loss", status: "half", profit: -0.5, odds: 2, region: "BR", line: "A" },
    { id: "rounded-win", status: "won", profit: 0, odds: 1.0001, region: "BR", line: "A" },
    { id: "pending", status: "pending", profit: null, odds: 2, region: "BR", line: "A" },
    { id: "void", status: "void", profit: 0, odds: 2, region: "BR", line: "A" },
  ];
  it.each([
    ["ganhas", ["cash-positive", "half-win"]],
    ["perdidas", ["cash-negative", "half-loss"]],
  ])("a aba %s filtra e conta pelo lucro financeiro", (tab, ids) => {
    const result = selectBankrollHistory(bets, { tab, query: "", filters: DEFAULT_BANKROLL_FILTERS });
    expect(result.filtered.map((b) => b.id)).toEqual(ids);
    expect(result.counts).toEqual({ todas: 8, pendentes: 1, ganhas: 2, perdidas: 2 });
  });
});


describe("busca da casa no histórico", () => {
  const bets = [
    { id: "perdida", status: "lost", profit: -1, odds: 2, region: "BR", line: "Over 2.5", d: { casa: "Bet365" } },
    { id: "ganha", status: "won", profit: 1, odds: 2, region: "BR", line: "Under 2.5", d: { casa: "Pinnacle" } },
    { id: "sem-casa", status: "pending", profit: null, odds: 2, region: "BR", line: "Over 2.5", d: null },
  ];
  it.each([["  bEt365  ", "todas", "perdida"], ["pinnacle", "ganhas", "ganha"]])(
    "seleciona a casa digitada (%s) junto com a aba (%s)", (query, tab, id) => {
      const { filtered } = selectBankrollHistory(bets, { query, tab, filters: DEFAULT_BANKROLL_FILTERS });
      expect(filtered.map((bet) => bet.id)).toEqual([id]);
    },
  );
});
