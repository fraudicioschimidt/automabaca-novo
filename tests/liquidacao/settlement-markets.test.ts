import { describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/client";
import { classifyScoreMarket, isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { hasUnknownScoreQualifier } from "@/src/domain/mercados/stat-qualifier";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { matchMoneylineSelection } from "@/src/domain/settlement/sides";
import { coerceMercadoPelaSelecao } from "@/src/domain/mercados/coerce";
import { isOutrightMarket, marketKindOf, OUTRIGHT_SCOPE_NOUNS } from "@/src/domain/mercados/classify";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { MATCH_SCOPE_NOUNS } from "@/src/domain/mercados/match-scope";
import { normalizeStr } from "@/src/domain/text";

const base = {
  evento: "Flamengo vs Palmeiras",
  odds: 2.0,
  stake: 1,
};

describe("isScoreResolvableMarket — período", () => {
  const r = (mercado: string, selecao: string) =>
    resolveResultFromScore({ ...base, mercado, selecao, homeScore: 3, awayScore: 0 });

  it("isScoreResolvableMarket: HT é FALSE (vira manual), FT segue resolvível", () => {
    expect(isScoreResolvableMarket({ mercado: "1st Half Total", selecao: "Over 1.5" })).toBe(false);
    expect(isScoreResolvableMarket({ mercado: "Total", selecao: "Over 2.5" })).toBe(true);
    expect(isScoreResolvableMarket({ mercado: "Moneyline", selecao: "Flamengo" })).toBe(true);
    expect(r("Total – Match", "Over 1.5")).toMatchObject({ ok: true });
  });
});

describe("classifyScoreMarket — linha de gols é total; escanteios e cartões seguem fail-closed", () => {
  it("Linha de Gols/Goal Line liquida como total; escanteios e cartões continuam fail-closed", () => {
    expect(classifyScoreMarket("linha de gols", "over 2.5")).toBe("total");
    expect(classifyScoreMarket("asian corners", "over 10.0")).toBe("total");
    expect(classifyScoreMarket("cantos asiaticos", "over 10.0")).toBe("total");
    expect(classifyScoreMarket("escanteios asiaticos", "under 10.5")).toBe("total");
    expect(classifyScoreMarket("asian cards", "over 3.5")).toBe("total");
    expect(classifyScoreMarket("cartoes asiaticos", "over 3.5")).toBe("total");
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Linha de Gols",
        selecao: "Over 2.5",
        homeScore: 2,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(isScoreResolvableMarket({ mercado: "Linha de Pontos", selecao: "Over 210.5" })).toBe(true);
    for (const mercado of ["Linha de Escanteios", "Linha de Cartões"]) {
      expect(
        isScoreResolvableMarket({ mercado, selecao: "Over 9.5" }),
        mercado,
      ).toBe(false);
      expect(
        resolveResultFromScore({
          ...base,
          mercado,
          selecao: "Over 9.5",
          homeScore: 12,
          awayScore: 0,
        }),
        mercado,
      ).toEqual({ ok: false, reason: "stat_qualifier" });
    }
  });
});

describe("coerceMercadoPelaSelecao — mercado de estatística preserva o rótulo", () => {
  it("mercado de estatística preserva o rótulo e segue fail-closed no placar", () => {
    for (const [mercado, selecao] of [
      ["Linha de Finalizações", "Over 4.5"],
      ["Linha de Chutes", "Over 9.5"],
      ["Linha de Assistências", "Over 20.5"],
    ] as const) {
      const coagido = coerceMercadoPelaSelecao(mercado, selecao, "Soccer");
      expect(coagido, mercado).toBe(mercado);
      expect(
        resolveResultFromScore({ ...base, mercado: coagido, selecao, homeScore: 3, awayScore: 0 }),
        mercado,
      ).toEqual({ ok: false, reason: "stat_qualifier" });
    }
  });
});

describe("marketKindOf / classifyScoreMarket — moneyline por frase e escopo", () => {
  it("moneyline com rótulo de duelo/combate e frase 'Quem vence'", () => {
    for (const selecao of ["Vencedor do Duelo - 1", "Vencedor do Combate - 1"]) {
      expect(matchMoneylineSelection(selecao, base.evento), selecao).toBe("home");
    }
    expect(matchMoneylineSelection("Ganhador do Duelo - 2", base.evento)).toBe("away");
    for (const mercado of [
      "Quem Vencerá",
      "Quem Vence",
      "Quem Ganhará",
      "Quem Ganha",
      "Quem Vencerá o Jogo",
      "Quem Vence a Partida",
      "Quem Ganha a Partida",
    ]) {
      expect(marketKindOf(mercado), mercado).toBe("moneyline");
      expect(classifyScoreMarket(normalizeStr(mercado), "flamengo"), mercado).toBe(
        "moneyline",
      );
      expect(
        pinnacleizeSelecao({
          selecao: "Casa",
          mercadoPinnacle: mercado,
          evento: base.evento,
        }),
        mercado,
      ).toBe("Flamengo");
      expect(
        resolveResultFromScore({ ...base, mercado, selecao: "Flamengo", homeScore: 2, awayScore: 1 }),
        mercado,
      ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    }
    // Outright com a mesma frase continua fora do placar da partida.
    for (const mercado of ["Quem Vencerá o Campeonato", "Quem Vence a Liga"]) {
      expect(
        isScoreResolvableMarket({ mercado, selecao: "Flamengo" }),
        mercado,
      ).toBe(false);
    }
  });

  it("Ganhador resolve como moneyline nas duas bordas; do campeonato é outright", () => {
    for (const mercado of ["Ganhador da Partida", "Ganhador do Duelo", "Ganhador do Evento"]) {
      expect(marketKindOf(mercado), mercado).toBe("moneyline");
      expect(isScoreResolvableMarket({ mercado, selecao: "Flamengo" }), mercado).toBe(true);
      expect(
        resolveResultFromScore({ ...base, mercado, selecao: "Flamengo", homeScore: 2, awayScore: 1 }),
        mercado,
      ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    }
    // `isOutrightMarket` precisa cobrir "ganhador", não só "vencedor" do
    // campeonato; senão a aposta de título liquida pelo placar da partida.
    for (const mercado of ["Ganhador do Campeonato", "Ganhador do Grupo", "Ganhadora da Liga"]) {
      expect(isScoreResolvableMarket({ mercado, selecao: "Flamengo" }), mercado).toBe(false);
    }
  });

  it("escopo da vitória é o MESMO dado nos dois classificadores irmãos", () => {
    // Se `classifyScoreMarket` aceitar "Para Ganhar a Partida" e `marketKindOf`
    // devolver `other` para a mesma string, a aposta fica liquidável mas sem
    // CLV. O teste percorre a fonte exportada, não uma cópia declarada aqui.
    for (const escopo of MATCH_SCOPE_NOUNS) {
      for (const mercado of [`Para Ganhar o ${escopo}`, `Para Vencer o ${escopo}`, `Ganhador do ${escopo}`]) {
        expect(marketKindOf(mercado), mercado).toBe("moneyline");
        expect(classifyScoreMarket(normalizeStr(mercado), "flamengo"), mercado).toBe("moneyline");
        expect(isScoreResolvableMarket({ mercado, selecao: "Flamengo" }), mercado).toBe(true);
      }
    }
  });
});

describe("isOutrightMarket — escopo de outright", () => {
  it("prêmio no escopo é OUTRIGHT: título/taça/copa não liquidam pelo placar de UMA partida", () => {
    // `OUTRIGHT_SCOPE_NOUNS` cobre o PRÊMIO, não só a COMPETIÇÃO: como
    // moneyline, "Vencedor do Título" liquidaria uma aposta de temporada inteira
    // pelo resultado do primeiro jogo do time.
    for (const mercado of [
      "Vencedor do Título", "Quem Vencerá a Taça", "Vencedor da Copa",
      "Campeã do Título", "Para Ganhar a Copa", "Ganhador da Taça",
    ]) {
      expect(isOutrightMarket(mercado), mercado).toBe(true);
      expect(marketKindOf(mercado), mercado).toBe("other");
      expect(isScoreResolvableMarket({ mercado, selecao: "Flamengo" }), mercado).toBe(false);
      expect(
        resolveResultFromScore({ ...base, mercado, selecao: "Flamengo", homeScore: 2, awayScore: 1 }).ok,
        mercado,
      ).toBe(false);
    }
    // O par (verbo, escopo) continua exigido: o substantivo sozinho não exclui
    // o mercado da partida.
    for (const mercado of ["Total de Gols", "Moneyline – Copa", "Handicap – Match"]) {
      expect(isOutrightMarket(mercado), mercado).toBe(false);
    }
  });

  it("escopo de outright cobre prêmio, fase e temporada nas duas ordens (PT e EN)", () => {
    // "Vencedor da Fase de Grupos", "Vencedor da Temporada" e a ordem EN
    // "Group Stage Winner" não podem liquidar uma aposta de futuro pelo placar
    // de UMA partida.
    for (const escopo of OUTRIGHT_SCOPE_NOUNS) {
      for (const mercado of [`Vencedor do ${escopo}`, `${escopo} Winner`]) {
        expect(isOutrightMarket(mercado), mercado).toBe(true);
        expect(isScoreResolvableMarket({ mercado, selecao: "Flamengo" }), mercado).toBe(false);
        expect(
          resolveResultFromScore({ ...base, mercado, selecao: "Flamengo", homeScore: 2, awayScore: 1 }).ok,
          mercado,
        ).toBe(false);
      }
    }
    // Sem verbo de vitória o substantivo não exclui o mercado da partida.
    for (const mercado of ["Total de Gols – Copa", "Handicap – Season", "Moneyline"]) {
      expect(isOutrightMarket(mercado), mercado).toBe(false);
    }
  });
});

describe("pinnacleizeSelecao — unidade de estatística no sufixo não descarta o time", () => {
  it("unidade de estatística no sufixo não descarta o time do total por equipe", () => {
    for (const [selecao, esperado, mercadoPinnacle] of [
      ["Over 25.5 Abates do Time 1", "Flamengo Over 25.5", "Team Total Kills"],
      ["Mais de 12.5 Rebotes da Equipe 2", "Palmeiras Over 12.5", "Team Total Rebounds"],
      ["Over 25.5 Kills da Equipe 2", "Palmeiras Over 25.5", "Team Total Kills"],
      ["Over 4.5 Cartões do Time 1", "Flamengo Over 4.5", "Team Total Cards"],
    ] as const) {
      expect(
        pinnacleizeSelecao({ selecao, mercadoPinnacle, evento: base.evento }),
        selecao,
      ).toBe(esperado);
    }
    // Período/estatística sem time continua sem inventar lado.
    expect(
      pinnacleizeSelecao({ selecao: "Over 9.5 corners 1st half", mercadoPinnacle: "Total (Corners) – 1st Half", evento: base.evento }),
    ).toBe("Over 9.5");
  });

  it("estatística de vôlei/tênis/basquete no sufixo não descarta o time", () => {
    for (const [selecao, esperado, mercadoPinnacle] of [
      ["Over 2.5 Bloqueios do Time 1", "Flamengo Over 2.5", "Team Total Blocks"],
      ["Over 2.5 Blocks da Equipe 1", "Flamengo Over 2.5", "Team Total Blocks"],
      ["Mais de 5.5 Aces da Equipe 2", "Palmeiras Over 5.5", "Team Total Aces"],
      ["Mais de 15.5 Attempts do Time 2", "Palmeiras Over 15.5", "Team Total Attempts"],
      ["Over 10.5 Acertos do Time 1", "Flamengo Over 10.5", "Team Total Hits"],
      ["Over 10.5 Hits do Time 1", "Flamengo Over 10.5", "Team Total Hits"],
    ] as const) {
      expect(
        pinnacleizeSelecao({ selecao, mercadoPinnacle, evento: base.evento }),
        selecao,
      ).toBe(esperado);
    }
    // Estatística continua fora do settlement por placar nos dois casos.
    expect(isScoreResolvableMarket({ mercado: "Team Total Blocks", selecao: "Over 2.5" })).toBe(false);
  });
});

describe("qualificador nomeado de linha falha fechado", () => {
  const inventados = [
    "Total de Xyzzy",
    "Total (Plurbs) – Match",
    "Zorbles Total",
    "Handicap de Quux",
    "Time 1 - Frobnitz",
  ];

  it.each(inventados)("recusa a unidade desconhecida em %s", (mercado) => {
    expect(hasUnknownScoreQualifier(mercado)).toBe(true);
    expect(isScoreResolvableMarket({
      mercado,
      selecao: mercado.includes("Handicap") ? "Santos -1.5" : "Under 21.5",
      esporte: "Soccer",
      evento: "Santos vs Macara",
    })).toBe(false);
    expect(resolveResultFromScore({
      mercado,
      selecao: mercado.includes("Handicap") ? "Santos -1.5" : "Under 21.5",
      evento: "Santos vs Macara",
      odds: 2,
      stake: 1,
      homeScore: 2,
      awayScore: 1,
    }).ok).toBe(false);
  });

  it.each([
    ["Total – Match", "Under 2.5", "Soccer"],
    ["Total de Gols", "Under 2.5", "Soccer"],
    ["Total de Pontos", "Under 210.5", "Basketball"],
    ["Total de Runs", "Under 8.5", "Baseball"],
    ["Team Total", "Santos Under 1.5", "Soccer"],
  ])("preserva unidade de placar legítima: %s", (mercado, selecao, esporte) => {
    expect(hasUnknownScoreQualifier(mercado)).toBe(false);
    expect(isScoreResolvableMarket({
      mercado,
      selecao,
      esporte,
      evento: "Santos vs Macara",
    })).toBe(true);
  });

  it.each([
    "Total de Remates",
    "Total de Posse de Bola",
    "Total de Foras de Jogo",
    "Total de Pontapés de Baliza",
    "Total de Livres",
    "Total de Grandes Penalidades",
    "Total de Substituições",
    "Total de Lançamentos Laterais",
    "Total de Ataques",
    "Total de Ataques Perigosos",
    "Total de Bolas na Trave",
  ])("estatística conhecida também fica fora do placar: %s", (mercado) => {
    expect(isScoreResolvableMarket({
      mercado,
      selecao: "Under 21.5",
      esporte: "Soccer",
    })).toBe(false);
  });
});
