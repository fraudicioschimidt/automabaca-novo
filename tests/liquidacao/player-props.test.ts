import { describe, expect, it } from "vitest";
import { coerceMercadoPelaSelecao } from "@/src/domain/mercados/coerce";
import { isMercadoFinal, resolveMercadoStatic } from "@/src/domain/mercados/catalog";
import { hasNonScoreStatQualifier } from "@/src/domain/mercados/stat-qualifier";
import { resolveGoalscorer } from "@/src/domain/settlement/goalscorer";
import { tokensDaSelecao } from "@/src/domain/settlement/goalscorer-matching";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import { resolvePlayerProp } from "@/src/domain/settlement/player-props";
import { isScoreResolvableMarket, classifyScoreMarket } from "@/src/domain/settlement/markets";
import {
  statisticFamilyOf,
  resolveResultFromStatistics,
} from "@/src/domain/settlement/statistics";
import { marketNeedsFlashscoreStats } from "@/src/providers/flashscore/stats";
import {
  normalizeFlashscorePlayers,
  flashscorePlayerStatsResponseSchema,
} from "@/src/providers/flashscore/player-stats";
import { marketFamily } from "@/src/providers/coverage";
import { parseBetLegs } from "@/src/domain/bet-legs";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { normalizeStr } from "@/src/domain/text";
import { resolveTicketFromScore } from "@/src/domain/settlement/ticket-resolution";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";
import { readFileSync } from "node:fs";
import path from "node:path";

const BAHIA_VASCO = "Bahia vs Vasco da Gama";
const FLAMENGO_BAHIA = "Flamengo vs Bahia";

const willian = {
  playerId: "jD7L6o7T",
  nome: "Willian Jose",
  gols: 0,
  golsContra: 0,
  stats: { FOULS_SUFFERED: 1, FOULS_COMMITTED: 0 },
};

describe("classificar e coagir prop de jogador", () => {
  it("sofre falta é FOULS_SUFFERED, mesmo gravado como Total – Match", () => {
    const cls = classificarPropDeJogador({
      mercado: "Total – Match",
      selecao: "willian jose over 0,5 sofre falta",
      evento: BAHIA_VASCO,
    });
    expect(cls).toEqual({
      family: "fouls_suffered",
      mercado: "Player Fouls Suffered",
    });
    expect(
      coerceMercadoPelaSelecao(
        "Moneyline",
        "willian jose over 0,5 sofre falta",
        "Soccer",
        BAHIA_VASCO,
      ),
    ).toBe("Player Fouls Suffered");
    expect(
      coerceMercadoPelaSelecao(
        "Total – Match",
        "willian jose over 0,5 sofre falta",
        "Soccer",
        BAHIA_VASCO,
      ),
    ).toBe("Player Fouls Suffered");
  });

  it("faltas sem sofre/comete, com nome que não é o time, é FOULS_COMMITTED", () => {
    expect(
      classificarPropDeJogador({
        mercado: "Total – Match",
        selecao: "emmanuel martinez over 1,5 faltas",
        evento: FLAMENGO_BAHIA,
      }),
    ).toEqual({ family: "fouls_committed", mercado: "Player Fouls" });
    expect(
      coerceMercadoPelaSelecao(
        "Moneyline",
        "emmanuel martinez over 1,5 faltas",
        "Soccer",
        FLAMENGO_BAHIA,
      ),
    ).toBe("Player Fouls");
  });

  it("prefixo que é o time continua faltas de TIME, não de jogador", () => {
    expect(
      classificarPropDeJogador({
        mercado: "Total – Match",
        selecao: "Bahia over 8.5 faltas",
        evento: BAHIA_VASCO,
      }),
    ).toBeNull();
    expect(statisticFamilyOf("Total – Match", "Bahia over 8.5 faltas", BAHIA_VASCO)).toBe(
      "fouls",
    );
  });

  it("rótulo de estatística antes do over não é nome de jogador", () => {
    expect(
      classificarPropDeJogador({
        mercado: "Total de Cartões",
        selecao: "Cartões Amarelos Over 1.5",
      }),
    ).toBeNull();
    expect(statisticFamilyOf("Total de Cartões", "Cartões Amarelos Over 1.5")).toBe(
      "yellow_cards",
    );
    expect(statisticFamilyOf("Faltas", "Duplas Faltas Over 2.5")).toBe("double_faults");
    expect(
      classificarPropDeJogador({
        mercado: "Both Teams Cards – Match",
        selecao: "Ambas recebem +2 cards",
      }),
    ).toBeNull();
  });

  it("Anytime Goalscorer não é sequestrado pelo classificador de prop", () => {
    expect(
      classificarPropDeJogador({
        mercado: "Anytime Goalscorer",
        selecao: "Willian Jose",
        evento: BAHIA_VASCO,
      }),
    ).toBeNull();
  });
});

