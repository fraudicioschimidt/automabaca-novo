import { describe, expect, it } from "vitest";
import {
  resolveTicketFromScore,
  ticketFixtureEventos,
  ticketForScore,
} from "@/src/domain/settlement/ticket-resolution";
import type { EligibleBet } from "@/src/domain/settlement/ticket-resolution";

function bet(partial: Partial<EligibleBet> & Pick<EligibleBet, "evento" | "mercado" | "selecao">): EligibleBet {
  return {
    id: "bet-1",
    esporte: "Basketball",
    odds: 1.9,
    stake: 1,
    status: "PENDING",
    liveScoreHome: null,
    liveScoreAway: null,
    legsJson: null,
    captureEvidence: null,
    closing: null,
    sharp: null,
    data: new Date("2026-08-15T21:00:00Z"),
    ...partial,
  } as EligibleBet;
}

describe("ticketFixtureEventos", () => {
  it("lista confrontos da dupla gravada só no evento com pipe", () => {
    expect(ticketFixtureEventos(bet({
      evento: "France vs Morocco | Spain vs Italy",
      mercado: "Moneyline",
      selecao: "France / Spain",
    }))).toEqual(["France vs Morocco", "Spain vs Italy"]);
  });

  it("lista confrontos únicos da dupla e ignora ticket de um jogo", () => {
    expect(ticketFixtureEventos(bet({
      evento: "Mogi das cruzes x Bauru",
      mercado: "Moneyline",
      selecao: "Mogi ML + Mogi O89,5",
    }))).toEqual([]);
    expect(ticketFixtureEventos(bet({
      evento: "Mogi das Cruzes vs Bauru | Bayamon vs Aguadas",
      mercado: "Moneyline",
      selecao: "Mogi / Bayamon",
      legsJson: {
        kind: "parlay",
        legs: [
          { evento: "Mogi das Cruzes vs Bauru", mercado: "Moneyline", selecao: "Mogi" },
          { evento: "Bayamon vs Aguadas", mercado: "Moneyline", selecao: "Bayamon" },
        ],
      },
    }))).toEqual([
      "Mogi das Cruzes vs Bauru",
      "Bayamon vs Aguadas",
    ]);
  });
});

describe("ticketForScore", () => {
  it("reconstroi combo do mesmo jogo quando legsJson está ausente", () => {
    const ticket = ticketForScore(bet({
      evento: "Mogi das cruzes x Bauru",
      mercado: "Moneyline",
      selecao: "Mogi ML H5 FT + Mogi O89,5",
    }));
    expect(ticket?.kind).toBe("same_game");
    expect(ticket?.legs).toHaveLength(2);
  });
});

