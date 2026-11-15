import { describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/client";
import { classifyScoreMarket, isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { parseLineQuarters } from "@/src/domain/settlement/lines";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { marketIncludesExtraTime, marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { SIDE_SCOPE_NOUNS } from "@/src/domain/mercados/match-scope";
import { normalizeStr } from "@/src/domain/text";
import {
  matchDoubleChanceSelection,
  matchDrawNoBetSelection,
  matchMoneylineSelection,
  matchTeamSide,
  stripTeamNames,
} from "@/src/domain/settlement/sides";

const base = {
  evento: "Flamengo vs Palmeiras",
  odds: 2.0,
  stake: 1,
};

describe("stripTeamNames", () => {
  it("remove nomes pontuados sem interpolar caracteres especiais em regex", () => {
    const stripped = stripTeamNames("O'Higgins F.C. +0.5", "O'Higgins F.C. vs B/C United");
    expect(stripped).toContain("+0.5");
    expect(stripped).not.toContain("higgins");
  });

  it("preserva linha inteira que coincide com categoria Sub-20", () => {
    const stripped = stripTeamNames(
      "Over 20",
      "Flamengo Sub-20 vs Palmeiras Sub-20",
    );
    expect(stripped.replace(/\s+/g, " ").trim()).toBe("over 20");
    expect(parseLineQuarters(stripped, { allowNegative: false })).toBe(80);
  });

  it("preserva linha inteira que coincide com categoria Under 20", () => {
    const stripped = stripTeamNames(
      "Over 20",
      "Flamengo Under 20 vs Palmeiras Under 20",
    );
    expect(stripped.replace(/\s+/g, " ").trim()).toBe("over 20");
    expect(parseLineQuarters(stripped, { allowNegative: false })).toBe(80);
  });
});

describe("matchTeamSide", () => {
  it("reconhece sufixos estaduais equivalentes no lado do time", () => {
    expect(matchTeamSide("Atlético Mineiro", "Cruzeiro vs Atlético-MG")).toBe("away");
    expect(matchTeamSide("Athletico Paranaense", "Coritiba vs Athletico-PR")).toBe("away");
    expect(matchTeamSide("Botafogo de Futebol e Regatas", "Botafogo-RJ vs Flamengo")).toBe("home");
    expect(matchTeamSide("Sport Club Internacional", "Grêmio vs Internacional-RS")).toBe("away");
    expect(matchTeamSide("São Paulo FC", "Sao Paulo-SP vs Santos")).toBe("home");
    // Estado explícito conflitante nunca colapsa na forma-base homônima.
    expect(matchTeamSide("América Mineiro", "America-RJ vs Flamengo")).toBeNull();
    expect(matchTeamSide("Atlético Mineiro", "Atletico-GO vs Flamengo")).toBeNull();
  });

  it("matchTeamSide não escolhe metade de uma seleção de Dupla Chance", () => {
    expect(matchTeamSide("Flamengo ou Empate", base.evento)).toBeNull();
    expect(matchTeamSide("Empate ou Palmeiras", base.evento)).toBeNull();
    expect(matchDoubleChanceSelection("Flamengo ou Empate", base.evento)).toEqual([
      "home",
      "draw",
    ]);
  });

  it("resolve labels numerados de lado sem interpretar número solto", () => {
    for (const selection of ["Time 1", "Equipe 1", "Clube 1", "Team 1", "Club 1"]) {
      expect(matchTeamSide(selection, base.evento), selection).toBe("home");
    }
    for (const selection of ["Time 2", "Equipe 2", "Clube 2", "Team 2", "Club 2"]) {
      expect(matchTeamSide(selection, base.evento), selection).toBe("away");
    }
    expect(matchTeamSide("Jogo 1", base.evento)).toBeNull();
    expect(matchTeamSide("Jogador 2", base.evento)).toBeNull();
    expect(matchTeamSide("Team 1", "Club 2 vs Team 1")).toBe("away");
  });

  it("resolve ordinais PT/EN e Local/Visitor como labels completos de lado", () => {
    for (const selection of [
      "Primeiro Time",
      "Primeira Equipe",
      "First Team",
      "1st Team",
      "Local Team",
    ]) {
      expect(matchTeamSide(selection, base.evento), selection).toBe("home");
    }
    for (const selection of [
      "Segundo Time",
      "Segunda Equipe",
      "Second Team",
      "2nd Team",
      "Visitor Team",
      "Visiting Team",
    ]) {
      expect(matchTeamSide(selection, base.evento), selection).toBe("away");
    }
  });

  it("linha entre parênteses não impede o rótulo genérico de resolver o lado", () => {
    for (const selection of [
      "Time 1 (+0.5)",
      "Primeiro Time (+0.5)",
      "First Team (+0.5)",
      "Local Team (+0.25)",
    ]) {
      expect(matchTeamSide(selection, base.evento), selection).toBe("home");
    }
    for (const selection of [
      "Equipe 2 (-0.5)",
      "Segundo Time (-0.5)",
      "Second Team (-0.5)",
      "Visitor Team (-1)",
    ]) {
      expect(matchTeamSide(selection, base.evento), selection).toBe("away");
    }
    // O nome real do clube continua tendo prioridade sobre o rótulo genérico.
    expect(matchTeamSide("Flamengo (+0.5)", base.evento)).toBe("home");
    // Dígito nu resolve SÓ com a linha isolada entre parênteses.
    expect(matchTeamSide("1 (+0.5)", base.evento)).toBe("home");
    expect(matchTeamSide("2 (-1.5)", base.evento)).toBe("away");
    expect(matchTeamSide("1", base.evento)).toBeNull();
    expect(matchTeamSide("1 -0.5", base.evento)).toBeNull();
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Asian Handicap",
        selecao: "Time 1 (+0.5)",
        homeScore: 1,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("rótulos numerados de vencedor resolvem o lado sem contaminar props", () => {
    for (const selecao of ["Vencedor 1", "Ganhador 1", "Winner 1", "Match Winner 1"]) {
      expect(matchTeamSide(selecao, base.evento), selecao).toBe("home");
    }
    for (const selecao of ["Vencedor 2", "Ganhador 2", "Winner 2", "Match Winner 2"]) {
      expect(matchTeamSide(selecao, base.evento), selecao).toBe("away");
    }
    // `HOME_TOKENS` continua sendo só substring de último recurso: prop com
    // ordinal não pode resolver lado.
    for (const selecao of ["Primeiro time a marcar", "Primeiro a marcar", "Winner Map 1", "Vencedor 3"]) {
      expect(matchTeamSide(selecao, base.evento), selecao).toBeNull();
    }
  });

  it("anotação de lado entre parênteses resolve o dígito nu, mas não pode contradizê-lo", () => {
    expect(matchTeamSide("1 (Primeiro Time)", base.evento)).toBe("home");
    expect(matchTeamSide("2 (Segundo Time)", base.evento)).toBe("away");
    expect(matchTeamSide("1 (First Team)", base.evento)).toBe("home");
    expect(matchTeamSide("1 -0.5", base.evento)).toBeNull();
    // Anotação em desacordo com o rótulo externo é dado corrompido: fail-closed.
    for (const selecao of ["1 (Segundo Time)", "2 (Primeiro Time)", "1 (Winner 2)", "Time 1 (Second Team)"]) {
      expect(matchTeamSide(selecao, base.evento), selecao).toBeNull();
    }
  });

  it("rótulo numerado com unidade NUMERADA continua ambíguo", () => {
    // "Jogo 1"/"Game 1" é unidade parcial em todo o resto do sistema
    // (`marketPeriodOf` devolve OTHER). Aceitá-lo como LADO na seleção faria
    // uma aposta no jogo 1 liquidar pelo placar da partida inteira.
    expect(marketPeriodOf("Vencedor do Jogo 1")).toBe("OTHER");
    expect(marketPeriodOf("Game 1 Winner")).toBe("OTHER");
    for (const selecao of ["Vencedor do Jogo 1", "Game Winner 1", "Vencedor do Jogo 2"]) {
      expect(matchTeamSide(selecao, base.evento), selecao).toBeNull();
    }
    // As formas sem unidade numerada resolvem.
    for (const selecao of ["Vencedor da Partida 1", "Event Winner 1", "Ganhador do Duelo 1"]) {
      expect(matchTeamSide(selecao, base.evento), selecao).toBe("home");
    }
    expect(matchTeamSide("Vencedor da Partida 2", base.evento)).toBe("away");
    // Em MONEYLINE o mercado desambigua: ali o rótulo EN é aceito.
    expect(matchMoneylineSelection("Game Winner - 1", base.evento)).toBe("home");
    expect(matchMoneylineSelection("Event Winner - 2", base.evento)).toBe("away");
  });

  it("anotações encadeadas entre parênteses são limpas e checadas entre si", () => {
    expect(matchTeamSide("1 (+0.5) (Clube 1)", base.evento)).toBe("home");
    expect(matchTeamSide("2 (-0.5) (Clube 2)", base.evento)).toBe("away");
    expect(matchTeamSide("1 (+0.5) (Clube 2)", base.evento)).toBeNull();
    expect(
      pinnacleizeSelecao({ selecao: "1 (+0.5) (Clube 1)", mercadoPinnacle: "Asian Handicap", evento: base.evento }),
    ).toBe("1 (+0.5) (Clube 1)"); // A linha completa tem números extras; não encurtar o contrato.
  });

  it("anotação de lado entre colchetes é ruído; colchete que CONTRADIZ falha fechado", () => {
    expect(matchTeamSide("1 (+0.5) [Time 1]", base.evento)).toBe("home");
    expect(matchTeamSide("2 (-0.5) [Time 2]", base.evento)).toBe("away");
    expect(matchTeamSide("1 [Primeiro Time]", base.evento)).toBe("home");
    expect(matchTeamSide("1 (+0.5) [Time 2]", base.evento)).toBeNull();
    expect(matchTeamSide("2 [Primeiro Time]", base.evento)).toBeNull();
    // Delimitador malformado não é anotação.
    expect(matchTeamSide("1 (+0.5) [Time 1)", base.evento)).toBeNull();
    expect(
      pinnacleizeSelecao({ selecao: "1 (+0.5) [Time 1]", mercadoPinnacle: "Asian Handicap", evento: base.evento }),
    ).toBe("1 (+0.5) [Time 1]"); // A linha completa tem números extras; não encurtar o contrato.
  });
});

describe("matchTeamSide e matchMoneylineSelection — rótulo numerado de lado", () => {
  it("rótulo numerado de lado é o MESMO dado nas duas bordas de seleção", () => {
    // Se `matchMoneylineSelection` aceitar "Vencedor da Luta 1" e
    // `matchTeamSide` devolver null para a mesma string, a de handicap fica
    // sem lado.
    for (const escopo of SIDE_SCOPE_NOUNS) {
      for (const prefixo of ["Vencedor", "Ganhador"]) {
        const casa = `${prefixo} da ${escopo} 1`;
        const fora = `${prefixo} do ${escopo} 2`;
        expect(matchTeamSide(casa, base.evento), casa).toBe("home");
        expect(matchMoneylineSelection(casa, base.evento), casa).toBe("home");
        expect(matchTeamSide(fora, base.evento), fora).toBe("away");
        expect(matchMoneylineSelection(fora, base.evento), fora).toBe("away");
      }
    }
    expect(
      pinnacleizeSelecao({ selecao: "Vencedor da Luta 1 +0.5", mercadoPinnacle: "Asian Handicap", evento: "Silva vs Sonnen" }),
    ).toBe("Silva +0.5");
    expect(
      pinnacleizeSelecao({ selecao: "Vencedor da Série - 1", mercadoPinnacle: "Moneyline", evento: "FURIA vs MIBR" }),
    ).toBe("FURIA");
  });

  it("`jogo N` é unidade, nunca lado — fail-closed nas duas bordas", () => {
    // `matchMoneylineSelection` e a irmã têm de recusar "Vencedor do Jogo 1"
    // juntas: se uma aceitasse, a aposta no jogo 1 resolveria `home` e
    // liquidaria pelo placar da partida inteira.
    expect(SIDE_SCOPE_NOUNS as readonly string[]).not.toContain("jogo");
    for (const selecao of ["Vencedor do Jogo 1", "Ganhador do Jogo 2", "Game Winner 1"]) {
      expect(matchMoneylineSelection(selecao, base.evento), selecao).toBeNull();
      expect(matchTeamSide(selecao, base.evento), selecao).toBeNull();
    }
    // O separador explícito é a procedência de que o número é o LADO — é o que
    // separa estes dos de cima.
    expect(matchMoneylineSelection("Vencedor do Jogo - 1", base.evento)).toBe("home");
    expect(matchMoneylineSelection("Game Winner: 2", base.evento)).toBe("away");
  });
});

describe("matchMoneylineSelection", () => {
  it("reconhece 1X2 com rótulo delimitado sem capturar números arbitrários", () => {
    expect(matchMoneylineSelection("1 (FT)", base.evento)).toBe("home");
    expect(matchMoneylineSelection("Resultado Final - 1", base.evento)).toBe("home");
    expect(matchMoneylineSelection("Resultado da Partida - 1", base.evento)).toBe("home");
    expect(matchMoneylineSelection("Ganhador da Partida: 2", base.evento)).toBe("away");
    expect(matchMoneylineSelection("Vencedor do Confronto: 1", base.evento)).toBe("home");
    expect(matchMoneylineSelection("Vencedor do Encontro: 2", base.evento)).toBe("away");
    expect(matchMoneylineSelection("Vencedor: 2", base.evento)).toBe("away");
    expect(matchMoneylineSelection("Resultado do Jogo: X", base.evento)).toBe("draw");
    expect(matchMoneylineSelection("1 (TR)", base.evento)).toBe("home");
    expect(matchMoneylineSelection("1 - Tempo Regulamentar", base.evento)).toBe("home");
    expect(matchMoneylineSelection("Jogo 1", base.evento)).toBeNull();
    expect(matchMoneylineSelection("Empate anula a aposta", base.evento)).toBeNull();
    expect(matchMoneylineSelection("Flamengo DNB", base.evento)).toBeNull();
  });
});

describe("matchDrawNoBetSelection / matchDoubleChanceSelection", () => {
  it("aceita novas formas DNB em prefixo e sufixo", () => {
    expect(matchDrawNoBetSelection("Empate não tem aposta - 1", base.evento)).toBe("home");
    expect(matchDrawNoBetSelection("Empate sem aposta: 2", base.evento)).toBe("away");
    expect(matchDrawNoBetSelection("1 (Empate não tem aposta)", base.evento)).toBe("home");
    expect(matchDrawNoBetSelection("2 (Empate sem aposta)", base.evento)).toBe("away");
    expect(matchDrawNoBetSelection("Time 1 (Empate não vale)", base.evento)).toBe("home");
    expect(matchDrawNoBetSelection("Empate devolve o valor - 1", base.evento)).toBe("home");
    expect(matchDrawNoBetSelection("Empate anula a aposta de 2", base.evento)).toBe("away");
    expect(matchDrawNoBetSelection("1 (Empate devolve o valor)", base.evento)).toBe("home");
    expect(matchDrawNoBetSelection("2 - Empate anula o valor", base.evento)).toBe("away");
    expect(matchDrawNoBetSelection("Empate cancela a aposta - 1", base.evento)).toBe("home");
    expect(matchDrawNoBetSelection("2 (Empate nulo)", base.evento)).toBe("away");
  });

  it("remove prefixos alternativos de Dupla Chance", () => {
    expect(matchDoubleChanceSelection("Dupla Hipótese - 1X", base.evento)).toEqual([
      "home",
      "draw",
    ]);
    expect(matchDoubleChanceSelection("Hipótese Dupla: X2", base.evento)).toEqual([
      "draw",
      "away",
    ]);
    expect(matchDoubleChanceSelection("1X (Dupla Chance)", base.evento)).toEqual([
      "home",
      "draw",
    ]);
    expect(matchDoubleChanceSelection("X2 - Chance Dupla", base.evento)).toEqual([
      "draw",
      "away",
    ]);
    expect(matchDoubleChanceSelection("X/2 (Chance Dupla)", base.evento)).toEqual([
      "draw",
      "away",
    ]);
    expect(matchDoubleChanceSelection("1/2 (Dupla Chance)", base.evento)).toEqual([
      "home",
      "away",
    ]);
  });

  it("DNB sem risco/bet e Dupla Chance alternativa/seleção", () => {
    expect(matchDrawNoBetSelection("Empate sem risco - 1", base.evento)).toBe("home");
    expect(matchDrawNoBetSelection("Devolução da bet no empate - 1", base.evento)).toBe("home");
    expect(matchDoubleChanceSelection("Dupla Alternativa: 1X", base.evento)).toEqual(["home", "draw"]);
    expect(matchDoubleChanceSelection("Dupla Seleção: X2", base.evento)).toEqual(["draw", "away"]);
    // "Aposta sem risco" é promoção (free bet), não DNB: o estado só vale
    // depois da palavra "empate".
    expect(isScoreResolvableMarket({ mercado: "Aposta sem risco", selecao: "Flamengo" })).toBe(false);
  });

  it("DNB financeiro (saldo/patrimônio/montante/verba) e Dupla Variante", () => {
    for (const objeto of ["saldo", "patrimônio", "montante", "capital"]) {
      expect(matchDrawNoBetSelection(`Empate devolve o ${objeto} - 1`, base.evento), objeto).toBe("home");
      expect(
        isScoreResolvableMarket({ mercado: `Devolução do ${objeto} no empate`, selecao: "Flamengo" }),
        objeto,
      ).toBe(true);
    }
    expect(matchDrawNoBetSelection("Empate devolve a verba - 2", base.evento)).toBe("away");
    expect(matchDoubleChanceSelection("Dupla Variante: 1X", base.evento)).toEqual(["home", "draw"]);
    expect(
      pinnacleizeSelecao({ selecao: "Dupla Variante: 1X", mercadoPinnacle: "Double Chance", evento: base.evento }),
    ).toBe("Flamengo or Draw");
  });
});

describe("resolveResultFromScore — moneyline", () => {
  const ml = (selecao: string, homeScore: number, awayScore: number) =>
    resolveResultFromScore({
      ...base,
      mercado: "Moneyline",
      selecao,
      homeScore,
      awayScore,
    });

  it("seleção pelo nome canônico do time", () => {
    expect(ml("Flamengo", 2, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(ml("Palmeiras", 2, 0)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
  });

  it("Draw e códigos 1/X/2", () => {
    expect(ml("Draw", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(ml("Tie", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(ml("1", 1, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(ml("2", 1, 0)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(matchMoneylineSelection("Tie No Bet", base.evento)).toBeNull();
  });

  it("Money Line – Match (rótulo canônico de esports) liquida", () => {
    expect(resolveResultFromScore({
      evento: "Time A vs Time B", odds: 2, stake: 1,
      mercado: "Money Line – Match", selecao: "Time A", homeScore: 2, awayScore: 1,
    })).toMatchObject({ ok: true, status: "WON" });
  });

  it("aceita labels PT-BR de vencedor da partida, mas não outright", () => {
    for (const mercado of [
      "Para Vencer a Partida",
      "Para Ganhar a Partida",
      "Para Ganhar",
      "Para Vencer o Jogo",
      "Para Vencer a Luta",
      "Para Vencer o Match",
      "Vencedor do Confronto",
      "Vencedor do Encontro",
    ]) {
      expect(resolveResultFromScore({
        ...base,
        mercado,
        selecao: "Flamengo",
        homeScore: 2,
        awayScore: 1,
      }), mercado).toMatchObject({ ok: true, status: "WON" });
    }
    expect(resolveResultFromScore({
      ...base,
      mercado: "Para Vencer o Campeonato",
      selecao: "Flamengo",
      homeScore: 2,
      awayScore: 1,
    })).toMatchObject({ ok: false });
  });
});

describe("resolveResultFromScore — DNB e Dupla Chance", () => {
  it("Draw No Bet: empate → VOID; vitória do lado → WON", () => {
    const dnb = (selecao: string, h: number, a: number) =>
      resolveResultFromScore({
        ...base,
        mercado: "Draw No Bet",
        selecao,
        homeScore: h,
        awayScore: a,
      });
    expect(dnb("Flamengo", 1, 1)).toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
    expect(dnb("Flamengo", 2, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(dnb("Palmeiras", 2, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(matchDrawNoBetSelection("1 (Draw No Bet)", base.evento)).toBe("home");
    expect(dnb("1 (Draw No Bet)", 2, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(dnb("2 - Tie No Bet", 2, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
  });

  it("aceita Empate Devolve e prefixos explícitos de Dupla Chance", () => {
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Empate Devolve",
        selecao: "Flamengo",
        homeScore: 1,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
    expect(matchDoubleChanceSelection("Dupla Chance 1X", base.evento)).toEqual([
      "home",
      "draw",
    ]);
    expect(matchDoubleChanceSelection("DC X2", base.evento)).toEqual(["draw", "away"]);
  });

  it("Dupla Chance: 1X cobre vitória da casa e empate", () => {
    const dc = (selecao: string, h: number, a: number) =>
      resolveResultFromScore({
        ...base,
        mercado: "Double Chance",
        selecao,
        homeScore: h,
        awayScore: a,
      });
    expect(dc("1X", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(dc("1X", 0, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(dc("X2", 0, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(dc("12", 1, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(dc("1 OU EMPATE", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(dc("1 ou X", 0, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(dc("X ou 2", 0, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(dc("Casa e Empate", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(dc("Casa y Empate", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(dc("Home and Draw", 0, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(dc("Casa, Empate", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(dc("1 e X", 0, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(dc("Casa & Fora", 0, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(matchDoubleChanceSelection("Sporting e Benfica", "Sporting vs Benfica")).toBeNull();
  });

  it("resolve chance dupla textual pelos dois nomes do evento", () => {
    expect(resolveResultFromScore({
      ...base,
      mercado: "Double Chance",
      selecao: "Flamengo/Palmeiras",
      homeScore: 0,
      awayScore: 1,
    })).toMatchObject({ ok: true, status: "WON" });
  });

  it("DNB por reembolso/estorno resolve o lado em prefixo e sufixo", () => {
    expect(matchDrawNoBetSelection("Empate reembolsa - 1", base.evento)).toBe("home");
    expect(matchDrawNoBetSelection("2 (Empate estorna)", base.evento)).toBe("away");
    expect(matchDrawNoBetSelection("Reembolso no Empate - 1", base.evento)).toBe("home");
    expect(matchDrawNoBetSelection("2 (Devolução no Empate)", base.evento)).toBe("away");
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Empate Reembolsa",
        selecao: "Flamengo",
        homeScore: 1,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Reembolso no Empate",
        selecao: "1",
        homeScore: 2,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    // A palavra "empate" aqui descreve a REGRA, não uma seleção no empate.
    expect(matchMoneylineSelection("Empate reembolsa a aposta", base.evento)).toBeNull();
  });

  it("Dupla Chance por oportunidade/possibilidade resolve as duas saídas", () => {
    expect(matchDoubleChanceSelection("Dupla Oportunidade: 1X", base.evento)).toEqual([
      "home",
      "draw",
    ]);
    expect(matchDoubleChanceSelection("X2 (Dupla Possibilidade)", base.evento)).toEqual([
      "draw",
      "away",
    ]);
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Dupla Oportunidade",
        selecao: "1X",
        homeScore: 1,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("DNB com qualificador de valor/investimento resolve o lado", () => {
    for (const selecao of [
      "Empate devolve o investimento - 1",
      "1 (Empate anula o investimento)",
      "Devolução do valor no empate - 1",
      "1 (Reembolso do valor em caso de empate)",
    ]) {
      expect(matchDrawNoBetSelection(selecao, base.evento), selecao).toBe("home");
    }
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Devolução do valor no empate",
        selecao: "1",
        homeScore: 2,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("DNB com 'capital' e Dupla Chance por escolha/opção", () => {
    expect(matchDrawNoBetSelection("Empate devolve o capital - 1", base.evento)).toBe("home");
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Devolução do capital no empate",
        selecao: "1",
        homeScore: 1,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
    expect(matchDoubleChanceSelection("Dupla Escolha: 1X", base.evento)).toEqual(["home", "draw"]);
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Dupla Opção",
        selecao: "1X",
        homeScore: 1,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("preserva DNB quando Moneyline é apenas o rótulo genérico", () => {
    const input = { ...base, mercado: "Moneyline", selecao: "Flamengo DNB" };
    expect(marketKindOf(input.mercado, input.selecao, input.evento)).toBe("draw_no_bet");
    expect(classifyScoreMarket(normalizeStr(input.mercado), normalizeStr(input.selecao), input.evento))
      .toBe("draw_no_bet");
    expect(isScoreResolvableMarket(input)).toBe(true);
    expect(resolveResultFromScore({ ...input, homeScore: 2, awayScore: 1 }))
      .toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(resolveResultFromScore({ ...input, homeScore: 1, awayScore: 1 }))
      .toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
    expect(resolveResultFromScore({ ...input, homeScore: 0, awayScore: 1 }))
      .toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });

    // Mercado explícito contraditório continua vencendo e falha fechado em vez
    // de a seleção reclassificar qualquer handicap como DNB.
    expect(marketKindOf("Asian Handicap", "Flamengo DNB", input.evento)).toBe("spread");
  });
});

describe("resolveResultFromScore — token (casa/home/away/draw) dentro do nome do time não inverte o lado", () => {
  // "Casa Pia" é um clube (visitante aqui); o token "casa" não pode marcá-lo como mandante.
  const evCP = "Benfica vs Casa Pia";

  it("Moneyline 'Casa Pia' (visitante) vencendo 0-2 → WON", () => {
    expect(
      resolveResultFromScore({ ...base, evento: evCP, mercado: "Moneyline", selecao: "Casa Pia", homeScore: 0, awayScore: 2 }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("Asian Handicap 'Casa Pia +0.5' 0-2 → WON (lado correto)", () => {
    expect(
      resolveResultFromScore({ ...base, evento: evCP, mercado: "Asian Handicap", selecao: "Casa Pia +0.5", homeScore: 0, awayScore: 2 }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("Draw No Bet 'Casa Pia' 0-2 → WON", () => {
    expect(
      resolveResultFromScore({ ...base, evento: evCP, mercado: "Draw No Bet", selecao: "Casa Pia", homeScore: 0, awayScore: 2 }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("token genérico 'Casa' (sem colisão de nome) segue = mandante", () => {
    expect(
      resolveResultFromScore({ ...base, evento: "Benfica vs Porto", mercado: "Moneyline", selecao: "Casa", homeScore: 2, awayScore: 0 }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });
});

describe("moneyline: o lado só vale com o nome do time e palavras de 'vence'", () => {
  const ml = (selecao: string, homeScore: number, awayScore: number) =>
    resolveResultFromScore({ ...base, mercado: "Money Line – Match", selecao, homeScore, awayScore });

  it.each([
    "Palmeiras não perde",
    "Flamengo não vence",
    "Flamengo perde",
    "Contra Flamengo",
    "Flamengo marca",
    "Palmeiras ganha ou empata",
  ])("'%s' não vira vitória do time: recusa em vez de liquidar", (selecao) => {
    expect(matchMoneylineSelection(selecao, base.evento)).toBeNull();
    expect(ml(selecao, 1, 1)).toEqual({ ok: false, reason: "ambiguous_selection" });
    expect(ml(selecao, 1, 0)).toEqual({ ok: false, reason: "ambiguous_selection" });
  });

  it("a vitória combinada com outra condição sai do motor de placar", () => {
    expect(matchMoneylineSelection("Flamengo vence e ambas marcam", base.evento)).toBeNull();
    expect(ml("Flamengo vence e ambas marcam", 1, 0)).toEqual({ ok: false, reason: "unsupported_market" });
  });

  it.each([
    ["Flamengo", "home"],
    ["Flamengo ML", "home"],
    ["Flamengo para vencer", "home"],
    ["Palmeiras vence", "away"],
    ["Palmeiras vence o 1º tempo", "away"],
    ["Casa", "home"],
    ["Time 2", "away"],
    ["Empate", "draw"],
  ] as const)("'%s' continua sendo %s", (selecao, side) => {
    expect(matchMoneylineSelection(selecao, base.evento)).toBe(side);
  });

  it("nome abreviado e sufixo estadual continuam valendo", () => {
    expect(matchMoneylineSelection("Atletico Mineiro", "Atlético-MG vs Cruzeiro")).toBe("home");
    expect(matchMoneylineSelection("Inter", "Internacional vs Grêmio")).toBe("home");
  });

  it("a canonicalização não apaga o complemento que muda a aposta", () => {
    expect(pinnacleizeSelecao({ selecao: "Palmeiras não perde", mercadoPinnacle: "Money Line – Match", evento: base.evento }))
      .toBe("Palmeiras não perde");
  });
});

describe("moneyline: nome gravado mais longo ou mais curto que o do evento", () => {
  it.each([
    ["Flamengo RJ", "Flamengo vs Vasco", "home"], ["Flamengo", "Flamengo RJ vs Vasco", "home"],
    ["Vasco da Gama", "Flamengo vs Vasco", "away"], ["Vasco", "Flamengo vs Vasco da Gama", "away"],
    ["Red Bull Bragantino", "Bragantino vs Santos", "home"], ["Bragantino", "Red Bull Bragantino vs Santos", "home"],
    ["Mainz 05", "Mainz vs Koln", "home"], ["Mainz", "Mainz 05 vs Koln", "home"],
    ["Atlético-MG", "Atlético Mineiro vs Cruzeiro", "home"], ["Atlético Mineiro", "Atlético-MG vs Cruzeiro", "home"],
    ["Athletico-PR", "Athletico Paranaense vs Coritiba", "home"],
    ["Borussia Dortmund", "Dortmund vs Bayern", "home"], ["Dortmund", "Borussia Dortmund vs Bayern", "home"],
    ["Inter de Milão", "Inter vs Milan", "home"], ["Inter", "Inter de Milão vs Milan", "home"],
    ["G2 Esports", "G2 vs FaZe", "home"],
    ["Alcaraz Garfia C.", "Alcaraz C. vs Sinner J.", "home"], ["Alcaraz C.", "Alcaraz Garfia C. vs Sinner J.", "home"],
    ["Lakers incl. OT", "Lakers vs Celtics", "home"], ["Flamengo (inc OT)", "Flamengo vs Vasco", "home"],
    ["Flamengo 90 min", "Flamengo vs Vasco", "home"], ["Flamengo (1)", "Flamengo vs Vasco", "home"],
    ["1 - Flamengo", "Flamengo vs Vasco", "home"],
  ] as const)("liquidação e CLV leem '%s' em %s como %s", (selecao, evento, side) => {
    expect(matchMoneylineSelection(selecao, evento)).toBe(side);
    // Com escopo próprio ("90 min", "inc OT") a canonicalização preserva a seleção para o período ser conferido.
    const [home, away] = evento.split(" vs ");
    const expected = marketPeriodOf(selecao) === "FT" && !marketIncludesExtraTime(selecao) ? (side === "home" ? home : away) : selecao;
    expect(pinnacleizeSelecao({ selecao, mercadoPinnacle: "Money Line – Match", evento })).toBe(expected);
  });

  it.each([
    ["Flamengo (2)", "Flamengo vs Vasco"],
    ["Flamengo Vasco", "Flamengo vs Vasco"],
    ["Vasco da Gama não perde", "Flamengo vs Vasco da Gama"],
  ])("'%s' contradiz o lado ou nomeia o outro time: sem lado", (selecao, evento) => {
    expect(matchMoneylineSelection(selecao, evento)).toBeNull();
  });

  it("o leitor por regra (strict) aceita o nome curto e o sufixo, e deixa o resto para a IA", () => {
    const strict = { strict: true };
    expect(matchMoneylineSelection("Flamengo RJ", "Flamengo vs Vasco", strict)).toBe("home");
    expect(matchMoneylineSelection("Vasco", "Flamengo vs Vasco da Gama", strict)).toBe("away");
    expect(matchMoneylineSelection("Flamengo (1)", "Flamengo vs Vasco", strict)).toBe("home");
    expect(matchMoneylineSelection("Borussia Dortmund", "Dortmund vs Bayern", strict)).toBeNull();
  });
});

describe("moneyline: a sobra que pede outro mercado recusa", () => {
  const evento = "Flamengo vs Vasco";
  const settle = (mercado: string, selecao: string, homeScore: number, awayScore: number) =>
    resolveResultFromScore({ mercado, selecao, evento, homeScore, awayScore, odds: 2, stake: 1 });

  it.each([
    ["Vencedor", "Flamengo (-1.5)"],
    ["Resultado Final", "Flamengo -1.5"],
    ["Resultado Final", "Flamengo −1"],
    ["Resultado Final", "Flamengo 2x0"],
    ["Resultado Final", "Flamengo 2 x 0"],
    ["Resultado Final", "Flamengo 2-0"],
    ["Vencedor", "Flamengo +0.5"],
    ["Vencedor", "Flamengo 1,5"],
    ["Vencedor", "Vasco -1"],
    ["Vencedor", "Flamengo para se classificar"],
    ["Vencedor", "Flamengo classificado"],
    ["Vencedor", "Flamengo campeão"],
    ["Vencedor", "Flamengo a zero"],
  ])("%s / %s", (mercado, selecao) => {
    expect(matchMoneylineSelection(selecao, evento)).toBeNull();
    expect(matchMoneylineSelection(selecao, evento, { strict: true })).toBeNull();
    for (const [homeScore, awayScore] of [[2, 1], [1, 1], [1, 2]] as const) {
      expect(settle(mercado, selecao, homeScore, awayScore)).toEqual({ ok: false, reason: "unsupported_market" });
    }
    expect(isScoreResolvableMarket({ mercado, selecao, evento })).toBe(false);
  });

  it("o número solto depois do nome não é a marca do lado", () => {
    expect(matchMoneylineSelection("Flamengo 1", evento)).toBeNull();
    expect(matchMoneylineSelection("Flamengo - 1", evento)).toBeNull();
    expect(matchMoneylineSelection("Vasco 2", evento)).toBeNull();
  });

  it.each([
    ["Mainz 05", "Mainz 05 vs Schalke 04", "home"],
    ["Schalke 04", "Mainz 05 vs Schalke 04", "away"],
    ["Schalke 04", "Mainz vs Schalke", "away"],
    ["1. FC Köln", "1. FC Köln vs Bayern", "home"],
    ["Flamengo Sub-20", "Flamengo Sub-20 vs Vasco Sub-20", "home"],
    ["Vasco U20", "Flamengo U20 vs Vasco U20", "away"],
    ["Flamengo 1X2", "Flamengo vs Vasco", "home"],
    ["(1) Flamengo", "Flamengo vs Vasco", "home"],
    ["Vasco (2)", "Flamengo vs Vasco", "away"],
    ["Time 1", "Flamengo vs Vasco", "home"],
  ] as const)("o número do nome, da categoria e da marca do lado não é linha: %s", (selecao, eventoDoCaso, side) => {
    expect(matchMoneylineSelection(selecao, eventoDoCaso)).toBe(side);
    expect(classifyScoreMarket("vencedor", normalizeStr(selecao), eventoDoCaso)).toBe("moneyline");
  });
});
