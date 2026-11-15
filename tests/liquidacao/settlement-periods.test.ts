import { describe, expect, it } from "vitest";
import { BetStatus } from "@/src/generated/prisma/enums";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { soccerPeriodScores } from "@/src/providers/flashscore/soccer-periods";
import { ehMercadoArtilheiroPorTempo } from "@/src/domain/settlement/goalscorer";
import { temPolaridadeNegativa } from "@/src/domain/settlement/goalscorer-matching";
import { resolvePeriodGoalscorer, periodoDoMinuto } from "@/src/domain/settlement/goalscorer-period";
import { resolveTicketFromScore } from "@/src/domain/settlement/ticket-resolution";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";

/**
 * Liquidação por tempo: criar-aposta com pernas de 1º e 2º tempo é UMA aposta,
 * medida por três placares diferentes. Liquidar "Mais de 0.5 no 1º tempo"
 * contra o placar de 90 minutos daria ganho falso; os parciais vêm de
 * `/matches/details`, que declara os dois tempos separados (payload real de
 * Coventry x Aston Villa: 1-2 no 1º tempo, 0-1 no 2º, 1-3 final).
 */
const detalhesReais = {
  match_id: "Y59R9JJN",
  sport: { sport_id: 1 },
  match_status: {
    stage: "Finished", is_started: true, is_finished: true, is_in_progress: false,
    is_cancelled: false, is_postponed: false, live_time: null, live_minute: null,
  },
  scores: {
    home: 1, away: 3, home_total: 1, away_total: 3,
    home_1st_half: 1, away_1st_half: 2, home_2nd_half: 0, away_2nd_half: 1,
    home_extra_time: null, away_extra_time: null,
  },
};

const aposta = (over: Partial<EligibleBet> = {}): EligibleBet => ({
  id: "bet-1", evento: "LDU Quito vs Palmeiras", esporte: "Soccer",
  mercado: "Criar Aposta", selecao: "Criar Aposta", odds: 2.15, stake: 600,
  status: BetStatus.PENDING, legsJson: null, liveScoreHome: null, liveScoreAway: null,
  ...over,
} as unknown as EligibleBet);

describe("parciais do FlashScore", () => {
  it("extrai os dois tempos do payload real", () => {
    const r = soccerPeriodScores(detalhesReais);
    expect(r).toEqual({ ok: true, scores: {
      matchId: "Y59R9JJN",
      ht: { home: 1, away: 2 }, sh: { home: 0, away: 1 }, regulation: { home: 1, away: 3 },
    } });
  });

  it.each([
    { matchId: "outro", score: { home: 1, away: 3 } },
    { matchId: "Y59R9JJN", score: { home: 3, away: 1 } },
  ])("parciais exigem identidade e placar da leitura casada: %j", (expected) => {
    expect(soccerPeriodScores(detalhesReais, expected))
      .toEqual({ ok: false, reason: "partida_ou_placar_divergente" });
  });

  it("recusa quando os tempos não somam o total — placar inventado não liquida", () => {
    const torto = { ...detalhesReais, scores: { ...detalhesReais.scores, home_2nd_half: 5 } };
    expect(soccerPeriodScores(torto)).toEqual({ ok: false, reason: "tempos_nao_somam_o_total" });
  });

  it("desconta a prorrogação antes de fechar a conta", () => {
    const comProrrogacao = { ...detalhesReais, scores: {
      ...detalhesReais.scores, home: 2, home_total: 2, home_extra_time: 1, away_extra_time: 0,
    } };
    expect(soccerPeriodScores(comProrrogacao)).toMatchObject({ ok: true, scores: { regulation: { home: 1, away: 3 } } });
  });

  it("recusa jogo em andamento", () => {
    const aoVivo = { ...detalhesReais, match_status: { ...detalhesReais.match_status, is_finished: false, is_in_progress: true } };
    expect(soccerPeriodScores(aoVivo)).toEqual({ ok: false, reason: "details_fora_do_contrato" });
  });
});