describe("resolveTicketFromScore", () => {
  it("liquida ML + Over do mesmo jogo pelo placar único", () => {
    const result = resolveTicketFromScore(
      bet({
        evento: "Mogi das cruzes x Bauru",
        mercado: "Moneyline",
        selecao: "Mogi ML + O150,5",
      }),
      { homeScore: 88, awayScore: 71, odds: 1.9, stake: 1 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("WON");
  });

  it("perna de total que nomeia o time não liquida pelo placar somado", () => {
    // 89.5 com o Mogi na frente é o total DO MOGI (fez 88), não do jogo (159).
    expect(resolveTicketFromScore(
      bet({ evento: "Mogi das cruzes x Bauru", mercado: "Moneyline", selecao: "Mogi ML + Mogi O89,5" }),
      { homeScore: 88, awayScore: 71, odds: 1.9, stake: 1 },
    )).toEqual({ ok: false, reason: "ambiguous_selection" });
  });

  describe("a perna guarda o período e o time da própria seleção", () => {
    const flamengo = { evento: "Flamengo vs Palmeiras", esporte: "Soccer" };
    const primeiroTempoZerado = {
      homeScore: 2, awayScore: 0, odds: 2.1, stake: 1,
      periodScores: { ht: { home: 0, away: 0 }, sh: { home: 2, away: 0 } },
    };
    const criarAposta = (legs: Array<{ mercado: string; selecao: string }>) => bet({
      ...flamengo,
      mercado: "Money Line – Match",
      selecao: "Flamengo",
      legsJson: { kind: "same_game", legs: legs.map((leg) => ({ evento: flamengo.evento, ...leg })) },
    });

    it("'Over 0.5 1T' usa o placar do 1º tempo", () => {
      const ticket = criarAposta([
        { mercado: "Total – Match", selecao: "Over 0.5 1T" },
        { mercado: "Money Line – Match", selecao: "Flamengo" },
      ]);
      expect(resolveTicketFromScore(ticket, primeiroTempoZerado)).toMatchObject({ ok: true, status: "LOST" });
      const { periodScores: _sem, ...semParciais } = primeiroTempoZerado;
      expect(resolveTicketFromScore(ticket, semParciais)).toEqual({ ok: false, reason: "wrong_period" });
    });

    it("pernas lidas do texto ('Over 0.5 HT + Over 1.5') também", () => {
      expect(resolveTicketFromScore(
        bet({ ...flamengo, mercado: "Criar Aposta", selecao: "Over 0.5 HT + Over 1.5" }),
        primeiroTempoZerado,
      )).toMatchObject({ ok: true, status: "LOST" });
    });

    it("sem legsJson, o período do mercado da aposta vale para as pernas lidas do texto", () => {
      const aposta = bet({ ...flamengo, mercado: "Total – 1st Half", selecao: "Over 0.5 + Flamengo" });
      expect(resolveTicketFromScore(aposta, primeiroTempoZerado)).toMatchObject({ ok: true, status: "LOST" });
    });

    it("total do time lê o lado do time nomeado", () => {
      const ticket = criarAposta([
        { mercado: "Team Total – Match", selecao: "Palmeiras Over 1.5" },
        { mercado: "Money Line – Match", selecao: "Flamengo" },
      ]);
      expect(resolveTicketFromScore(ticket, primeiroTempoZerado)).toMatchObject({ ok: true, status: "LOST" });
    });

    it("na múltipla de jogos diferentes a perna de 1º tempo não sai pelo placar final", () => {
      const result = resolveTicketFromScore(
        bet({
          ...flamengo,
          evento: "Flamengo vs Palmeiras | Santos vs Vasco",
          mercado: "Múltipla",
          selecao: "Múltipla",
          legsJson: {
            kind: "parlay",
            legs: [
              { evento: "Flamengo vs Palmeiras", mercado: "Total – Match", selecao: "Over 0.5 1T" },
              { evento: "Santos vs Vasco", mercado: "Money Line – Match", selecao: "Santos" },
            ],
          },
        }),
        {
          homeScore: 0, awayScore: 0, odds: 3, stake: 1,
          scoresByEvento: [
            { evento: "Flamengo vs Palmeiras", home: 2, away: 0 },
            { evento: "Santos vs Vasco", home: 1, away: 0 },
          ],
        },
      );
      expect(result).toEqual({ ok: false, reason: "incomplete_legs" });
    });
  });

  it("não aplica o placar de um jogo nas duas pernas de uma dupla", () => {
    const result = resolveTicketFromScore(
      bet({
        evento: "Mogi das Cruzes vs Bauru | Bayamon vs Aguadas",
        mercado: "Moneyline",
        selecao: "Mogi ML / Bayamon ML",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "Mogi das Cruzes vs Bauru", mercado: "Moneyline", selecao: "Mogi" },
            { evento: "Bayamon vs Aguadas", mercado: "Moneyline", selecao: "Bayamon" },
          ],
        },
      }),
      { homeScore: 88, awayScore: 71, odds: 1.9, stake: 1 },
    );
    expect(result).toEqual({ ok: false, reason: "incomplete_legs" });
  });

  it("HT/H5/FT no texto da entrada não vira moneyline de jogo inteiro", () => {
    expect(resolveTicketFromScore(
      bet({
        evento: "Mogi das cruzes x Bauru",
        mercado: "Moneyline",
        selecao: "Mogi ML H5 FT + Mogi O89,5",
      }),
      { homeScore: 88, awayScore: 71, odds: 1.9, stake: 1 },
    )).toEqual({ ok: false, reason: "wrong_period" });

    expect(resolveTicketFromScore(
      bet({
        evento: "Mogi das Cruzes vs Bauru | Bayamon vs Aguadas",
        mercado: "Moneyline",
        selecao: "Mogi ML HT FT / Bayamon ML",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "Mogi das Cruzes vs Bauru", mercado: "Moneyline", selecao: "Mogi" },
            { evento: "Bayamon vs Aguadas", mercado: "Moneyline", selecao: "Bayamon" },
          ],
        },
      }),
      {
        homeScore: 0,
        awayScore: 0,
        odds: 1.9,
        stake: 1,
        scoresByEvento: [
          { evento: "Mogi das Cruzes vs Bauru", home: 88, away: 71 },
          { evento: "Bayamon vs Aguadas", home: 90, away: 80 },
        ],
      },
    )).toEqual({ ok: false, reason: "wrong_period" });
  });

  it("dupla com evento amassado liquida por placar de cada confronto", () => {
    const ticket = bet({
      evento: "Mogi das Cruzes vs Bauru | Bayamon vs Aguadas",
      mercado: "Moneyline",
      selecao: "Mogi ML / Bayamon ML",
      legsJson: {
        kind: "parlay",
        legs: [
          { evento: "Mogi das Cruzes vs Bauru", mercado: "Moneyline", selecao: "Mogi" },
          { evento: "Bayamon vs Aguadas", mercado: "Moneyline", selecao: "Bayamon" },
        ],
      },
    });
    const bothWon = resolveTicketFromScore(ticket, {
      homeScore: 0,
      awayScore: 0,
      odds: 1.9,
      stake: 1,
      scoresByEvento: [
        { evento: "Mogi das Cruzes vs Bauru", home: 88, away: 71 },
        { evento: "Bayamon vs Aguadas", home: 90, away: 80 },
      ],
    });
    expect(bothWon.ok).toBe(true);
    if (bothWon.ok) expect(bothWon.status).toBe("WON");

    const oneLost = resolveTicketFromScore(ticket, {
      homeScore: 0,
      awayScore: 0,
      odds: 1.9,
      stake: 1,
      scoresByEvento: [
        { evento: "Mogi das Cruzes vs Bauru", home: 88, away: 71 },
        { evento: "Bayamon vs Aguadas", home: 70, away: 80 },
      ],
    });
    expect(oneLost.ok).toBe(true);
    if (oneLost.ok) expect(oneLost.status).toBe("LOST");

    // Uma perna vencedora + outra cancelada exige ajuste manual da odd paga;
    // não se pode aplicar a odd original da múltipla como se ambas vencessem.
    const missing = resolveTicketFromScore(ticket, {
      homeScore: 88,
      awayScore: 71,
      odds: 1.9,
      stake: 1,
      scoresByEvento: [
        { evento: "Mogi das Cruzes vs Bauru", home: 88, away: 71 },
      ],
    });
    expect(missing).toEqual({ ok: false, reason: "incomplete_legs" });
  });

  it("dupla perde se a perna pontuada perde, mesmo com outra cancelada", () => {
    const result = resolveTicketFromScore(
      bet({
        evento: "Mogi das Cruzes vs Bauru",
        mercado: "Moneyline",
        selecao: "Bauru / Bayamon",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "Mogi das Cruzes vs Bauru", mercado: "Moneyline", selecao: "Bauru" },
            { evento: "Bayamon vs Aguadas", mercado: "Moneyline", selecao: "Bayamon" },
          ],
        },
      }),
      { homeScore: 88, awayScore: 71, odds: 1.9, stake: 1 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("LOST");
  });
  it("múltipla com perna VOID não cai em incomplete_legs — exige manual explícito", () => {
    const ticket = bet({
      evento: "Flamengo vs Vasco | Palmeiras vs Santos",
      mercado: "Moneyline",
      selecao: "Flamengo / Palmeiras",
      esporte: "Soccer",
      legsJson: {
        kind: "parlay",
        legs: [
          { evento: "Flamengo vs Vasco", mercado: "Asian Handicap", selecao: "Flamengo -1" },
          { evento: "Palmeiras vs Santos", mercado: "Moneyline", selecao: "Palmeiras" },
        ],
      },
    });
    // Flamengo -1 com vitória por 1 → VOID; Palmeiras vence → WON.
    const result = resolveTicketFromScore(ticket, {
      homeScore: 0,
      awayScore: 0,
      odds: 3.2,
      stake: 1,
      scoresByEvento: [
        { evento: "Flamengo vs Vasco", home: 2, away: 1 },
        { evento: "Palmeiras vs Santos", home: 1, away: 0 },
      ],
    });
    expect(result).toEqual({ ok: false, reason: "parlay_fractional_or_void_requires_manual" });
  });

  it("múltipla com perna HALF_WON / HALF_LOST exige manual explícito", () => {
    const ticket = bet({
      evento: "Flamengo vs Vasco | Palmeiras vs Santos",
      mercado: "Moneyline",
      selecao: "Over 2.25 / Palmeiras",
      esporte: "Soccer",
      legsJson: {
        kind: "parlay",
        legs: [
          { evento: "Flamengo vs Vasco", mercado: "Total", selecao: "Over 2.25" },
          { evento: "Palmeiras vs Santos", mercado: "Moneyline", selecao: "Palmeiras" },
        ],
      },
    });
    // Over 2.25 com 2 gols → HALF_LOST; Palmeiras vence → WON.
    const halfLost = resolveTicketFromScore(ticket, {
      homeScore: 0,
      awayScore: 0,
      odds: 2.5,
      stake: 1,
      scoresByEvento: [
        { evento: "Flamengo vs Vasco", home: 1, away: 1 },
        { evento: "Palmeiras vs Santos", home: 2, away: 0 },
      ],
    });
    expect(halfLost).toEqual({ ok: false, reason: "parlay_fractional_or_void_requires_manual" });

    // Over 2.25 com 3 gols → WON no total? Wait Over 2.25 with 3 = WON.
    // Use Under 2.25 with 2 → HALF_WON instead via different selection.
    const halfWonTicket = bet({
      evento: "Flamengo vs Vasco | Palmeiras vs Santos",
      mercado: "Moneyline",
      selecao: "Under 2.25 / Palmeiras",
      esporte: "Soccer",
      legsJson: {
        kind: "parlay",
        legs: [
          { evento: "Flamengo vs Vasco", mercado: "Total", selecao: "Under 2.25" },
          { evento: "Palmeiras vs Santos", mercado: "Moneyline", selecao: "Palmeiras" },
        ],
      },
    });
    const halfWon = resolveTicketFromScore(halfWonTicket, {
      homeScore: 0,
      awayScore: 0,
      odds: 2.5,
      stake: 1,
      scoresByEvento: [
        { evento: "Flamengo vs Vasco", home: 1, away: 1 },
        { evento: "Palmeiras vs Santos", home: 2, away: 0 },
      ],
    });
    expect(halfWon).toEqual({ ok: false, reason: "parlay_fractional_or_void_requires_manual" });
  });

  it("combo same_game com perna VOID/HALF exige manual explícito", () => {
    // AH 0 empate → VOID; Over 89.5 com 159 pontos → WON.
    const voidLeg = resolveTicketFromScore(
      bet({
        evento: "Mogi das cruzes x Bauru",
        mercado: "Moneyline",
        selecao: "Mogi 0 + Mogi O89,5",
        legsJson: {
          kind: "same_game",
          legs: [
            { evento: "Mogi das Cruzes vs Bauru", mercado: "Asian Handicap", selecao: "Mogi 0" },
            { evento: "Mogi das Cruzes vs Bauru", mercado: "Total", selecao: "Over 89.5" },
          ],
        },
      }),
      { homeScore: 80, awayScore: 80, odds: 1.9, stake: 1 },
    );
    expect(voidLeg).toEqual({ ok: false, reason: "parlay_fractional_or_void_requires_manual" });
  });

  it("perna ainda sem placar continua incomplete_legs (não o motivo de VOID/HALF)", () => {
    const missing = resolveTicketFromScore(
      bet({
        evento: "Flamengo vs Vasco | Palmeiras vs Santos",
        mercado: "Moneyline",
        selecao: "Flamengo / Palmeiras",
        esporte: "Soccer",
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "Flamengo vs Vasco", mercado: "Moneyline", selecao: "Flamengo" },
            { evento: "Palmeiras vs Santos", mercado: "Moneyline", selecao: "Palmeiras" },
          ],
        },
      }),
      {
        homeScore: 2,
        awayScore: 0,
        odds: 2.1,
        stake: 1,
        scoresByEvento: [{ evento: "Flamengo vs Vasco", home: 2, away: 0 }],
      },
    );
    expect(missing).toEqual({ ok: false, reason: "incomplete_legs" });
  });

  it("perna Ambas Marcam do Criar Aposta sai do placar, não da lista de jogadores", () => {
    // "Both Teams to Score" é o nome que a captura grava para Ambas Marcam.
    const criarAposta = bet({
      evento: "Flamengo vs Palmeiras",
      mercado: "Both Teams to Score",
      selecao: "Ambas Marcam + Over 2.5",
      esporte: "Soccer",
      legsJson: {
        kind: "same_game",
        legs: [
          { evento: "Flamengo vs Palmeiras", mercado: "Both Teams to Score", selecao: "Yes" },
          { evento: "Flamengo vs Palmeiras", mercado: "Total", selecao: "Over 2.5" },
        ],
      },
    });
    for (const players of [null, []]) {
      expect(resolveTicketFromScore(criarAposta, { homeScore: 2, awayScore: 1, odds: 3, stake: 1, players }))
        .toMatchObject({ ok: true, status: "WON" });
    }
  });

  it("perna de artilheiro com o nome na grafia do FlashScore ('Haaland E.') liquida", () => {
    const criarAposta = bet({
      evento: "Man City vs Arsenal",
      mercado: "Criar Aposta",
      selecao: "Haaland E. + Over 2.5",
      esporte: "Soccer",
      legsJson: {
        kind: "same_game",
        legs: [
          { evento: "Man City vs Arsenal", mercado: "Anytime Goalscorer", selecao: "Haaland E." },
          { evento: "Man City vs Arsenal", mercado: "Total", selecao: "Over 2.5" },
        ],
      },
    });
    const players = [{
      playerId: "p1", nome: "Haaland Erling", nomeCurto: "Haaland E.", gols: 1, golsContra: 0, minutosJogados: 90,
    }];
    expect(resolveTicketFromScore(criarAposta, { homeScore: 2, awayScore: 1, odds: 3, stake: 1, players }))
      .toMatchObject({ ok: true, status: "WON" });
  });
});