describe("roteamento: sofre falta nunca cai em placar nem em stats de time", () => {
  const selecao = "willian jose over 0,5 sofre falta";

  it("declara estatística e sai do caminho de placar", () => {
    expect(hasNonScoreStatQualifier("Total – Match", selecao)).toBe(true);
    expect(
      isScoreResolvableMarket({
        mercado: "Total – Match",
        selecao,
        esporte: "Soccer",
        evento: BAHIA_VASCO,
      }),
    ).toBe(false);
  });

  it("não gasta a chamada de estatística de TIME", () => {
    expect(statisticFamilyOf("Total – Match", selecao, BAHIA_VASCO)).toBeNull();
    expect(marketNeedsFlashscoreStats("Total – Match", selecao, BAHIA_VASCO)).toBe(false);
    expect(statisticFamilyOf("Total – Match", "emmanuel martinez over 1,5 faltas", FLAMENGO_BAHIA))
      .toBeNull();
    expect(
      marketNeedsFlashscoreStats(
        "Total – Match",
        "emmanuel martinez over 1,5 faltas",
        FLAMENGO_BAHIA,
      ),
    ).toBe(false);
  });

  it("Player Cards não entra na família de cartões de time (odds)", () => {
    expect(marketFamily("Player Cards", "Over 0.5")).toBe("other");
    expect(marketFamily("Total – Match", selecao)).toBe("other");
  });
});

