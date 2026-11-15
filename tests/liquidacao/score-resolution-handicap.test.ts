import { describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/client";
import { canonicalizeAsianHandicapSelecao } from "@/src/domain/asian-handicap-line";
import { isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { parseLineQuarters } from "@/src/domain/settlement/lines";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { matchTeamSide, stripTeamNames } from "@/src/domain/settlement/sides";

const base = {
  evento: "Flamengo vs Palmeiras",
  odds: 2.0,
  stake: 1,
};

describe("resolveResultFromScore — handicap asiático (quartos exatos, sem epsilon)", () => {
  const ah = (selecao: string, homeScore: number, awayScore: number) =>
    resolveResultFromScore({
      ...base,
      mercado: "Asian Handicap",
      selecao,
      homeScore,
      awayScore,
    });

  it("AH 0: empate → VOID (push exato)", () => {
    expect(ah("Flamengo 0", 1, 1)).toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
  });

  it("AH -0.25: empate → HALF_LOST; vitória por 1 → WON", () => {
    expect(ah("Flamengo -0.25", 0, 0)).toEqual({
      ok: true,
      status: BetStatus.HALF_LOST,
      lucro: -0.5,
    });
    expect(ah("Flamengo -0.25", 2, 1)).toEqual({
      ok: true,
      status: BetStatus.WON,
      lucro: 1,
    });
  });

  it("AH +0.25: empate → HALF_WON", () => {
    expect(ah("Flamengo +0.25", 1, 1)).toEqual({
      ok: true,
      status: BetStatus.HALF_WON,
      lucro: 0.5,
    });
  });

  it("AH -0.5: empate → LOST; AH -1 vencendo por 1 → VOID", () => {
    expect(ah("Flamengo -0.5", 1, 1)).toEqual({
      ok: true,
      status: BetStatus.LOST,
      lucro: -1,
    });
    expect(ah("Flamengo -0,5", 1, 1)).toEqual({
      ok: true,
      status: BetStatus.LOST,
      lucro: -1,
    });
    expect(ah("Flamengo -1", 2, 1)).toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
  });

  it("lado pelo time visitante por nome", () => {
    expect(ah("Palmeiras +0.5", 1, 1)).toEqual({
      ok: true,
      status: BetStatus.WON,
      lucro: 1,
    });
  });

  it("tokens explícitos casa/fora funcionam", () => {
    expect(ah("Casa -0.5", 2, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(ah("Away +1.5", 0, 0)).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("seleção ambígua NÃO resolve", () => {
    const result = resolveResultFromScore({
      mercado: "Asian Handicap",
      selecao: "Al Sadd al waab -0.5",
      evento: "Al Waab vs Al Sadd",
      homeScore: 2,
      awayScore: 0,
      odds: 2,
      stake: 1,
    });
    expect(result).toEqual({ ok: false, reason: "ambiguous_selection" });
  });

  it("linha não-múltipla de 0.25 → invalid_line (nunca decide por arredondamento)", () => {
    expect(ah("Flamengo -0.3", 1, 0)).toEqual({ ok: false, reason: "invalid_line" });
  });
});

describe("resolveResultFromScore — handicap: dígitos no nome do time não corrompem a linha", () => {
  const ah = (selecao: string, evento: string, homeScore: number, awayScore: number) =>
    resolveResultFromScore({
      mercado: "Asian Handicap",
      selecao,
      evento,
      odds: 2,
      stake: 1,
      homeScore,
      awayScore,
    });

  it("'1. FC Köln -0.5' usa a linha -0.5, não a média de [1, -0.5]=+0.25", () => {
    // 1-1: handicap -0.5 da casa → LOST. A média [1, -0.5] daria HALF_WON (+0.25).
    expect(ah("1. FC Köln -0.5", "1. FC Köln vs Bayern", 1, 1)).toEqual({
      ok: true,
      status: BetStatus.LOST,
      lucro: -1,
    });
  });

  it("'Schalke 04 -0.5' ignora o '04' do nome (vitória por 1 → WON)", () => {
    expect(ah("Schalke 04 -0.5", "Schalke 04 vs Bayern", 1, 0)).toEqual({
      ok: true,
      status: BetStatus.WON,
      lucro: 1,
    });
  });

  it("'1899 Hoffenheim -1' lê -1, não a média absurda com 1899", () => {
    // casa vence por 1 com handicap -1 → push exato → VOID.
    expect(ah("1899 Hoffenheim -1", "1899 Hoffenheim vs Mainz", 1, 0)).toEqual({
      ok: true,
      status: BetStatus.VOID,
      lucro: 0,
    });
  });

  it("preserva o SINAL da linha quando o número do nome coincide ('1. FC Köln +1')", () => {
    // Köln (casa) perde por 1, handicap +1 → 4*(-1)+4 = 0 → VOID. Se a limpeza
    // do nome comesse o '+1' junto com o '1' do nome, viraria missing_line.
    expect(ah("1. FC Köln +1", "1. FC Köln vs Bayern", 0, 1)).toEqual({
      ok: true,
      status: BetStatus.VOID,
      lucro: 0,
    });
  });

  it("ignora numeros no nome do time sem mutilar a linha decimal", () => {
    expect(
      resolveResultFromScore({
        ...base,
        evento: "Mainz 05 vs Schalke 04",
        mercado: "Team Total",
        selecao: "Mainz 05 Over 1.5",
        homeScore: 2,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(
      resolveResultFromScore({
        ...base,
        evento: "BK 95 vs Club X",
        mercado: "Asian Handicap",
        selecao: "BK 95 +1.5",
        homeScore: 0,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    expect(
      resolveResultFromScore({
        ...base,
        evento: "Racing 01 vs Racing 02",
        mercado: "Asian Handicap",
        selecao: "Racing 02 +0.5",
        homeScore: 1,
        awayScore: 1,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });

  it("Schalke 04: numeral do clube sobrevivente não pode inverter a linha", () => {
    // O evento grafa só "Schalke", então `stripTeamNames` não remove o "04" da
    // seleção: sobram DOIS números, e a linha não pode virar +1.5 no lugar de −1.5.
    const evento = "Schalke vs Bayern";
    const selecao = "Schalke 04 (-1.5)";
    expect(stripTeamNames(selecao, evento).trim()).toBe("04 (-1.5)");
    expect(matchTeamSide(selecao, evento)).toBe("home");
    expect(parseLineQuarters(stripTeamNames(selecao, evento), { allowNegative: true })).toBe(-6);
    // Vitória por 1 gol NÃO cobre -1.5.
    expect(
      resolveResultFromScore({
        ...base,
        evento,
        mercado: "Asian Handicap",
        selecao,
        homeScore: 1,
        awayScore: 0,
      }),
    ).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
    expect(
      resolveResultFromScore({
        ...base,
        evento,
        mercado: "Asian Handicap",
        selecao,
        homeScore: 3,
        awayScore: 0,
      }),
    ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });
});

describe("resolveResultFromScore — handicap: linha entre parênteses e vírgula decimal", () => {
  it("linha negativa entre parênteses preserva o sinal", () => {
    // O ramo de sinal explícito não pode exigir espaço antes do `-`: com
    // parênteses a linha cairia no ramo decimal, que devolve o valor ABSOLUTO,
    // e o handicap liquidaria invertido.
    expect(parseLineQuarters("Flamengo (-1.5)", { allowNegative: true })).toBe(-6);
    expect(parseLineQuarters("2 (-1.5)", { allowNegative: true })).toBe(-6);
    expect(parseLineQuarters("Flamengo (+0.5)", { allowNegative: true })).toBe(2);
    for (const selecao of ["Flamengo (-1.5)", "Time 1 (-1.5)", "1 (-1.5)"]) {
      expect(
        resolveResultFromScore({
          ...base,
          mercado: "Asian Handicap",
          selecao,
          homeScore: 1,
          awayScore: 0,
        }),
        selecao,
      ).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
      expect(
        resolveResultFromScore({
          ...base,
          mercado: "Asian Handicap",
          selecao,
          homeScore: 3,
          awayScore: 0,
        }),
        selecao,
      ).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
    }
    // Split asiático colado continua sendo média das duas pernas.
    expect(parseLineQuarters("-0.0,-0.5", { allowNegative: true })).toBe(-1);
  });

  it("normaliza -2,2.5 para -2.25 e liquida pela linha correta", () => {
    const selecao = canonicalizeAsianHandicapSelecao(
      "Flamengo -2,2.5",
      base.evento,
      "Handicap – Match",
    );
    expect(selecao).toBe("Flamengo -2.25");
    expect(resolveResultFromScore({
      ...base,
      mercado: "Handicap – Match",
      selecao,
      homeScore: 2,
      awayScore: 1,
    })).toMatchObject({ ok: true, status: "LOST" });
    expect(resolveResultFromScore({
      ...base,
      mercado: "Handicap – Match",
      selecao: "Flamengo 2,2.5",
      homeScore: 2,
      awayScore: 1,
    })).toEqual({ ok: false, reason: "invalid_line" });
  });

  it("sinais explícitos opostos nunca viram uma linha média", () => {
    for (const selecao of ["Flamengo -2,+2.5", "Flamengo +2,-2.5"]) {
      expect(canonicalizeAsianHandicapSelecao(
        selecao,
        base.evento,
        "Handicap – Match",
      )).toBe(selecao);
      expect(resolveResultFromScore({
        ...base,
        mercado: "Handicap – Match",
        selecao,
        homeScore: 2,
        awayScore: 1,
      }), selecao).toEqual({ ok: false, reason: "invalid_line" });
    }
  });
});

describe("resolveResultFromScore — handicap: splits de linha", () => {
  it("splits de AH com herança de sinal negativo liquidam com a linha correta", () => {
    expect(parseLineQuarters("-2.0,2.5", { allowNegative: true })).toBe(-9);
    expect(parseLineQuarters("Flamengo -2.0, 2.5", { allowNegative: true })).toBe(-9);

    const result = resolveResultFromScore({
      ...base,
      selecao: "Flamengo -2.0, 2.5",
      mercado: "Asian Handicap",
      evento: "Flamengo vs Palmeiras",
      homeScore: 0,
      awayScore: 0,
    });
    expect(result).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
  });

  it("splits com distância !== 0.5 falham fechados (invalid_line) e não liquidam indevidamente", () => {
    expect(
      resolveResultFromScore({
        ...base,
        selecao: "Over 2.0, 3.0",
        mercado: "Total – Match",
        evento: "Time A vs Time B",
        homeScore: 2,
        awayScore: 1,
      }),
    ).toEqual({ ok: false, reason: "invalid_line" });

    expect(
      resolveResultFromScore({
        ...base,
        selecao: "Flamengo -1.0, -2.0",
        mercado: "Asian Handicap",
        evento: "Flamengo vs Palmeiras",
        homeScore: 1,
        awayScore: 0,
      }),
    ).toEqual({ ok: false, reason: "invalid_line" });
  });

  it("splits de AH com sinais opostos falham fechados (invalid_line)", () => {
    expect(
      resolveResultFromScore({
        ...base,
        selecao: "Flamengo 2, -2.5",
        mercado: "Asian Handicap",
        evento: "Flamengo vs Palmeiras",
        homeScore: 1,
        awayScore: 0,
      }),
    ).toEqual({ ok: false, reason: "invalid_line" });
  });

  it("splits de AH sem espaço com herança de sinal resolvem para a quarter line correta", () => {
    expect(parseLineQuarters("-2,2.5", { allowNegative: true })).toBe(-9);
    expect(parseLineQuarters("Flamengo -2,2.5", { allowNegative: true })).toBe(-9);
    expect(parseLineQuarters("+1,1.5", { allowNegative: true })).toBe(5);

    const result = resolveResultFromScore({
      ...base,
      selecao: "Flamengo -2,2.5",
      mercado: "Asian Handicap",
      evento: "Flamengo vs Palmeiras",
      homeScore: 2,
      awayScore: 0,
    });
    // 2-0 com handicap -2.25 -> diff = +2, adjustedQ = 4*(2) - 9 = -1 -> HALF_LOST
    expect(result).toEqual({ ok: true, status: BetStatus.HALF_LOST, lucro: -0.5 });
  });

  it("seleção com números ilegíveis/conflitantes falha fechada com invalid_line e não usa linha do mercado", () => {
    expect(
      resolveResultFromScore({
        ...base,
        selecao: "Flamengo -0.5 -110",
        mercado: "Asian Handicap -1.0",
        evento: "Flamengo vs Palmeiras",
        homeScore: 1,
        awayScore: 0,
      }),
    ).toEqual({ ok: false, reason: "invalid_line" });

    expect(
      resolveResultFromScore({
        ...base,
        selecao: "Over 2 3",
        mercado: "Total – Match 3.0",
        evento: "Time A vs Time B",
        homeScore: 2,
        awayScore: 1,
      }),
    ).toEqual({ ok: false, reason: "invalid_line" });
  });

  it("T2-R4-BUG-01: preserva o sinal negativo em decimais PT (-0,5 / -0,25 / -0,75)", () => {
    expect(parseLineQuarters("-0,5", { allowNegative: true })).toBe(-2);
    expect(parseLineQuarters("-0,25", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("-0,75", { allowNegative: true })).toBe(-3);
    expect(parseLineQuarters("Flamengo -0,5", { allowNegative: true })).toBe(-2);

    // Regressões com zero neutro em splits (+0,-0.5 = -0.25; -0,+0.5 = +0.25; +0/-0.5 = -0.25)
    expect(parseLineQuarters("+0,-0.5", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("-0,+0.5", { allowNegative: true })).toBe(1);
    expect(parseLineQuarters("+0/-0.5", { allowNegative: true })).toBe(-1);

    // Liquidação no 0-0 com 'Flamengo -0,5' deve ser LOST (e não WON)
    const res00 = resolveResultFromScore({
      ...base,
      selecao: "Flamengo -0,5",
      mercado: "Asian Handicap",
      evento: "Flamengo vs Palmeiras",
      homeScore: 0,
      awayScore: 0,
    });
    expect(res00).toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });

    // Liquidação no 0-0 com 'Flamengo -0,25' deve ser HALF_LOST (e não HALF_WON)
    const resHalf00 = resolveResultFromScore({
      ...base,
      selecao: "Flamengo -0,25",
      mercado: "Asian Handicap",
      evento: "Flamengo vs Palmeiras",
      homeScore: 0,
      awayScore: 0,
    });
    expect(resHalf00).toEqual({ ok: true, status: BetStatus.HALF_LOST, lucro: -0.5 });
  });
});

describe("resolveResultFromScore — handicap europeu e de três vias não usam push asiático", () => {
  it("'European Handicap' linha inteira no push → RECUSA (manual), não VOID indevido", () => {
    // casa -1 vence por exatamente 1: no asiático é push (VOID); no europeu (3-way)
    // é PERDA. Como não dá p/ resolver 3-way pela matemática de 2 vias → manual.
    const r = resolveResultFromScore({ ...base, mercado: "European Handicap", selecao: "Flamengo -1", homeScore: 1, awayScore: 0 });
    expect(r.ok).toBe(false);
    expect(isScoreResolvableMarket({ mercado: "European Handicap", selecao: "Flamengo -1" })).toBe(false);
  });

  it("Asian Handicap segue resolvendo o push corretamente (VOID) — sem regressão", () => {
    expect(
      resolveResultFromScore({ ...base, mercado: "Asian Handicap", selecao: "Flamengo -1", homeScore: 1, awayScore: 0 }),
    ).toEqual({ ok: true, status: BetStatus.VOID, lucro: 0 });
  });

  it("recusa handicap de três vias em vez de aplicar push asiático", () => {
    for (const mercado of ["3-Way Handicap", "Three Way Handicap", "Handicap 3 Vias"]) {
      const input = { ...base, mercado, selecao: "Flamengo -1" };
      expect(isScoreResolvableMarket(input), mercado).toBe(false);
      expect(resolveResultFromScore({ ...input, homeScore: 2, awayScore: 1 }), mercado)
        .toEqual({ ok: false, reason: "unsupported_market" });
    }
  });
});

describe("handicap asiático ao vivo: o restante do jogo", () => {
  const base = {
    evento: "Time A vs Time B",
    esporte: "Soccer",
    mercado: "Asian Handicap",
    odds: 2,
    stake: 1,
  };

  describe("settlement após primeiro placar live recebido por edição", () => {
    it("troca HALF_WON prematch por WON quando o visitante vence o restante", () => {
      const prematch = resolveResultFromScore({
        ...base,
        selecao: "Time B +0.25",
        homeScore: 1,
        awayScore: 1,
      });
      const live = resolveResultFromScore({
        ...base,
        selecao: "Time B +0.25",
        liveScoreHome: 1,
        liveScoreAway: 0,
        homeScore: 1,
        awayScore: 1,
      });

      expect(prematch).toMatchObject({ ok: true, status: BetStatus.HALF_WON });
      expect(live).toMatchObject({ ok: true, status: BetStatus.WON });
    });

    it("troca LOST prematch por HALF_LOST quando o restante termina empatado", () => {
      const prematch = resolveResultFromScore({
        ...base,
        selecao: "Time B -0.25",
        homeScore: 1,
        awayScore: 0,
      });
      const live = resolveResultFromScore({
        ...base,
        selecao: "Time B -0.25",
        liveScoreHome: 1,
        liveScoreAway: 0,
        homeScore: 1,
        awayScore: 0,
      });

      expect(prematch).toMatchObject({ ok: true, status: BetStatus.LOST });
      expect(live).toMatchObject({ ok: true, status: BetStatus.HALF_LOST });
    });

    it("placar só no texto não liquida o restante", () => {
      expect(resolveResultFromScore({
        ...base,
        selecao: "(1-0) Time B +0.25",
        homeScore: 1,
        awayScore: 1,
      })).toEqual({ ok: false, reason: "incomplete_live_score" });
    });
  });
});

describe("resolveResultFromScore — handicap ao vivo sem o placar da entrada", () => {
  const ah = (extra: Partial<Parameters<typeof resolveResultFromScore>[0]>) =>
    resolveResultFromScore({ ...base, mercado: "Handicap – Match", selecao: "Flamengo -0.5", homeScore: 1, awayScore: 0, ...extra });

  it("legenda 'AO VIVO' sem placar estruturado recusa em vez de liquidar o jogo inteiro", () => {
    // "AO VIVO 1x0 / Flamengo -0.5" com final 1-0: a casa paga LOST (o
    // restante foi 0-0); pelo placar inteiro sairia WON.
    expect(ah({ liveTextAtCapture: true })).toEqual({ ok: false, reason: "incomplete_live_score" });
    expect(ah({ selecao: "Flamengo -0.5 ao vivo" })).toEqual({ ok: false, reason: "incomplete_live_score" });
  });

  it("com o placar da entrada gravado, liquida pelo restante", () => {
    expect(ah({ liveTextAtCapture: true, liveScoreHome: 1, liveScoreAway: 0 }))
      .toEqual({ ok: true, status: BetStatus.LOST, lucro: -1 });
  });

  it("pré-jogo segue liquidando pelo placar final", () => {
    expect(ah({})).toEqual({ ok: true, status: BetStatus.WON, lucro: 1 });
  });
});

describe("resolveResultFromScore — split com zero assinado ('-0/0.5')", () => {
  it("o sinal do zero vale para o par: -0/0.5 é -0.25, não +0.25", () => {
    const ah = (selecao: string, homeScore: number, awayScore: number) =>
      resolveResultFromScore({ ...base, mercado: "Asian Handicap", selecao, homeScore, awayScore });
    expect(parseLineQuarters("-0/0.5", { allowNegative: true })).toBe(-1);
    expect(parseLineQuarters("+0/0.5", { allowNegative: true })).toBe(1);
    expect(ah("Flamengo -0/0.5", 1, 1)).toEqual({ ok: true, status: BetStatus.HALF_LOST, lucro: -0.5 });
    expect(ah("Palmeiras +0/0.5", 1, 1)).toEqual({ ok: true, status: BetStatus.HALF_WON, lucro: 0.5 });
  });
});