describe("ida e volta no mesmo bilhete", () => {
  // `find` com `sameFixture` (que aceita a ordem inversa) pagaria a volta pelo
  // placar da ida.
  const idaEVolta = bet({
    evento: "Flamengo vs Palmeiras | Palmeiras vs Flamengo",
    mercado: "Moneyline",
    selecao: "Flamengo / Palmeiras",
    esporte: "Soccer",
    legsJson: {
      kind: "parlay",
      legs: [
        { evento: "Flamengo vs Palmeiras", mercado: "Moneyline", selecao: "Flamengo" },
        { evento: "Palmeiras vs Flamengo", mercado: "Moneyline", selecao: "Palmeiras" },
      ],
    },
  });

  it("cada perna usa o placar do próprio jogo", () => {
    // Ida 2–0 Flamengo; volta 0–1 (Palmeiras perdeu em casa): bilhete perdido.
    expect(resolveTicketFromScore(idaEVolta, {
      homeScore: 0, awayScore: 0, odds: 2, stake: 10,
      scoresByEvento: [
        { evento: "Flamengo vs Palmeiras", home: 2, away: 0 },
        { evento: "Palmeiras vs Flamengo", home: 0, away: 1 },
      ],
    })).toMatchObject({ ok: true, status: "LOST" });
  });

  it("sem o placar da volta, não paga pela ida", () => {
    const result = resolveTicketFromScore(idaEVolta, {
      homeScore: 0, awayScore: 0, odds: 2, stake: 10,
      scoresByEvento: [{ evento: "Flamengo vs Palmeiras", home: 2, away: 0 }],
    });
    expect(result).not.toMatchObject({ ok: true, status: "WON" });
  });
});