describe("criar-aposta com pernas de tempos diferentes", () => {
  const parciais = { ht: { home: 1, away: 2 }, sh: { home: 0, away: 1 } };
  const legs = {
    kind: "same_game",
    legs: [
      { evento: "LDU Quito vs Palmeiras", mercado: "Total de gols - 1º Tempo", selecao: "Over 0.5" },
      { evento: "LDU Quito vs Palmeiras", mercado: "Total de gols - 2º Tempo", selecao: "Over 0.5" },
      { evento: "LDU Quito vs Palmeiras", mercado: "Total – Match", selecao: "Over 1.5" },
    ],
  };
  const params = { homeScore: 1, awayScore: 3, odds: 2.15, stake: 600 };

  it("liquida a aposta do print: 3 gols no 1º tempo, 1 no 2º, 4 no jogo", () => {
    const r = resolveTicketFromScore(aposta({ legsJson: legs }), { ...params, periodScores: parciais });
    expect(r).toMatchObject({ ok: true, status: BetStatus.WON });
  });

  it("sem os parciais, continua caindo para manual em vez de chutar", () => {
    expect(resolveTicketFromScore(aposta({ legsJson: legs }), params))
      .toEqual({ ok: false, reason: "wrong_period" });
  });

  it("uma perna de tempo perdida derruba o bilhete inteiro", () => {
    const semGolNoSegundo = { ht: { home: 1, away: 2 }, sh: { home: 0, away: 0 } };
    expect(resolveTicketFromScore(aposta({ legsJson: legs }), { ...params, homeScore: 1, awayScore: 2, periodScores: semGolNoSegundo }))
      .toMatchObject({ ok: true, status: BetStatus.LOST });
  });

  it("aposta SIMPLES de 1º tempo também passa a liquidar", () => {
    const simples = aposta({ mercado: "Total de gols - 1º Tempo", selecao: "Over 2.5" });
    expect(resolveTicketFromScore(simples, { ...params, periodScores: parciais }))
      .toMatchObject({ ok: true, status: BetStatus.WON });
    expect(resolveTicketFromScore(simples, params)).toEqual({ ok: false, reason: "wrong_period" });
  });

  it("o placar do período errado continua barrado no domínio", () => {
    // O risco central: 1º tempo medido pelo placar de 90 minutos.
    expect(resolveResultFromScore({
      mercado: "Total de gols - 1º Tempo", selecao: "Over 1.5", evento: "A vs B", esporte: "Soccer",
      homeScore: 3, awayScore: 0, odds: 2, stake: 1,
    })).toEqual({ ok: false, reason: "wrong_period" });
    // E o inverso: placar de 1º tempo não liquida mercado de jogo inteiro.
    expect(resolveResultFromScore({
      mercado: "Total – Match", selecao: "Over 1.5", evento: "A vs B", esporte: "Soccer",
      homeScore: 0, awayScore: 0, odds: 2, stake: 1, scorePeriod: "HT",
    })).toEqual({ ok: false, reason: "wrong_period" });
  });
});

describe("placar ao vivo em mercado de tempo", () => {
  // 2º tempo 1–0, entrada já em 1–0 (gol do 1º tempo), Flamengo −0,5. O placar
  // ao vivo é do jogo inteiro; descontá-lo do placar do 2º tempo daria 0–0 e a
  // aposta ganha sairia perdida.
  const handicap2T = {
    mercado: "Handicap Asiático - 2º Tempo", selecao: "Flamengo -0.5", evento: "Flamengo vs Palmeiras",
    esporte: "Soccer", homeScore: 1, awayScore: 0, odds: 1.9, stake: 10,
  };

  it("2º tempo com placar ao vivo vai para a mão, como o 1º", () => {
    expect(resolveResultFromScore({ ...handicap2T, scorePeriod: "SECOND_HALF", liveScoreHome: 1, liveScoreAway: 0 }))
      .toEqual({ ok: false, reason: "unsupported_live_score" });
    expect(resolveResultFromScore({ ...handicap2T, mercado: "Handicap Asiático - 1º Tempo", scorePeriod: "HT", liveScoreHome: 1, liveScoreAway: 0 }))
      .toEqual({ ok: false, reason: "unsupported_live_score" });
  });

  it("legenda que dizia ao vivo barra o tempo mesmo sem placar gravado", () => {
    expect(resolveResultFromScore({ ...handicap2T, scorePeriod: "SECOND_HALF", liveTextAtCapture: true }))
      .toEqual({ ok: false, reason: "unsupported_live_score" });
  });

  it("2º tempo sem placar ao vivo continua liquidando", () => {
    expect(resolveResultFromScore({ ...handicap2T, scorePeriod: "SECOND_HALF" }))
      .toMatchObject({ ok: true, status: BetStatus.WON });
  });
});