describe("resolver: MapCWrTb / Willian José e famílias da Fase 1", () => {
  it("FOULS_SUFFERED=1 ganha Over 0.5 e não olha o placar", () => {
    expect(
      resolvePlayerProp({
        mercado: "Total – Match",
        selecao: "willian jose over 0,5 sofre falta",
        evento: BAHIA_VASCO,
        jogadores: [willian],
      }),
    ).toMatchObject({
      ok: true,
      status: "WON",
      family: "fouls_suffered",
      chave: "FOULS_SUFFERED",
      valor: 1,
      jogador: { playerId: "jD7L6o7T", nome: "Willian Jose" },
    });
  });

  it("Emmanuel Martinez over 1.5 faltas lê FOULS_COMMITTED", () => {
    const jogadores = [{
      playerId: "em1",
      nome: "Martinez Emmanuel",
      gols: 0,
      golsContra: 0,
      stats: { FOULS_COMMITTED: 2, FOULS_SUFFERED: 0 },
    }];
    expect(
      resolvePlayerProp({
        mercado: "Total – Match",
        selecao: "emmanuel martinez over 1,5 faltas",
        evento: FLAMENGO_BAHIA,
        jogadores,
      }),
    ).toMatchObject({ ok: true, status: "WON", family: "fouls_committed", valor: 2 });
  });

  it("chutes sem 'no gol' usam SHOTS_TOTAL; no gol usa SHOTS_ON_TARGET", () => {
    const jogadores = [{
      playerId: "v1",
      nome: "Junior Vinicius",
      gols: 0,
      golsContra: 0,
      stats: { SHOTS_TOTAL: 3, SHOTS_ON_TARGET: 1 },
    }];
    expect(
      resolvePlayerProp({
        mercado: "Player Shots",
        selecao: "Vinicius Junior over 2.5 chutes",
        evento: "Real Madrid vs Barcelona",
        jogadores,
      }),
    ).toMatchObject({ ok: true, status: "WON", family: "shots_total", valor: 3 });
    expect(
      resolvePlayerProp({
        mercado: "Player Shots on Target",
        selecao: "Vinicius Junior over 1.5 chutes no gol",
        evento: "Real Madrid vs Barcelona",
        jogadores,
      }),
    ).toMatchObject({ ok: true, status: "LOST", family: "shots_on_target", valor: 1 });
  });

  it("desarmes sem ganhos usam TACKLES_TOTAL; ganhos usam TACKLES_WON", () => {
    const jogadores = [{
      playerId: "c1",
      nome: "Casemiro",
      gols: 0,
      golsContra: 0,
      stats: { TACKLES_TOTAL: 4, TACKLES_WON: 1 },
    }];
    expect(
      resolvePlayerProp({
        mercado: "Player Tackles",
        selecao: "Casemiro over 3.5 desarmes",
        evento: "Real Madrid vs Barcelona",
        jogadores,
      }),
    ).toMatchObject({ ok: true, status: "WON", family: "tackles_total", valor: 4 });
    expect(
      resolvePlayerProp({
        mercado: "Player Tackles",
        selecao: "Casemiro over 1.5 desarmes ganhos",
        evento: "Real Madrid vs Barcelona",
        jogadores,
      }),
    ).toMatchObject({ ok: true, status: "LOST", family: "tackles_won", valor: 1 });
  });

  it("assistência lê ASSISTS_GOAL", () => {
    const jogadores = [{
      playerId: "n1",
      nome: "Neymar",
      gols: 0,
      golsContra: 0,
      stats: { ASSISTS_GOAL: 1 },
    }];
    expect(
      resolvePlayerProp({
        mercado: "Player Assists",
        selecao: "Neymar over 0.5 assistencias",
        evento: "PSG vs Lyon",
        jogadores,
      }),
    ).toMatchObject({ ok: true, status: "WON", family: "assists", valor: 1 });
  });

  it("cartão amarelo explícito lê CARDS_YELLOW quando não houve segundo amarelo", () => {
    const jogadores = [{
      playerId: "c1",
      nome: "Casemiro",
      gols: 0,
      golsContra: 0,
      stats: { CARDS_YELLOW: 1, CARDS_RED: 0, CARDS_YELLOW_SECOND: 0 },
    }];
    expect(
      resolvePlayerProp({
        mercado: "Player Cards",
        selecao: "Casemiro over 0.5 cartoes amarelos",
        evento: "Real Madrid vs Barcelona",
        jogadores,
      }),
    ).toMatchObject({ ok: true, status: "WON", family: "cards_yellow", valor: 1 });
  });

  it("fail-closed: sem jogadores, sem chave, sem casamento", () => {
    expect(
      resolvePlayerProp({
        mercado: "Player Fouls Suffered",
        selecao: "willian jose over 0,5 sofre falta",
        evento: BAHIA_VASCO,
        jogadores: [],
      }),
    ).toMatchObject({ ok: false, reason: "sem_jogadores" });
    expect(
      resolvePlayerProp({
        mercado: "Total – Match",
        selecao: "willian jose over 0,5 sofre falta",
        evento: BAHIA_VASCO,
        jogadores: [{ ...willian, stats: { FOULS_COMMITTED: 0 } }],
      }),
    ).toMatchObject({ ok: false, reason: "stat_ausente" });
    expect(
      resolvePlayerProp({
        mercado: "Total – Match",
        selecao: "erling haaland over 0,5 sofre falta",
        evento: BAHIA_VASCO,
        jogadores: [willian],
      }),
    ).toMatchObject({ ok: false, reason: "jogador_nao_encontrado" });
  });

  it("chave ausente no normalizer não vira 0; GOALS ausente continua 0", () => {
    const [jogador] = normalizeFlashscorePlayers({
      players: [{
        player_id: "jD7L6o7T",
        name: "Willian Jose",
        stats: { GOALS_OWN: { raw_value: "0" }, FOULS_COMMITTED: { raw_value: "0" } },
      }],
    });
    expect(jogador?.gols).toBe(0);
    expect(jogador?.stats?.["FOULS_SUFFERED"]).toBeUndefined();
    expect(jogador?.stats?.["FOULS_COMMITTED"]).toBe(0);
  });

  it("Anytime Goalscorer (GOALS) permanece no caminho próprio", () => {
    const jogadores = [{
      playerId: "p1",
      nome: "Cristaldo Franco",
      gols: 1,
      golsContra: 0,
    }];
    expect(
      resolveGoalscorer({ selecao: "Franco Cristaldo", mercado: "Anytime Goalscorer", jogadores }),
    ).toMatchObject({ ok: true, status: "WON" });
    expect(
      resolvePlayerProp({
        mercado: "Anytime Goalscorer",
        selecao: "Franco Cristaldo",
        jogadores,
      }),
    ).toMatchObject({ ok: false, reason: "nao_e_prop_de_jogador" });
  });

  it("o matcher descarta over/under, sofre/falta e o número da linha", () => {
    expect(tokensDaSelecao("willian jose over 0,5 sofre falta")).toEqual([
      "willian",
      "jose",
    ]);
  });
});

const EVENTO = "Real Madrid vs Barcelona";