describe("vencedor de parte do jogo ou pelo método não liquida pelo placar da série", () => {
  const score = { homeScore: 2, awayScore: 1, odds: 1.9, stake: 1 };
  const esports = (mercado: string, selecao: string) => bet({ esporte: "eSports", evento: "FURIA vs NAVI", mercado, selecao });

  it.each([
    ["Vencedor do Pistol Round", "FURIA"],
    ["Money Line – Pistol Round", "FURIA"],
    ["Money Line – 1st Pistol Round", "FURIA"],
    ["Pistol round vencedor", "FURIA"],
    ["Vencedor do Primeiro Round", "FURIA"],
    ["Vencedor", "FURIA - Pistol Round"],
    ["Money Line – Match", "FURIA pistol round"],
  ])("eSports %s / %s", (mercado, selecao) => {
    expect(resolveTicketFromScore(esports(mercado, selecao), score).ok).toBe(false);
  });

  it.each([
    ["Vencedor", "Jon Jones por KO/TKO"],
    ["Vencedor da Luta", "Jon Jones por decisão"],
    ["Vencedor e Método", "Jon Jones KO"],
    ["Vencedor por Decisão", "Jon Jones"],
  ])("luta %s / %s", (mercado, selecao) => {
    const luta = bet({ esporte: "Boxing", evento: "Jon Jones vs Stipe Miocic", mercado, selecao });
    expect(resolveTicketFromScore(luta, { ...score, homeScore: 1, awayScore: 0 }).ok).toBe(false);
  });

  it("o vencedor da série continua liquidando pelo placar", () => {
    expect(resolveTicketFromScore(esports("Money Line – Match", "FURIA"), score)).toMatchObject({ ok: true, status: "WON" });
  });
});