/**
 * Perna de artilheiro numa criar-aposta. Cenário: Fleetwood x
 * Sheffield United com "Mais de 2.5", "Sheffield no 1º tempo" e "Jordan Ayew
 * marcar". O resolvedor de gol é o MESMO da aposta simples — recusa homônimo,
 * nome ausente, gol contra e linha negativa —, então a perna nunca vira chute.
 */
describe("criar-aposta com perna de artilheiro", () => {
  const jogador = (nome: string, gols: number, over: Record<string, unknown> = {}) =>
    ({ playerId: `p-${nome}`, nome, gols, golsContra: 0, minutosJogados: 90, ...over });
  const jogadores = [jogador("Ayew Jordan", 1), jogador("Campbell Tyrese", 0)];
  const legs = {
    kind: "same_game",
    legs: [
      { evento: "Fleetwood Town vs Sheffield United", mercado: "Total – Match", selecao: "Over 2.5" },
      { evento: "Fleetwood Town vs Sheffield United", mercado: "Marcar a Qualquer Momento", selecao: "Jordan Ayew" },
    ],
  };
  const bet = aposta({ evento: "Fleetwood Town vs Sheffield United", legsJson: legs, odds: 8.16, stake: 100 });
  const params = { homeScore: 1, awayScore: 2, odds: 8.16, stake: 100 };

  it("liquida quando o jogador marcou e o total bateu", () => {
    expect(resolveTicketFromScore(bet, { ...params, players: jogadores }))
      .toMatchObject({ ok: true, status: BetStatus.WON });
  });

  it("jogador sem gol derruba o bilhete", () => {
    const semGol = [jogador("Ayew Jordan", 0), jogador("Campbell Tyrese", 0)];
    expect(resolveTicketFromScore(bet, { ...params, players: semGol }))
      .toMatchObject({ ok: true, status: BetStatus.LOST });
  });

  it("sem a lista de jogadores, cai para manual em vez de chutar", () => {
    expect(resolveTicketFromScore(bet, params)).toEqual({ ok: false, reason: "stat_qualifier" });
  });

  it("nome ambíguo não liquida — dois Ayew na partida", () => {
    const doisAyew = [jogador("Ayew Jordan", 1), jogador("Ayew Andre", 0)];
    expect(resolveTicketFromScore(aposta({
      evento: "Fleetwood Town vs Sheffield United", odds: 8.16, stake: 100,
      legsJson: { kind: "same_game", legs: [
        { evento: "Fleetwood Town vs Sheffield United", mercado: "Total – Match", selecao: "Over 2.5" },
        { evento: "Fleetwood Town vs Sheffield United", mercado: "Marcar a Qualquer Momento", selecao: "Ayew" },
      ] },
    }), { ...params, players: doisAyew })).toEqual({ ok: false, reason: "stat_qualifier" });
  });

  it("perna PERDIDA decide o bilhete mesmo com a de artilheiro irresolvível", () => {
    // Total não bateu: não importa quem marcou, criar-aposta só paga com todas.
    expect(resolveTicketFromScore(bet, { ...params, homeScore: 0, awayScore: 1 }))
      .toMatchObject({ ok: true, status: BetStatus.LOST });
  });
});

/**
 * Props de jogador e gol POR TEMPO nas pernas.
 *
 * As 103 estatísticas por jogador do FlashScore são todas do jogo inteiro
 * (conferido no payload real): chute no 1º tempo não existe no
 * feed e continua manual. Gol por tempo existe, mas em outra fonte — o minuto
 * de cada gol, no resumo da partida.
 */
describe("props de jogador nas pernas", () => {
  const comStats = (nome: string, stats: Record<string, number>, gols = 0) =>
    ({ playerId: `p-${nome}`, nome, gols, golsContra: 0, minutosJogados: 90, stats });
  const jogadores = [
    comStats("Ayew Jordan", { SHOTS_TOTAL: 4, CARDS_YELLOW: 1, TACKLES_TOTAL: 2 }, 1),
    comStats("Campbell Tyrese", { SHOTS_TOTAL: 0, CARDS_YELLOW: 0, TACKLES_TOTAL: 5 }),
  ];
  const ticket = (mercado: string, selecao: string) => aposta({
    evento: "Fleetwood Town vs Sheffield United", odds: 5, stake: 100,
    legsJson: { kind: "same_game", legs: [
      { evento: "Fleetwood Town vs Sheffield United", mercado: "Total – Match", selecao: "Over 2.5" },
      { evento: "Fleetwood Town vs Sheffield United", mercado, selecao },
    ] },
  });
  const params = { homeScore: 1, awayScore: 2, odds: 5, stake: 100 };

  it("finalizações do jogador resolvem a perna", () => {
    expect(resolveTicketFromScore(ticket("Jogador - Finalizações", "Jordan Ayew Over 2.5"), { ...params, players: jogadores }))
      .toMatchObject({ ok: true, status: BetStatus.WON });
    expect(resolveTicketFromScore(ticket("Jogador - Finalizações", "Jordan Ayew Over 5.5"), { ...params, players: jogadores }))
      .toMatchObject({ ok: true, status: BetStatus.LOST });
  });

  it("sem a lista de jogadores, a perna de prop cai para manual", () => {
    expect(resolveTicketFromScore(ticket("Jogador - Finalizações", "Jordan Ayew Over 2.5"), params))
      .toEqual({ ok: false, reason: "stat_qualifier" });
  });
});

