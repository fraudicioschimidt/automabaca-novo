import { describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/client";
import { classifyScoreMarket, isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { marketKindOf } from "@/src/domain/mercados/classify";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { normalizeStr } from "@/src/domain/text";

const base = {
  evento: "Flamengo vs Palmeiras",
  odds: 2.0,
  stake: 1,
};

describe("resolveResultFromScore — totais", () => {
  const total = (selecao: string, homeScore: number, awayScore: number) =>
    resolveResultFromScore({
      ...base,
      mercado: "Total",
      selecao,
      homeScore,
      awayScore,
    });

  it("Over 2.5 com 3 gols → WON; com 2 → LOST", () => {
    expect(total("Over 2.5", 2, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(total("Over 2.5", 1, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
  });

  it("prefixo + em mercado Total é Over, sem coagir handicap desconhecido", () => {
    expect(total("+2.5", 2, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(total("+2.5 gols", 1, 1)).toEqual({
      ok: true,
      status: BetStatus.LOST,
      lucro: -1,
    });
  });

  it.each([
    ["Jogo O 2.5", 2, 1, BetStatus.WON],
    ["FT O 2.5", 1, 1, BetStatus.LOST],
    ["Jogo Over 2.5", 2, 1, BetStatus.WON],
    ["FT Under 2.5", 1, 1, BetStatus.WON],
    ["Partida U 2.5", 2, 1, BetStatus.LOST],
  ] as const)("o escopo do jogo antes da linha não é sujeito: %s", (selecao, homeScore, awayScore, status) => {
    expect(total(selecao, homeScore, awayScore)).toMatchObject({ ok: true, status });
  });

  it("linha cheia: Over 2 com 2 gols → VOID", () => {
    expect(total("Over 2", 1, 1)).toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
  });

  it("linha cheia Under: 'Under 3' com 3 gols → VOID (reembolso)", () => {
    // Vancouver FC 2 × 1 Pacific (3 gols) — Under 3.0 bate na linha = push.
    expect(total("Under 3", 2, 1)).toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
    // e nas vizinhanças: 2 gols → WON; 4 gols → LOST (nunca meia-perda numa linha cheia)
    expect(total("Under 3", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(total("Under 3", 2, 2)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
  });

  it("quarter: Under 2.25 com 2 gols → HALF_WON; Over 2.25 com 2 → HALF_LOST", () => {
    expect(total("Under 2.25", 1, 1)).toEqual({
      ok: true,
      status: BetStatus.HALF_WON,
      lucro: 0.5,
    });
    expect(total("Over 2.25", 2, 0)).toEqual({
      ok: true,
      status: BetStatus.HALF_LOST,
      lucro: -0.5,
    });
  });

  it("'Mais de 2,5' em PT com vírgula decimal", () => {
    expect(total("Mais de 2,5", 3, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("entende acima/abaixo, abreviação O e +gols", () => {
    expect(total("Acima de 2.5", 2, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(total("Abaixo 3.5", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(total("O 2.5", 2, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(total("+2.5 gols", 1, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
  });

  it("Linha de Runs/Corridas liquida pelo placar de beisebol", () => {
    for (const mercado of ["Linha de Runs", "Linha de Corridas", "Total Runs"]) {
      expect(
        resolveResultFromScore({
          ...base,
          esporte: "Baseball",
          mercado,
          selecao: "Over 8.5",
          homeScore: 5,
          awayScore: 4,
        }),
        mercado,
      ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    }
    // Prop de beisebol continua fora do placar.
    expect(
      resolveResultFromScore({
        ...base,
        esporte: "Baseball",
        mercado: "Home Runs",
        selecao: "Over 1.5",
        homeScore: 5,
        awayScore: 4,
      }),
    ).toEqual({ ok: false, reason: "stat_qualifier" });
  });
});

describe("resolveResultFromScore — 'Asian Total' é total, não handicap", () => {
  // A palavra "asian" não pode capturar como handicap um mercado de TOTAL: sem
  // lado na seleção, a aposta encalharia em ambiguous_selection. Total é
  // classificado antes de handicap.
  const r = (mercado: string, selecao: string, h: number, a: number) =>
    resolveResultFromScore({ ...base, mercado, selecao, homeScore: h, awayScore: a });

  it("'Asian Total' Over 2.5 com 3 gols → WON (resolve como total)", () => {
    expect(r("Asian Total", "Over 2.5", 2, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("'Asian Over/Under' Under 2.5 com 1 gol → WON", () => {
    expect(r("Asian Over/Under", "Under 2.5", 1, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("'Asian Goal Line' Over 2.75 com 4 gols → WON (quarter, ambos componentes ganham)", () => {
    expect(r("Asian Goal Line", "Over 2.75", 3, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("regressão: 'Asian Handicap' (sem over/under) segue resolvendo como handicap", () => {
    // casa -0.5 vence por 1 → WON; prova que o reorder não captura handicap como total.
    expect(r("Asian Handicap", "Flamengo -0.5", 2, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("seleção Over em mercado de handicap não é liquidada como total", () => {
    expect(r("Handicap – Match", "Over 2.5", 0, 0)).toEqual({
      ok: false,
      reason: "ambiguous_selection",
    });
  });
});

describe("resolveResultFromScore — totais com vírgula: split Bet365 × decimal em português", () => {
  it("split colado vira meia-linha; decimal PT continua uma linha só", () => {
    // "2.0,2.5" são DUAS linhas (média 2.25); "2,5" é UMA linha (2.5). A regra
    // que separa os dois casos é o ponto decimal ANTES da vírgula.
    const base = { evento: "A vs B", odds: 2, stake: 1, mercado: "Total – Match" };
    expect(resolveResultFromScore({ ...base, selecao: "Over 2.0,2.5", homeScore: 1, awayScore: 1 }))
      .toMatchObject({ ok: true, status: "HALF_LOST" });
    expect(resolveResultFromScore({ ...base, selecao: "Over 2,5", homeScore: 2, awayScore: 1 }))
      .toMatchObject({ ok: true, status: "WON" });
    expect(resolveResultFromScore({
      ...base,
      mercado: "Asian Total",
      selecao: "Over 2,2.5",
      homeScore: 2,
      awayScore: 0,
    })).toMatchObject({ ok: true, status: "HALF_LOST" });
  });

  it("o dígito do meio-tempo não entra na linha", () => {
    // Lido, "0,5 1ºT" seria a linha dividida 0.5/1, e o HT 1-0 daria HALF_WON.
    const base = { evento: "A vs B", odds: 1.4, stake: 1, esporte: "Soccer", scorePeriod: "HT" as const };
    for (const selecao of ["Over 0,5 1ºT", "Over 0,5 (1°T)", "Over 0,5 1T", "Over 0,5 1º tempo", "Over 0,5 1st half", "Over 0,5 H1"]) {
      expect(resolveResultFromScore({ ...base, mercado: "Total", selecao, homeScore: 1, awayScore: 0 }), selecao)
        .toEqual({ ok: true, status: BetStatus.WON, lucro: 0.4 });
    }
    expect(resolveResultFromScore({ ...base, mercado: "Team Total", evento: "Flamengo vs Palmeiras", selecao: "Flamengo Over 0,5 1ºT", homeScore: 1, awayScore: 0 }))
      .toMatchObject({ ok: true, status: BetStatus.WON });
    expect(resolveResultFromScore({ ...base, mercado: "Total", selecao: "Over 1,5 2ºT", scorePeriod: "SECOND_HALF", homeScore: 2, awayScore: 0 }))
      .toEqual({ ok: true, status: BetStatus.WON, lucro: 0.4 });
    // O período no rótulo também não é linha: sem ela na seleção, falta a linha.
    expect(resolveResultFromScore({ ...base, mercado: "Total 1ºT", selecao: "Over", homeScore: 1, awayScore: 0 }))
      .toEqual({ ok: false, reason: "missing_line" });
  });
});

describe("resolveResultFromScore — total por equipe (team total)", () => {
  it("Team Total usa gols do lado certo — não o agregado", () => {
    // placar 1-1: Flamengo (casa) fez 1 → Over 1.5 LOST; Over 0.5 WON.
    // Sem o kind próprio, casaria como total de jogo (2 gols) → WON errado.
    expect(
      resolveResultFromScore({
        mercado: "Team Total",
        selecao: "Flamengo Over 1.5",
        evento: "Flamengo vs Palmeiras",
        homeScore: 1,
        awayScore: 1,
        odds: 1.9,
        stake: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(
      resolveResultFromScore({
        mercado: "Team Total",
        selecao: "Flamengo Over 0.5",
        evento: "Flamengo vs Palmeiras",
        homeScore: 1,
        awayScore: 1,
        odds: 1.9,
        stake: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 0.9 });
    expect(
      resolveResultFromScore({
        mercado: "Team Total",
        selecao: "Palmeiras Over 0.5",
        evento: "Flamengo vs Palmeiras",
        homeScore: 2,
        awayScore: 0,
        odds: 1.9,
        stake: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });

    for (const mercado of [
      "Total de Gols por Time",
      "Total de Gols da Equipe",
      "Total por Time",
    ]) {
      expect(resolveResultFromScore({
        mercado,
        selecao: "Flamengo Over 1.5",
        evento: "Flamengo vs Palmeiras",
        homeScore: 0,
        awayScore: 2,
        odds: 1.9,
        stake: 1,
      }), mercado).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    }
  });

  it("Team Total aceita linha no mercado sem inventar lado", () => {
    const input = {
      evento: "Flamengo vs Vasco",
      homeScore: 2,
      awayScore: 0,
      odds: 1.9,
      stake: 1,
    };

    expect(resolveResultFromScore({
      ...input,
      mercado: "Home Team Total 1.5",
      selecao: "Over",
    })).toEqual({ ok: true, status: BetStatus.WON, lucro: 0.9 });
    // Sem time alvo, a linha no mercado não autoriza assumir mandante nem
    // visitante.
    expect(resolveResultFromScore({
      ...input,
      mercado: "Total do Time 1.5",
      selecao: "Over",
    })).toEqual({ ok: false, reason: "ambiguous_selection" });
    // Só o nome do time não informa a direção.
    expect(resolveResultFromScore({
      ...input,
      mercado: "Total do Time 1.5",
      selecao: "Flamengo",
    })).toEqual({ ok: false, reason: "ambiguous_selection" });

    // Dígitos do nome do clube não participam da linha do mercado.
    expect(resolveResultFromScore({
      ...input,
      evento: "Mainz 05 vs Schalke 04",
      mercado: "Home Team Total 1.5",
      selecao: "Over",
    })).toEqual({ ok: true, status: BetStatus.WON, lucro: 0.9 });
    expect(resolveResultFromScore({
      ...input,
      mercado: "Home Team Total 1.3",
      selecao: "Over",
    })).toEqual({ ok: false, reason: "invalid_line" });
  });

  it("Total comum do jogo continua resolvendo normalmente", () => {
    expect(
      resolveResultFromScore({
        mercado: "Total",
        selecao: "Over 1.5",
        evento: "Flamengo vs Palmeiras",
        homeScore: 1,
        awayScore: 1,
        odds: 1.9,
        stake: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: expect.closeTo(0.9, 6) });
  });

  it("reconhece team total em labels e na seleção nomeada", () => {
    expect(resolveResultFromScore({
      ...base,
      mercado: "Total Goals",
      selecao: "Flamengo Over 1.5",
      homeScore: 1,
      awayScore: 1,
      odds: 1.9,
    })).toMatchObject({ ok: true, status: "LOST" });
    expect(resolveResultFromScore({
      ...base,
      mercado: "Home Team Total Goals",
      selecao: "Over 1.5",
      homeScore: 1,
      awayScore: 2,
      odds: 1.9,
    })).toMatchObject({ ok: true, status: "LOST" });
    expect(resolveResultFromScore({
      evento: "Lakers vs Celtics",
      mercado: "Total Points",
      selecao: "Lakers Over 112.5",
      homeScore: 110,
      awayScore: 105,
      odds: 1.9,
      stake: 1,
    })).toMatchObject({ ok: true, status: "LOST" });
    expect(resolveResultFromScore({
      ...base,
      mercado: "Total de Gols do Mandante",
      selecao: "Over 1.5",
      homeScore: 0,
      awayScore: 3,
      odds: 1.9,
    })).toMatchObject({ ok: true, status: "LOST" });

    for (const mercado of [
      "Pontos do Time",
      "Pontos da Equipe",
      "Runs do Time",
      "Corridas da Equipe",
    ]) {
      expect(classifyScoreMarket(mercado, "Over 4.5"), mercado).toBe("team_total");
    }
    expect(resolveResultFromScore({
      evento: "Lakers vs Celtics",
      esporte: "Basketball",
      mercado: "Pontos do Time",
      selecao: "Lakers Over 110.5",
      homeScore: 112,
      awayScore: 105,
      odds: 1.9,
      stake: 1,
    })).toMatchObject({ ok: true, status: "WON" });
    expect(resolveResultFromScore({
      evento: "Yankees vs Red Sox",
      esporte: "Baseball",
      mercado: "Runs do Time",
      selecao: "Yankees Under 4.5",
      homeScore: 4,
      awayScore: 2,
      odds: 1.9,
      stake: 1,
    })).toMatchObject({ ok: true, status: "WON" });
  });

  it("total de gols em PT usa o placar do TIME nomeado, não o agregado", () => {
    // Risco de dinheiro: se a forma PT caísse em total de jogo, 0x3 devolveria
    // WON para quem apostou no time que não marcou.
    const pt = resolveResultFromScore({
      ...base,
      mercado: "Total de Gols",
      selecao: "Flamengo Over 1.5",
      homeScore: 0,
      awayScore: 3,
    });
    const en = resolveResultFromScore({
      ...base,
      mercado: "Total Goals",
      selecao: "Flamengo Over 1.5",
      homeScore: 0,
      awayScore: 3,
    });
    expect(pt).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(pt).toEqual(en);
    expect(classifyScoreMarket("total de gols", "flamengo over 1.5")).toBe("team_total");
    // Sem time na seleção continua sendo o total do jogo.
    expect(classifyScoreMarket("total de gols", "over 2.5")).toBe("total");
    // O substantivo "gols" não abre porta para prop, período ou estatística:
    // os gates anteriores continuam recusando antes de classificar.
    for (const [mercado, selecao] of [
      ["Marcador de Gols", "Flamengo Over 0.5"],
      ["Gols do Jogador", "Flamengo Over 0.5"],
      ["Total de Gols (Escanteios)", "Over 9.5"],
      ["Total de Gols - 1º Tempo", "Over 1.5"],
    ] as const) {
      expect(
        isScoreResolvableMarket({ mercado, selecao, esporte: "Soccer" }),
        mercado,
      ).toBe(false);
      expect(
        resolveResultFromScore({ ...base, mercado, selecao, homeScore: 3, awayScore: 0 }).ok,
        mercado,
      ).toBe(false);
    }
    expect(
      resolveResultFromScore({
        ...base,
        mercado: "Total de Gols",
        selecao: "Over 2.5",
        homeScore: 0,
        awayScore: 3,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("time depois da linha continua sendo total POR EQUIPE, não do jogo", () => {
    // A seleção canonicalizada é o que chega ao settlement: perder o clube
    // transformava a aposta em total agregado e invertia o dinheiro.
    const selecao = pinnacleizeSelecao({
      selecao: "Over 1.5 Flamengo Gols",
      mercadoPinnacle: "Total de Gols",
      evento: base.evento,
    });
    expect(selecao).toBe("Flamengo Over 1.5");
    expect(
      resolveResultFromScore({ ...base, mercado: "Total de Gols", selecao, homeScore: 0, awayScore: 3 }),
    ).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(
      resolveResultFromScore({ ...base, mercado: "Total de Gols", selecao, homeScore: 2, awayScore: 0 }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("total nominal de corridas usa apenas o lado selecionado", () => {
    for (const [esporte, mercado, evento, selecao] of [
      ["Baseball", "Total de Corridas", "Yankees vs Red Sox", "Yankees Over 4.5"],
      ["Cricket", "Total Runs", "India vs Australia", "India Over 4.5"],
    ] as const) {
      expect(marketKindOf(mercado, selecao, evento), `${esporte} kind`).toBe("team_total");
      expect(resolveResultFromScore({
        mercado,
        selecao,
        evento,
        esporte,
        homeScore: 2,
        awayScore: 5,
        odds: 2,
        stake: 1,
      }), `${esporte} settlement`).toEqual({
        ok: true,
        status: BetStatus.LOST,
        lucro: -1,
      });
    }
  });
});

describe("resolveResultFromScore — ambas marcam (BTTS)", () => {
  it("BTTS resolve com homeScore/awayScore (ambos marcaram)", () => {
    const btts = (selecao: string, h: number, a: number) =>
      resolveResultFromScore({
        ...base,
        mercado: "Both Teams To Score",
        selecao,
        homeScore: h,
        awayScore: a,
      });
    expect(btts("Yes", 2, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(btts("Sim", 1, 0)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(btts("No", 1, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(btts("Não", 0, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(btts("Ambas Marcam", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(btts("Ambos Marcam", 1, 0)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(btts("Gol/Gol", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(btts("g/g", 1, 0)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(btts("Both Teams NOT to Score", 1, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(btts("Sem gol de ambos", 1, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(btts("Ambas não marcam", 0, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("'Ambas marcam no jogo' é o SIM: o 'no' é preposição", () => {
    const btts = (selecao: string, h: number, a: number) =>
      resolveResultFromScore({ ...base, mercado: "Both Teams To Score", selecao, homeScore: h, awayScore: a });
    expect(btts("Ambas marcam no jogo", 1, 1)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(btts("Ambos marcam no confronto", 1, 0)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(btts("BTTS - No", 1, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(btts("No BTTS", 1, 1)).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(btts("Sim e Não", 1, 1)).toEqual({ ok: false, reason: "ambiguous_selection" });
    expect(btts("Ambas marcam e Over 2.5", 1, 1)).toEqual({ ok: false, reason: "unsupported_market" });
  });

  it("o 'No' seguido de qualificador continua o Não", () => {
    const btts = (mercado: string, selecao: string, scorePeriod?: "HT") =>
      resolveResultFromScore({ ...base, mercado, selecao, esporte: "Soccer", homeScore: 1, awayScore: 1, scorePeriod });
    for (const selecao of ["BTTS No FT", "Both Teams to Score - No (FT)", "Ambas Marcam - No (FT)"]) {
      expect(btts("Both Teams To Score", selecao), selecao).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    }
    for (const selecao of ["BTTS No (1T)", "BTTS - No - 1T", "BTTS - No - 1º Tempo"]) {
      expect(btts("Both Teams To Score", selecao, "HT"), selecao).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    }
    expect(btts("Both Teams To Score", "Ambas marcam no 1º tempo", "HT")).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("o Sim com o 'no' antes do jogo, gravado pela captura, não perde num 1-1", () => {
    // O tipster apostou no Sim e ganhou; lido como o Não, sairia LOST.
    const capturedThenSettled = (selecao: string, scorePeriod?: "HT" | "SECOND_HALF") => resolveResultFromScore({
      ...base, mercado: "Both Teams to Score", esporte: "Soccer", homeScore: 1, awayScore: 1, scorePeriod,
      selecao: pinnacleizeSelecao({ selecao, mercadoPinnacle: "Both Teams to Score", evento: base.evento }),
    });
    for (const selecao of ["Ambas as equipes marcarão no jogo", "Ambos os times marcarão no jogo", "Gol/Gol no jogo"]) {
      expect(capturedThenSettled(selecao), selecao).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    }
    for (const selecao of ["Ambas marcam gol no jogo", "Ambas marcam gols no jogo", "Gol dos dois no jogo"]) {
      expect(capturedThenSettled(selecao), selecao).toEqual({ ok: false, reason: "ambiguous_selection" });
    }
    for (const selecao of ["Gol/Gol no 1º tempo", "Gol/Gol no 1T", "Gol/Gol no 1ºT", "Gol/Gol no HT", "BTTS no 1T", "Ambas no 1T", "Gol dos dois no 1T"]) {
      expect(capturedThenSettled(selecao, "HT"), selecao).toEqual({ ok: false, reason: "ambiguous_selection" });
    }
    for (const selecao of ["Gol/Gol no 2T", "BTTS no 2ºT"]) {
      expect(capturedThenSettled(selecao, "SECOND_HALF"), selecao).toEqual({ ok: false, reason: "ambiguous_selection" });
    }
    expect(capturedThenSettled("BTTS - No (1.85)")).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
  });

  it("ambas marcam em cada tempo não liquida pelo placar do jogo", () => {
    // 1-1 no fim pode ser 1-1 no 1º tempo e 0-0 no 2º, e aí a aposta perde.
    for (const selecao of [
      "Ambas marcam nos dois tempos", "Ambas marcam em ambos os tempos", "Both teams to score in both halves",
      "Ambas marcam em cada tempo", "Ambas marcam nos dois tempos - Sim",
    ]) {
      expect(resolveResultFromScore({ ...base, mercado: "Both Teams To Score", selecao, esporte: "Soccer", homeScore: 1, awayScore: 1 }), selecao)
        .toEqual({ ok: false, reason: "wrong_period" });
    }
  });

  it("o 1º e o 2º tempo nomeados juntos não liquidam pelo parcial do 2º tempo", () => {
    // Cada tempo não tem placar próprio: um 1-1 no 2º tempo não diz se ambas marcaram no 1º.
    for (const selecao of [
      "Ambas marcam no 1º e no 2º tempo", "Ambas marcam no primeiro e no segundo tempo", "Ambas marcam no 1T e no 2T",
      "Ambas marcam 1ºT e 2ºT", "Both teams to score 1st and 2nd half",
    ]) {
      const gravada = pinnacleizeSelecao({ selecao, mercadoPinnacle: "Both Teams to Score", evento: base.evento });
      expect(resolveResultFromScore({
        ...base, mercado: "Both Teams to Score", selecao: gravada, esporte: "Soccer", homeScore: 1, awayScore: 1, scorePeriod: "SECOND_HALF",
      }), selecao).toEqual({ ok: false, reason: "wrong_period" });
    }
  });
});

describe("resolveResultFromScore — total do jogo que nomeia um time", () => {
  it.each([
    "Flamengo Over 1.5", "Flamengo mais de 0.5", "Over 1.5 gols do Flamengo",
    "Flamengo O 1.5", "Flamengo O 1,5", "Flamengo O. 1.5", "Flamengo U 2.5", "Flamengo O 1.5 gols",
  ])(
    "'%s' em Total – Match é recusado: pelo placar somado, 1x1 pagaria o total do time",
    (selecao) => {
      expect(resolveResultFromScore({ ...base, mercado: "Total – Match", selecao, homeScore: 1, awayScore: 1 }))
        .toEqual({ ok: false, reason: "ambiguous_selection" });
    },
  );

  it("o mesmo total como Team Total liquida pelos gols do time", () => {
    expect(resolveResultFromScore({ ...base, mercado: "Team Total – Match", selecao: "Flamengo Over 1.5", homeScore: 1, awayScore: 1 }))
      .toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
  });

  it("com a direção abreviada, 'Total de Gols' também é o total do time", () => {
    for (const [selecao, status] of [["Flamengo O 1.5", BetStatus.LOST], ["Palmeiras O 2.5", BetStatus.WON], ["Flamengo U 0.5", BetStatus.WON]] as const) {
      expect(resolveResultFromScore({ ...base, mercado: "Total de Gols", selecao, homeScore: 0, awayScore: 3 }), selecao)
        .toMatchObject({ ok: true, status });
    }
    // Com a categoria no nome, a linha é a da sigla do fim: o Palmeiras fez 3, acima de 1.5.
    for (const [evento, mercado, selecao, status] of [
      ["Flamengo U20 x Palmeiras U20", "Team Total – Match", "Palmeiras U20 U 1.5", BetStatus.LOST],
      ["Flamengo U20 x Palmeiras U20", "Team Total – Match", "Palmeiras U20 Under 1.5", BetStatus.LOST],
      ["Flamengo U20 x Palmeiras U20", "Team Total – Match", "Flamengo U20 U 2.5", BetStatus.WON],
      ["Flamengo U20 x Palmeiras U20", "Total de Gols", "Palmeiras U20 U 1.5", BetStatus.LOST],
      ["Brasil U21 x Argentina U21", "Team Total – Match", "Argentina U21 O 2.5", BetStatus.WON],
      ["Brasil U21 x Argentina U21", "Team Total – Match", "Brasil U21 O 1.5", BetStatus.LOST],
      ["Benfica B x Sporting U23", "Team Total – Match", "Sporting U23 U 1.5", BetStatus.LOST],
    ] as const) {
      expect(resolveResultFromScore({ ...base, evento, mercado, selecao, homeScore: 1, awayScore: 3 }), `${evento} ${selecao}`)
        .toMatchObject({ ok: true, status });
    }
    // "Sporting U23" é nome de time: sem linha decimal, o "U" não é Under.
    expect(resolveResultFromScore({ ...base, evento: "Benfica vs Sporting U23", mercado: "Total de Gols", selecao: "Over 2.5", homeScore: 2, awayScore: 1 }))
      .toMatchObject({ ok: true, status: BetStatus.WON });
  });
});

describe("total cujo rótulo nomeia um time do evento", () => {
  const settle = (mercado: string, evento = "Flamengo vs Vasco", selecao = "Over 1.5", homeScore = 2, awayScore = 1, esporte?: string) =>
    resolveResultFromScore({ mercado, selecao, evento, esporte, homeScore, awayScore, odds: 2, stake: 1 });

  it.each([
    "Total de Gols do Vasco",
    "Vasco - Total de Gols",
    "Total de Gols (Vasco)",
    "Vasco Total de Gols",
    "Mais/Menos Gols Vasco",
    "Total Gols Time Visitante",
  ])("'%s' liquida pelos gols do Vasco, não pela soma", (mercado) => {
    expect(classifyScoreMarket(normalizeStr(mercado), "over 1.5", "Flamengo vs Vasco")).toBe("team_total");
    expect(marketKindOf(mercado, "Over 1.5", "Flamengo vs Vasco")).toBe("team_total");
    // 2-1: a soma daria WON; o Vasco fez 1.
    expect(settle(mercado)).toMatchObject({ ok: true, status: BetStatus.LOST });
    expect(settle(mercado, "Flamengo vs Vasco", "Over 1.5", 0, 2)).toMatchObject({ ok: true, status: BetStatus.WON });
  });

  it("vale com o nome curto do time e no basquete", () => {
    expect(settle("Total de Gols do Vasco", "Flamengo vs Vasco da Gama")).toMatchObject({ ok: true, status: BetStatus.LOST });
    expect(settle("Total de Pontos do Lakers", "Celtics vs Lakers", "Over 110.5", 120, 100, "Basketball"))
      .toMatchObject({ ok: true, status: BetStatus.LOST });
  });

  it("rótulo e seleção que nomeiam times diferentes recusam", () => {
    expect(settle("Total de Gols do Vasco", "Flamengo vs Vasco", "Flamengo Over 1.5")).toEqual({ ok: false, reason: "ambiguous_selection" });
  });

  it("o total do jogo continua pela soma", () => {
    for (const mercado of ["Total de Gols", "Total de Gols - Jogo", "Total de Gols 1º Tempo e 2º Tempo somados", "Mais/Menos Gols"]) {
      expect(classifyScoreMarket(normalizeStr(mercado), "over 1.5", "Flamengo vs Vasco"), mercado).not.toBe("team_total");
    }
    expect(settle("Total de Gols")).toMatchObject({ ok: true, status: BetStatus.WON });
  });
});

describe("seleção ou rótulo que junta uma segunda condição", () => {
  const settle = (mercado: string, selecao: string, homeScore: number, awayScore: number, evento = "Flamengo vs Vasco") =>
    resolveResultFromScore({ mercado, selecao, evento, homeScore, awayScore, odds: 2, stake: 1 });

  it.each([
    ["Ambas Marcam", "Sim e Over 2.5", 1, 1],
    ["Ambas Marcam", "Sim + Over 2.5", 1, 1],
    ["Ambas Marcam", "Sim & Over 2.5", 1, 1],
    ["Ambas Marcam", "Sim e Flamengo vence", 1, 1],
    ["Ambas Marcam", "Sim e Flamengo", 1, 1],
    ["Empate Anula", "Flamengo e Over 2.5", 1, 0],
    ["Empate Anula", "Flamengo + Ambas marcam", 1, 0],
    ["Handicap Asiático", "Flamengo -0.5 e Over 2.5", 1, 0],
    ["Handicap Asiático", "Flamengo -0.5 + Ambas marcam", 1, 0],
    ["Resultado / Total de Gols", "Flamengo e Over 2.5", 2, 1],
    ["Resultado / Total de Gols", "Over 2.5", 2, 1],
    ["Total de Gols", "Flamengo e Over 2.5", 3, 0],
    ["Total de Gols", "Over 2.5 e Flamengo vence", 0, 3],
    ["Total de Gols", "Over 2.5, empate", 2, 1],
    ["Dupla Chance", "Flamengo ou Empate e Over 2.5", 1, 0],
  ] as const)("%s / %s não é pago por uma metade só", (mercado, selecao, homeScore, awayScore) => {
    expect(settle(mercado, selecao, homeScore, awayScore)).toEqual({ ok: false, reason: "unsupported_market" });
    expect(isScoreResolvableMarket({ mercado, selecao, evento: "Flamengo vs Vasco" })).toBe(false);
  });

  it("sem o evento, a segunda condição escrita na seleção já tira a aposta do placar", () => {
    expect(isScoreResolvableMarket({ mercado: "Ambas Marcam", selecao: "Sim e Over 2.5" })).toBe(false);
    expect(isScoreResolvableMarket({ mercado: "Handicap Asiático", selecao: "Flamengo -0.5 e Over 2.5" })).toBe(false);
  });

  it.each([
    ["Handicap Asiático", "Brighton & Hove Albion -0.5", "Brighton & Hove Albion vs Arsenal", 1, 0, BetStatus.WON],
    ["Total de Gols", "Brighton & Hove Albion Over 1.5", "Brighton & Hove Albion vs Arsenal", 1, 2, BetStatus.LOST],
    ["Empate Anula", "Dagenham & Redbridge", "Dagenham & Redbridge vs Barnet", 2, 0, BetStatus.WON],
    ["Handicap Asiático", "Bodo/Glimt -0.5", "Bodo/Glimt vs Molde", 1, 0, BetStatus.WON],
    ["Handicap Asiático", "Bodo/Glimt -0.5", "Bodo Glimt vs Molde", 1, 0, BetStatus.WON],
    ["Total de Gols", "Over 2.5/3", "Flamengo vs Vasco", 2, 1, BetStatus.HALF_WON],
    ["Total de Gols", "Over 2.0,2.5", "Flamengo vs Vasco", 2, 1, BetStatus.WON],
    ["Handicap Asiático", "Flamengo 0,-0.5", "Flamengo vs Vasco", 1, 0, BetStatus.WON],
    ["Handicap Asiático", "Vasco +0.5", "Flamengo vs Vasco", 1, 1, BetStatus.WON],
    ["Dupla Chance", "Flamengo e Empate", "Flamengo vs Vasco", 1, 1, BetStatus.WON],
    ["Dupla Chance", "Casa/Empate", "Flamengo vs Vasco", 0, 1, BetStatus.LOST],
    ["Ambas Marcam", "Sim, ambas marcam", "Flamengo vs Vasco", 1, 1, BetStatus.WON],
    ["Over/Under", "Over 2.5", "Flamengo vs Vasco", 2, 1, BetStatus.WON],
  ] as const)("%s / %s continua liquidando (nome com conectivo, linha dividida, uma condição só)", (mercado, selecao, evento, homeScore, awayScore, status) => {
    expect(settle(mercado, selecao, homeScore, awayScore, evento)).toMatchObject({ ok: true, status });
  });
});