describe("ordem dos times do criar-aposta depois da identidade", () => {
  const ticket = (mercado: string, selecao: string) => bet({
    evento: "Palmeiras vs Flamengo", esporte: "Soccer", mercado: "Criar Aposta",
    selecao: `${selecao} + Over 1.5`,
    legsJson: { kind: "same_game", legs: [
      { evento: "Flamengo vs Palmeiras", mercado, selecao },
      { evento: "Flamengo vs Palmeiras", mercado: "Total", selecao: "Over 1.5" },
    ] },
  });

  it("usa o placar na ordem da perna preservada, incluindo seleção por posição", () => {
    for (const selecao of ["Flamengo", "Home"]) {
      expect(resolveTicketFromScore(ticket("Moneyline", selecao), {
        homeScore: 2, awayScore: 0, odds: 3, stake: 1,
      })).toMatchObject({ ok: true, status: "LOST", lucro: -1 });
      expect(resolveTicketFromScore(ticket("Moneyline", selecao), {
        homeScore: 0, awayScore: 2, odds: 3, stake: 1,
      })).toMatchObject({ ok: true, status: "WON", lucro: 2 });
    }
  });

  it("reconhece os nomes canônicos e recusa orientação sem prova", () => {
    expect(resolveTicketFromScore({ ...ticket("Moneyline", "Home"), evento: "Palmeiras SP vs Flamengo RJ" }, {
      homeScore: 2, awayScore: 0, odds: 3, stake: 1,
    })).toMatchObject({ ok: true, status: "LOST" });
    expect(resolveTicketFromScore({ ...ticket("Moneyline", "Home"), evento: "Alpha vs Beta" }, {
      homeScore: 2, awayScore: 0, odds: 3, stake: 1,
    })).toEqual({ ok: false, reason: "ambiguous_selection" });
  });

  it("mantém o placar da entrada ao vivo ligado aos mesmos times", () => {
    const aposta = ticket("Asian Handicap", "Flamengo +1.5");
    aposta.liveScoreHome = 1;
    aposta.liveScoreAway = 0;
    aposta.legsJson = { kind: "same_game", legs: [
      { evento: "Flamengo vs Palmeiras", mercado: "Asian Handicap", selecao: "Flamengo +1.5" },
      { evento: "Flamengo vs Palmeiras", mercado: "Asian Handicap", selecao: "Palmeiras -0.5" },
    ] };
    expect(resolveTicketFromScore(aposta, { homeScore: 3, awayScore: 1, odds: 3, stake: 1 }))
      .toMatchObject({ ok: true, status: "WON", lucro: 2 });
  });

  it("também orienta os parciais e o placar regulamentar", () => {
    expect(resolveTicketFromScore(ticket("Moneyline – 1st Half", "Flamengo"), {
      homeScore: 2, awayScore: 1, odds: 3, stake: 1,
      periodScores: { ht: { home: 2, away: 0 }, sh: { home: 0, away: 1 } },
    })).toMatchObject({ ok: true, status: "LOST" });
    expect(resolveTicketFromScore({ ...ticket("Money Line – Regulation Time", "Flamengo"), esporte: "Basketball" }, {
      homeScore: 2, awayScore: 1, odds: 3, stake: 1,
      regulationScore: { home: 1, away: 0 },
    })).toMatchObject({ ok: true, status: "LOST" });
  });
});