describe("gol por tempo", () => {
  const jogadores = [
    { playerId: "p-ayew", nome: "Ayew Jordan", gols: 1, golsContra: 0, minutosJogados: 90 },
    { playerId: "p-tyrese", nome: "Campbell Tyrese", gols: 0, golsContra: 0, minutosJogados: 90 },
  ];
  const golAos30 = [{ playerId: "p-ayew", nome: "Ayew Jordan", minuto: "30", ordinal: 1 }];
  const golAos70 = [{ playerId: "p-ayew", nome: "Ayew Jordan", minuto: "70", ordinal: 1 }];

  it("o acréscimo pertence ao tempo que termina", () => {
    expect(periodoDoMinuto("45+2")).toBe("HT");
    expect(periodoDoMinuto("46")).toBe("SECOND_HALF");
    expect(periodoDoMinuto("90+4")).toBe("SECOND_HALF");
    // Prorrogação não é 2º tempo: o mercado é dos 45 regulamentares.
    expect(periodoDoMinuto("105")).toBe("OTHER");
  });

  it("gol aos 30 ganha no 1º tempo e perde no 2º", () => {
    const base = { selecao: "Jordan Ayew", mercado: "Marcar no 1º Tempo", jogadores, gols: golAos30 };
    expect(resolvePeriodGoalscorer({ ...base, periodo: "HT" })).toMatchObject({ ok: true, status: "WON" });
    expect(resolvePeriodGoalscorer({ ...base, periodo: "SECOND_HALF" })).toMatchObject({ ok: true, status: "LOST" });
  });

  it("gol aos 70 é do 2º tempo", () => {
    expect(resolvePeriodGoalscorer({ selecao: "Jordan Ayew", jogadores, gols: golAos70, periodo: "SECOND_HALF" }))
      .toMatchObject({ ok: true, status: "WON" });
  });

  it("resumo que não explica todos os gols do jogador não liquida", () => {
    // A estatística dá 1 gol ao Ayew e o resumo não traz nenhum: "não marcou no
    // 1º tempo" não está provado.
    expect(resolvePeriodGoalscorer({ selecao: "Jordan Ayew", jogadores, gols: [], periodo: "HT" }))
      .toEqual({ ok: false, reason: "gols_inconsistentes" });
  });

  it("gol no outro tempo prova a entrada mesmo sem minutos publicados", () => {
    const semMinutos = [{ playerId: "p-ayew", nome: "Ayew Jordan", gols: 1, golsContra: 0 }];
    expect(resolvePeriodGoalscorer({ selecao: "Jordan Ayew", jogadores: semMinutos, gols: golAos30, periodo: "SECOND_HALF" }))
      .toMatchObject({ ok: true, status: "LOST" });
  });

  it("sem gol no período e sem minutos publicados, recusa como o tempo integral", () => {
    const semMinutos = [{ playerId: "p-9", nome: "Reserva Fulano", gols: 0, golsContra: 0 }];
    expect(resolvePeriodGoalscorer({ selecao: "Fulano Reserva", jogadores: semMinutos, gols: golAos30, periodo: "HT" }))
      .toEqual({ ok: false, reason: "participacao_nao_comprovada" });
  });

  it("mantém as recusas do caminho de tempo integral", () => {
    const doisAyew = [
      { playerId: "p-1", nome: "Ayew Jordan", gols: 1, golsContra: 0, minutosJogados: 90 },
      { playerId: "p-2", nome: "Ayew Andre", gols: 0, golsContra: 0, minutosJogados: 90 },
    ];
    expect(resolvePeriodGoalscorer({ selecao: "Ayew", jogadores: doisAyew, gols: golAos30, periodo: "HT" }))
      .toMatchObject({ ok: false, reason: "jogador_ambiguo" });
    expect(resolvePeriodGoalscorer({ selecao: "Jordan Ayew não marcar", jogadores, gols: golAos30, periodo: "HT" }))
      .toMatchObject({ ok: false, reason: "polaridade_negativa" });
    const naoJogou = [{ ...jogadores[0]!, minutosJogados: 0, gols: 0 }];
    expect(resolvePeriodGoalscorer({ selecao: "Jordan Ayew", jogadores: naoJogou, gols: [], periodo: "HT" }))
      .toMatchObject({ ok: true, status: "VOID" });
  });

  it("\"2+ no 1º tempo\" pede dois gols no período", () => {
    const doisGols = [{ playerId: "p-ayew", nome: "Ayew Jordan", gols: 2, golsContra: 0, minutosJogados: 90 }];
    const umNoPrimeiro = [
      { playerId: "p-ayew", nome: "Ayew Jordan", minuto: "30", ordinal: 1 },
      { playerId: "p-ayew", nome: "Ayew Jordan", minuto: "70", ordinal: 2 },
    ];
    expect(resolvePeriodGoalscorer({ selecao: "Jordan Ayew 2+", mercado: "Marcar no 1º Tempo", jogadores: doisGols, gols: umNoPrimeiro, periodo: "HT" }))
      .toMatchObject({ ok: true, status: "LOST", golsNoPeriodo: 1 });
  });

  it("na perna do bilhete, gol por tempo resolve com o minuto", () => {
    const bet = aposta({
      evento: "Fleetwood Town vs Sheffield United", odds: 8, stake: 100,
      legsJson: { kind: "same_game", legs: [
        { evento: "Fleetwood Town vs Sheffield United", mercado: "Total – Match", selecao: "Over 2.5" },
        { evento: "Fleetwood Town vs Sheffield United", mercado: "Marcar no 1º Tempo", selecao: "Jordan Ayew" },
      ] },
    });
    const params = { homeScore: 1, awayScore: 2, odds: 8, stake: 100, players: jogadores };
    expect(resolveTicketFromScore(bet, { ...params, goals: golAos30 })).toMatchObject({ ok: true, status: BetStatus.WON });
    expect(resolveTicketFromScore(bet, { ...params, goals: golAos70 })).toMatchObject({ ok: true, status: BetStatus.LOST });
    // Sem os minutos, manual.
    expect(resolveTicketFromScore(bet, params)).toEqual({ ok: false, reason: "stat_qualifier" });
  });
});