describe("props de jogador falham fechado", () => {
  describe("seleção só com o nome: Over 0.5; com o 'Não', recusa", () => {
    const santos = "Santos vs Palmeiras";
    const neymar = {
      playerId: "neymar", nome: "Neymar", gols: 0, golsContra: 0, minutosJogados: 90, participou: true,
      stats: { ASSISTS_GOAL: 0, CARDS_YELLOW: 0, CARDS_YELLOW_SECOND: 0, CARDS_RED: 0, SHOTS_ON_TARGET: 2 },
    };
    const prop = (mercado: string, selecao: string) =>
      resolvePlayerProp({ mercado, selecao, evento: santos, esporte: "Soccer", jogadores: [neymar] });

    it.each([
      ["Player Assists", "Neymar - Não"], ["Player Assists", "Neymar - No"], ["Player Assists", "Neymar não dá assistência"],
      ["Player Yellow Cards", "Neymar - Não"], ["Player Red Cards", "Neymar - No"],
    ])("%s / %s recusa em vez de virar Over 0.5", (mercado, selecao) => {
      expect(prop(mercado, selecao)).toMatchObject({ ok: false, reason: "ambiguous_selection" });
    });

    it("sem negação, o nome sozinho segue Over 0.5, e a linha explícita segue valendo", () => {
      expect(prop("Player Assists", "Neymar")).toMatchObject({ ok: true, status: "LOST" });
      expect(prop("Player Shots On Target", "Neymar Over 1.5 chutes no gol")).toMatchObject({ ok: true, status: "WON" });
    });

    it("na perna do Criar Aposta a negação vai para manual, não para LOST", () => {
      const result = resolveTicketFromScore(
        ticketBet({
          evento: santos,
          esporte: "Soccer",
          selecao: "Santos + Neymar - Não",
          legsJson: {
            kind: "same_game",
            legs: [
              { evento: santos, mercado: "Money Line – Match", selecao: "Santos" },
              { evento: santos, mercado: "Player Assists", selecao: "Neymar - Não" },
            ],
          },
        }),
        { homeScore: 2, awayScore: 0, odds: 2, stake: 1, players: [neymar] },
      );
      expect(result).toEqual({ ok: false, reason: "stat_qualifier" });
    });
  });

  it("não confunde faltas sofridas com cometidas quando os textos se contradizem", () => {
    expect(classificarPropDeJogador({
      mercado: "Player Fouls Suffered",
      selecao: "Willian Jose over 0.5 comete faltas",
      evento: "Bahia vs Vasco da Gama",
      esporte: "Soccer",
    })).toBeNull();
    expect(classificarPropDeJogador({
      mercado: "Player Fouls",
      selecao: "Willian Jose over 0.5 faltas sofridas",
      evento: "Bahia vs Vasco da Gama",
      esporte: "Soccer",
    })).toBeNull();
  });

  it("protege Both Teams Cards antes da heurística de nome de jogador", () => {
    expect(classificarPropDeJogador({
      mercado: "Both Teams Cards – Match",
      selecao: "Both Teams Over 0.5 cards",
      evento: EVENTO,
      esporte: "Soccer",
    })).toBeNull();
    expect(classificarPropDeJogador({
      mercado: "Moneyline",
      selecao: "Both Teams Over 0.5 cards",
      evento: EVENTO,
      esporte: "Soccer",
    })).toBeNull();
    expect(coerceMercadoPelaSelecao(
      "Moneyline",
      "Both Teams Over 0.5 cards",
      "Soccer",
      EVENTO,
    )).toBe("Both Teams Cards – Match");
  });

  it("não classifica nem coage props fora do futebol", () => {
    expect(classificarPropDeJogador({
      mercado: "Total Points",
      selecao: "Jayson Tatum over 2.5 faltas",
      evento: "Boston Celtics vs Miami Heat",
      esporte: "Basketball",
    })).toBeNull();
    expect(classificarPropDeJogador({
      mercado: "Player Shots",
      selecao: "Connor McDavid over 2.5 shots",
      evento: "Edmonton Oilers vs Calgary Flames",
      esporte: "Hockey",
    })).toBeNull();
    expect(coerceMercadoPelaSelecao(
      "Moneyline",
      "Connor McDavid over 2.5 shots",
      "Hockey",
      "Edmonton Oilers vs Calgary Flames",
    )).toBe("Moneyline");
  });

  it("preserva o período parcial e recusa usar o agregado FT", () => {
    expect(classificarPropDeJogador({
      mercado: "Player Shots - 1st Half",
      selecao: "Vinicius Junior over 0.5 shots",
      evento: EVENTO,
      esporte: "Soccer",
    })).toMatchObject({ family: "shots_total", period: "HT" });
    expect(coerceMercadoPelaSelecao(
      "Player Shots - 1st Half",
      "Vinicius Junior over 0.5 shots",
      "Soccer",
      EVENTO,
    )).toBe("Player Shots - 1st Half");
    expect(resolvePlayerProp({
      mercado: "Player Shots - 1st Half",
      selecao: "Vinicius Junior over 0.5 shots",
      evento: EVENTO,
      esporte: "Soccer",
      jogadores: [{
        playerId: "v1",
        nome: "Junior Vinicius",
        gols: 0,
        golsContra: 0,
        minutosJogados: 90,
        stats: { SHOTS_TOTAL: 1 },
      }],
    })).toMatchObject({ ok: false, reason: "periodo_nao_suportado" });
  });

  it("DNP publicado com zero não vira desempenho zero", () => {
    const jogadores = normalizeFlashscorePlayers({
      players: [{
        player_id: "dnp-1",
        name: "Guaraz Ivan",
        in_base_lineup: false,
        stats: {
          MATCH_MINUTES_PLAYED: { raw_value: "0" },
          SHOTS_TOTAL: { raw_value: "0" },
        },
      }],
    });
    expect(jogadores[0]).toMatchObject({ minutosJogados: 0, titular: false });
    expect(resolvePlayerProp({
      mercado: "Player Shots",
      selecao: "Ivan Guaraz over 0.5 shots",
      evento: "Time A vs Time B",
      esporte: "Soccer",
      jogadores,
    })).toMatchObject({ ok: false, reason: "jogador_nao_participou" });
  });

  it("zero sem minutos não prova participação; reserva que entrou pode perder por zero", () => {
    const base = {
      playerId: "r1",
      nome: "Reserva Real",
      gols: 0,
      golsContra: 0,
      titular: false,
      stats: { SHOTS_TOTAL: 0 },
    } as const;
    expect(resolvePlayerProp({
      mercado: "Player Shots",
      selecao: "Reserva Real over 0.5 shots",
      evento: "Time A vs Time B",
      esporte: "Soccer",
      jogadores: [base],
    })).toMatchObject({ ok: false, reason: "participacao_nao_comprovada" });
    expect(resolvePlayerProp({
      mercado: "Player Shots",
      selecao: "Reserva Real over 0.5 shots",
      evento: "Time A vs Time B",
      esporte: "Soccer",
      jogadores: [{ ...base, minutosJogados: 12 }],
    })).toMatchObject({ ok: true, status: "LOST", valor: 0 });
  });

  it("segundo amarelo e cartão genérico permanecem manuais", () => {
    const jogador = {
      playerId: "c1",
      nome: "Emanuel Coronel",
      gols: 0,
      golsContra: 0,
      minutosJogados: 83,
      stats: { CARDS_YELLOW: 0, CARDS_RED: 1, CARDS_YELLOW_SECOND: 1 },
    } as const;
    expect(resolvePlayerProp({
      mercado: "Player Cards",
      selecao: "Emanuel Coronel over 0.5 cards",
      evento: EVENTO,
      esporte: "Soccer",
      jogadores: [jogador],
    })).toMatchObject({ ok: false, reason: "convencao_de_cartoes_ambigua" });
    expect(resolvePlayerProp({
      mercado: "Player Cards",
      selecao: "Emanuel Coronel over 0.5 red cards",
      evento: EVENTO,
      esporte: "Soccer",
      jogadores: [jogador],
    })).toMatchObject({ ok: false, reason: "convencao_de_cartoes_ambigua" });
  });

  it("cor explícita sem segundo amarelo usa a chave publicada", () => {
    expect(resolvePlayerProp({
      mercado: "Player Cards",
      selecao: "Casemiro over 0.5 yellow cards",
      evento: EVENTO,
      esporte: "Soccer",
      jogadores: [{
        playerId: "c2",
        nome: "Casemiro",
        gols: 0,
        golsContra: 0,
        minutosJogados: 90,
        stats: { CARDS_YELLOW: 1, CARDS_YELLOW_SECOND: 0 },
      }],
    })).toMatchObject({
      ok: true,
      status: "WON",
      family: "cards_yellow",
      chave: "CARDS_YELLOW",
      valor: 1,
    });
  });
});