describe("criar-aposta cujo apelido do tipster não casa com o nome do provider", () => {
  const galo = (...legs: Array<[mercado: string, selecao: string]>) => bet({
    evento: "Atletico Mineiro vs Bahia", esporte: "Soccer", mercado: "Criar Aposta",
    selecao: legs.map(([, selecao]) => selecao).join(" + "),
    legsJson: { kind: "same_game", legs: legs.map(([mercado, selecao]) => ({ evento: "Galo x Bahia", mercado, selecao })) },
  });
  const final = { homeScore: 2, awayScore: 1, odds: 3, stake: 1 };

  it("pernas que não dependem do mando liquidam sem a prova de orientação", () => {
    expect(resolveTicketFromScore(galo(["Total", "Over 1.5"], ["Ambas Marcam", "Sim"]), final))
      .toMatchObject({ ok: true, status: "WON", lucro: 2 });
    expect(resolveTicketFromScore(galo(["Total", "Over 3.5"], ["Ambas Marcam", "Sim"]), final))
      .toMatchObject({ ok: true, status: "LOST", lucro: -1 });
  });

  it.each([
    ["Moneyline", "Galo"],
    ["Moneyline", "Home"],
    ["Asian Handicap", "Galo -0.5"],
    ["Team Total", "Galo Over 1.5"],
    ["Double Chance", "Galo ou Empate"],
  ])("perna que depende do mando (%s: %s) continua sem pagar lado nenhum", (mercado, selecao) => {
    expect(resolveTicketFromScore(galo(["Total", "Over 1.5"], [mercado, selecao]), final))
      .toEqual({ ok: false, reason: "ambiguous_selection" });
    expect(resolveTicketFromScore(galo(["Total", "Over 1.5"], [mercado, selecao]), { ...final, homeScore: 1, awayScore: 2 }))
      .toEqual({ ok: false, reason: "ambiguous_selection" });
  });

  it("placar igual dos dois lados responde a perna de mando sem a prova", () => {
    expect(resolveTicketFromScore(galo(["Total", "Over 1.5"], ["Moneyline", "Galo"]), { ...final, homeScore: 1, awayScore: 1 }))
      .toMatchObject({ ok: true, status: "LOST" });
  });

  it("total do 1º tempo sem prova usa o parcial, que soma igual nas duas ordens", () => {
    expect(resolveTicketFromScore(galo(["Total – 1st Half", "Over 0.5"], ["Total", "Over 1.5"]), {
      ...final, periodScores: { ht: { home: 1, away: 0 }, sh: { home: 1, away: 1 } },
    })).toMatchObject({ ok: true, status: "WON" });
  });
});