/**
 * Vocabulário do gol por tempo. Errar aqui recusa (direção segura), mas recusa
 * aposta que devia liquidar.
 */
describe("vocabulário do gol por tempo", () => {
  it("'no' português não é o 'No' inglês de negação", () => {
    // Lido como "não marcar", "marcar no 1º tempo" nunca liquidaria.
    expect(temPolaridadeNegativa("Marcar no 1º Tempo")).toBe(false);
    expect(temPolaridadeNegativa("Jordan Ayew", "Marcar no 2º tempo")).toBe(false);
    // A negação de verdade continua pega: rótulo no fim e antes do substantivo.
    expect(temPolaridadeNegativa("Haaland Erling No")).toBe(true);
    expect(temPolaridadeNegativa("No Goalscorer")).toBe(true);
    expect(temPolaridadeNegativa("Haaland - Não")).toBe(true);
    expect(temPolaridadeNegativa("Player Not To Score")).toBe(true);
  });

  it("reconhece as grafias reais, e só elas", () => {
    for (const mercado of ["Marcar no 1º Tempo", "Marcar a Qualquer Momento - 1º Tempo",
      "1st Half Goalscorer", "2nd Half Anytime Goalscorer"]) {
      expect(ehMercadoArtilheiroPorTempo(mercado, "Jordan Ayew"), mercado).toBe(true);
    }
    // Mercado de TIME resolve pelo placar e não pode virar prop de jogador.
    for (const mercado of ["Time da Casa Marcar", "Ambas Marcam", "Total de Gols - 1º Tempo",
      "Marcar a Qualquer Momento", "Primeiro a Marcar", "Primeiro a Marcar no 1º Tempo",
      "1st Half First Goalscorer"]) {
      expect(ehMercadoArtilheiroPorTempo(mercado, "Jordan Ayew"), mercado).toBe(false);
    }
  });
});