describe("prop de jogador fora do futebol não liquida com estatística de time", () => {
  const evento = "Boston Celtics vs Miami Heat";
  const teamRebounds = { rebounds: { home: 40, away: 38 } };

  it("Tatum over 10.5 rebounds recusa o agregado 40-38", () => {
    const result = resolveResultFromStatistics({
      mercado: "Moneyline",
      selecao: "Tatum over 10.5 rebounds",
      evento,
      odds: 1.9,
      stake: 100,
      stats: teamRebounds,
    });
    expect(result.ok).toBe(false);
  });

  it("linha de time ainda resolve rebotes do lado", () => {
    expect(resolveResultFromStatistics({
      mercado: "Team Total Rebounds",
      selecao: "Boston Celtics Over 10.5",
      evento,
      odds: 1.9,
      stake: 100,
      stats: teamRebounds,
    })).toMatchObject({ ok: true, status: "WON", statistic: "rebounds" });
    expect(resolveResultFromStatistics({
      mercado: "Moneyline",
      selecao: "Over 10.5 rebounds",
      evento,
      odds: 1.9,
      stake: 1,
      stats: teamRebounds,
    })).toMatchObject({ ok: true, status: "WON", statistic: "rebounds" });
  });

  it("Jayson Tatum over 25.5 points não paga o placar 112-108", () => {
    expect(
      classifyScoreMarket(
        normalizeStr("Total Points"),
        normalizeStr("Jayson Tatum over 25.5 points"),
        evento,
      ),
    ).toBeNull();
    const result = resolveResultFromScore({
      mercado: "Total Points",
      selecao: "Jayson Tatum over 25.5 points",
      evento,
      esporte: "Basketball",
      homeScore: 112,
      awayScore: 108,
      odds: 1.9,
      stake: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) expect(result.status).not.toBe("WON");
  });

  it("com a direção abreviada ('Tatum O 25.5') o atleta também não paga o placar", () => {
    expect(resolveResultFromScore({
      mercado: "Total Points", selecao: "Tatum O 25.5", evento, esporte: "Basketball",
      homeScore: 112, awayScore: 108, odds: 1.9, stake: 100,
    })).toEqual({ ok: false, reason: "unsupported_market" });
  });
});

function ticketBet(over: Partial<EligibleBet> & Pick<EligibleBet, "evento" | "selecao">): EligibleBet {
  return {
    id: "bet-sgp",
    esporte: "Basketball",
    competicao: "NBA",
    pais: "USA",
    mercado: "Moneyline",
    odds: 1.9,
    stake: 100,
    status: "PENDING",
    data: new Date("2026-01-15T00:00:00Z"),
    registradoEm: new Date("2026-01-14T18:00:00Z"),
    liveTextAtCapture: false,
    sharp: null,
    closing: null,
    result: null,
    ...over,
  };
}

describe("ticket/SGP não liquida prop de atleta pelo placar", () => {
  const evento = "Boston Celtics vs Miami Heat";
  const score = { homeScore: 112, awayScore: 108, odds: 1.9, stake: 100 };

  it("Tatum over 10.5 rebounds simples continua recusado", () => {
    const result = resolveTicketFromScore(
      ticketBet({ evento, selecao: "Tatum over 10.5 rebounds" }),
      score,
    );
    expect(result.ok).toBe(false);
  });

  it("Celtics ML + Tatum over 25.5 não paga o agregado 112-108", () => {
    const selecao = "Celtics ML + Tatum over 25.5";
    const ticket = parseBetLegs(evento, selecao);
    expect(ticket?.kind).toBe("same_game");
    expect(ticket?.legs[1]?.selecao).toBe("Tatum over 25.5");
    const result = resolveTicketFromScore(ticketBet({ evento, selecao }), score);
    expect(result.ok).toBe(false);
  });

  it("Tatum over 10.5 rebounds + Celtics ML não vira total de jogo", () => {
    const result = resolveTicketFromScore(
      ticketBet({ evento, selecao: "Tatum over 10.5 rebounds + Celtics ML" }),
      score,
    );
    expect(result.ok).toBe(false);
  });

  it("Celtics -3.5 + Tatum over 25.5 points não liquida a prop", () => {
    const result = resolveTicketFromScore(
      ticketBet({ evento, selecao: "Celtics -3.5 + Tatum over 25.5 points" }),
      score,
    );
    expect(result.ok).toBe(false);
  });

  it("total de time e Over sem prefixo de atleta ainda liquidam", () => {
    // Total do time pelos pontos DO TIME: o Heat fez 108, o jogo somou 220.
    expect(resolveTicketFromScore(
      ticketBet({ evento, selecao: "Celtics ML + Boston Celtics Over 110.5" }),
      score,
    )).toMatchObject({ ok: true, status: "WON" });
    expect(resolveTicketFromScore(
      ticketBet({ evento, selecao: "Celtics ML + Miami Heat Over 110.5" }),
      score,
    )).toMatchObject({ ok: true, status: "LOST" });
    expect(resolveTicketFromScore(
      ticketBet({ evento, selecao: "Over 10.5", mercado: "Total" }),
      score,
    )).toMatchObject({ ok: true, status: "WON" });
  });
});

const CORPUS = path.resolve(
  __dirname,
  "../fixtures/flashscore-player-stats-mapcwrtb.json",
);

const jogadoresDoCorpus = normalizeFlashscorePlayers(
  flashscorePlayerStatsResponseSchema.parse(
    JSON.parse(readFileSync(CORPUS, "utf8")),
  ),
);

const satelites = [
  {
    selecao: "David Duarte over 4.5 interceptions",
    family: "interceptions",
    mercado: "Player Interceptions",
    chave: "INTERCEPTIONS",
    valor: 5,
  },
  {
    selecao: "Rodrigo Nestor over 3.5 key passes",
    family: "key_passes",
    mercado: "Player Key Passes",
    chave: "KEY_PASSES",
    valor: 4,
  },
  {
    selecao: "Alejo Veliz over 1.5 offsides",
    family: "offsides",
    mercado: "Player Offsides",
    chave: "OFFSIDES",
    valor: 2,
  },
  {
    selecao: "Ronaldo over 2.5 saves",
    family: "saves_total",
    mercado: "Player Saves",
    chave: "SAVES_TOTAL",
    valor: 3,
  },
] as const;

describe("props satélites de futebol medidas no corpus MapCWrTb", () => {
  it.each(satelites)("classifica e canoniza $chave como prop de jogador", (caso) => {
    expect(classificarPropDeJogador({
      mercado: "Total – Match",
      selecao: caso.selecao,
      evento: BAHIA_VASCO,
      esporte: "Soccer",
    })).toEqual({ family: caso.family, mercado: caso.mercado });
    expect(coerceMercadoPelaSelecao(
      "Total – Match",
      caso.selecao,
      "Soccer",
      BAHIA_VASCO,
    )).toBe(caso.mercado);
  });

  it.each([
    ["Interceptações do Jogador", "David Duarte over 4.5", "interceptions", "Player Interceptions"],
    ["Passes Decisivos do Jogador", "Rodrigo Nestor over 3.5", "key_passes", "Player Key Passes"],
    ["Impedimentos do Jogador", "Alejo Veliz over 1.5", "offsides", "Player Offsides"],
    ["Defesas do Goleiro", "Ronaldo over 2.5", "saves_total", "Player Saves"],
  ] as const)("liquida %s sem apresentá-lo como mercado oficial Pinnacle", (mercado, selecao, family, canonico) => {
    expect(classificarPropDeJogador({
      mercado,
      selecao,
      evento: BAHIA_VASCO,
      esporte: "Soccer",
    })).toMatchObject({ family });
    expect(resolveMercadoStatic(mercado)).toBeNull();
    expect(isMercadoFinal(canonico)).toBe(false);
  });

  it.each(satelites)("liquida $chave pelo jogador casado, não por placar/time", (caso) => {
    expect(resolvePlayerProp({
      mercado: "Total – Match",
      selecao: caso.selecao,
      evento: BAHIA_VASCO,
      esporte: "Soccer",
      jogadores: jogadoresDoCorpus,
    })).toMatchObject({
      ok: true,
      status: "WON",
      family: caso.family,
      chave: caso.chave,
      valor: caso.valor,
    });
  });

  it("preserva as quatro chaves inteiras e os minutos publicados pelo corpus", () => {
    const ronaldo = jogadoresDoCorpus.find((jogador) => jogador.nome === "Ronaldo");
    const nestor = jogadoresDoCorpus.find((jogador) => jogador.nome === "Rodrigo Nestor");
    expect(ronaldo).toMatchObject({
      minutosJogados: 90,
      stats: { INTERCEPTIONS: 0, KEY_PASSES: 0, OFFSIDES: 0, SAVES_TOTAL: 3 },
    });
    expect(nestor).toMatchObject({
      minutosJogados: 86,
      stats: { INTERCEPTIONS: 1, KEY_PASSES: 4, OFFSIDES: 0, SAVES_TOTAL: 0 },
    });
  });
});

describe("props satélites: recusas permanecem fail-closed", () => {
  it("chave ausente continua diferente de zero", () => {
    const jogadores = normalizeFlashscorePlayers({
      players: [{
        player_id: "d1",
        name: "David Duarte",
        stats: {
          MATCH_MINUTES_PLAYED: { raw_value: "90" },
          KEY_PASSES: { raw_value: "0" },
        },
      }],
    });
    expect(jogadores[0]?.stats?.["INTERCEPTIONS"]).toBeUndefined();
    expect(resolvePlayerProp({
      mercado: "Player Interceptions",
      selecao: "David Duarte over 0.5 interceptions",
      evento: BAHIA_VASCO,
      esporte: "Soccer",
      jogadores,
    })).toMatchObject({ ok: false, reason: "stat_ausente" });
  });

  it("zero só liquida quando MATCH_MINUTES_PLAYED comprova participação", () => {
    const base = {
      playerId: "w1",
      nome: "Willian Jose",
      gols: 0,
      golsContra: 0,
      stats: { OFFSIDES: 0 },
    } as const;
    const params = {
      mercado: "Player Offsides",
      selecao: "Willian Jose over 0.5 offsides",
      evento: BAHIA_VASCO,
      esporte: "Soccer",
    } as const;
    expect(resolvePlayerProp({ ...params, jogadores: [base] }))
      .toMatchObject({ ok: false, reason: "participacao_nao_comprovada" });
    expect(resolvePlayerProp({
      ...params,
      jogadores: [{ ...base, minutosJogados: 64 }],
    })).toMatchObject({ ok: true, status: "LOST", valor: 0 });
  });

  it("não transforma estatística de time em prop de jogador", () => {
    expect(classificarPropDeJogador({
      mercado: "Total – Match",
      selecao: "Bahia over 8.5 interceptions",
      evento: BAHIA_VASCO,
      esporte: "Soccer",
    })).toBeNull();
  });

  it("recusa período parcial e esporte não medido", () => {
    expect(resolvePlayerProp({
      mercado: "Player Key Passes - 1st Half",
      selecao: "Rodrigo Nestor over 0.5 key passes",
      evento: BAHIA_VASCO,
      esporte: "Soccer",
      jogadores: jogadoresDoCorpus,
    })).toMatchObject({ ok: false, reason: "periodo_nao_suportado" });
    expect(classificarPropDeJogador({
      mercado: "Player Saves",
      selecao: "Jayson Tatum over 2.5 saves",
      evento: "Boston Celtics vs Miami Heat",
      esporte: "Basketball",
    })).toBeNull();
  });

  it("MATCH_MINUTES_PLAYED continua filtro; cards_any/2º amarelo não são abertos", () => {
    expect(classificarPropDeJogador({
      mercado: "Player Minutes",
      selecao: "Willian Jose over 60.5 minutes played",
      evento: BAHIA_VASCO,
      esporte: "Soccer",
    })).toBeNull();
    expect(resolvePlayerProp({
      mercado: "Player Cards",
      selecao: "David Duarte over 0.5 cards",
      evento: BAHIA_VASCO,
      esporte: "Soccer",
      jogadores: jogadoresDoCorpus,
    })).toMatchObject({ ok: false, reason: "convencao_de_cartoes_ambigua" });
  });
});


describe("props sem contrato persistido: linha escrita e qualificadores", () => {
  const jogadores = [{ playerId: "tom", nome: "Tom Fellows", gols: 0, golsContra: 0,
    participou: true, minutosJogados: 90, stats: { ASSISTS_GOAL: 1, PASSES_TOTAL: 90, CARDS_YELLOW: 1, CARDS_YELLOW_SECOND: 0 } }];
  it.each(["Tom Fellows Over 0.3", "Tom Fellows 0.5+", "Tom Fellows Over 0.5 Under 1.5"])(
    "linha inválida ou direção conflitante não herda Over 0.5: %s", (selecao) => {
      expect(resolvePlayerProp({ mercado: "Player Assists", selecao, esporte: "Soccer", jogadores }).ok).toBe(false);
    });
  it.each([
    ["Player Passes", "Tom Fellows Over 79.5% passes"],
    ["Player Assists", "Tom Fellows Over 0.5 & Win"],
  ])("qualificador na seleção não some: %s / %s", (mercado, selecao) => {
    expect(resolvePlayerProp({ mercado, selecao, esporte: "Soccer", jogadores }))
      .toEqual({ ok: false, reason: "qualificador_sem_contrato" });
  });
  it("rótulo que só nomeia as duas direções não é combinação", () => {
    expect(resolvePlayerProp({ mercado: "Jogador - Total de assistências - Acima ou Abaixo",
      selecao: "Tom Fellows Acima de 0.5", esporte: "Soccer", jogadores })).toMatchObject({ ok: true, status: "WON" });
    expect(resolvePlayerProp({ mercado: "Jogador - Assistências - Acima ou Abaixo",
      selecao: "Tom Fellows Abaixo de 0.5", esporte: "Soccer", jogadores })).toMatchObject({ ok: true, status: "LOST" });
  });
  it("\"ou\" seguido de outra estatística continua combinação", () => {
    expect(resolvePlayerProp({ mercado: "Jogador - Assistências ou Chutes - Acima ou Abaixo",
      selecao: "Tom Fellows Acima de 0.5", esporte: "Soccer", jogadores }))
      .toEqual({ ok: false, reason: "qualificador_sem_contrato" });
  });
  it("nome sem linha continua sendo ocorrência de assistência", () => {
    expect(resolvePlayerProp({ mercado: "Player Assists", selecao: "Tom Fellows", esporte: "Soccer", jogadores }))
      .toMatchObject({ ok: true, status: "WON" });
  });
});


it("prop com linha no mercado não vira ocorrência nominal de assistência", () => {
  expect(resolvePlayerProp({ mercado: "Player Assists Over 1.5", selecao: "Tom Fellows", esporte: "Soccer",
    jogadores: [{ playerId: "tom", nome: "Tom Fellows", gols: 0, golsContra: 0,
      participou: true, minutosJogados: 90, stats: { ASSISTS_GOAL: 1 } }] }).ok).toBe(false);
});