describe("múltipla com perna anulada ou fracionária", () => {
  it.each(["same_game", "parlay"] as const)("%s exige revisão mesmo se outra perna perdeu", (kind) => {
    for (const line of ["0", "+0.25", "-0.25"]) {
      for (const reversed of [false, true]) {
        const legs = [
          { evento: "Flamengo vs Palmeiras", mercado: "Total", selecao: "Over 2.5" },
          { evento: "Flamengo vs Palmeiras", mercado: "Asian Handicap", selecao: `Flamengo ${line}` },
        ];
        expect(resolveTicketFromScore(bet({
          evento: "Flamengo vs Palmeiras", esporte: "Soccer", mercado: "Criar Aposta",
          selecao: "Over 2.5 + Flamengo", legsJson: { kind, legs: reversed ? legs.toReversed() : legs },
        }), { homeScore: 0, awayScore: 0, odds: 3, stake: 1 }))
          .toEqual({ ok: false, reason: "parlay_fractional_or_void_requires_manual" });
      }
    }
  });
});


describe("contratos completos das pernas", () => {
  it.each([
    ["Total (Corners) – Match", "Over 0.5 + Under 3.5", "Soccer"],
    ["Total (Games) – Match", "Over 0.5 + Under 3.5", "Tennis"],
    ["Total de ataques perigosos", "Over 0.5 + Under 3.5", "Soccer"],
    ["Total de Chances Criadas", "Over 0.5 + Under 3.5", "Soccer"],
    ["Handicap Europeu", "France -1 + Over 1.5", "Soccer"],
    ["Vencedor e Método", "France + Over 1.5", "Soccer"],
  ])("%s não perde a mecânica ao reconstruir as pernas", (mercado, selecao, esporte) => {
    expect(resolveTicketFromScore(bet({ evento: "France vs Morocco", mercado, selecao, esporte }), {
      homeScore: 2, awayScore: 0, odds: 3, stake: 1,
    }).ok).toBe(false);
  });

  it.each(["parlay", "same_game"] as const)("%s com jogos diferentes não distribui o placar live da raiz", (kind) => {
    const live = bet({ evento: "France vs Morocco | Spain vs Italy", mercado: "Moneyline", selecao: "France +0.5 / Spain +0.5",
      esporte: "Soccer", liveScoreHome: 1, liveScoreAway: 0,
      legsJson: { kind, legs: [
        { evento: "France vs Morocco", mercado: "Asian Handicap", selecao: "France +0.5" },
        { evento: "Spain vs Italy", mercado: "Asian Handicap", selecao: "Spain +0.5" },
      ] },
    });
    // Spain entrou perdendo 0-1 e terminou 1-1: a perna é ganha, não perdida
    // pela subtração do 1-0 de France; falta contrato de placar POR PERNA.
    expect(resolveTicketFromScore(live, { homeScore: 2, awayScore: 0, odds: 3, stake: 1,
      scoresByEvento: [{ evento: "France vs Morocco", home: 2, away: 0 }, { evento: "Spain vs Italy", home: 1, away: 1 }],
    })).toEqual({ ok: false, reason: "unsupported_live_score" });
  });
});
