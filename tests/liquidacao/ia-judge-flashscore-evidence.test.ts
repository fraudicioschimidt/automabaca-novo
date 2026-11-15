import { describe, expect, it } from "vitest";
import {
  extractFlashscoreJudgeEvidence,
  flashscoreAutoSettleBlocker,
  flashscoreJudgeFacts,
  flashscoreMatchNotPlayed,
  tryResolveFromFlashscoreStats,
} from "@/src/services/settlement/ia-judge/flashscore-evidence";

describe("extractFlashscoreJudgeEvidence", () => {
  it("retorna null sem match/stats", () => {
    expect(extractFlashscoreJudgeEvidence(null)).toBeNull();
    expect(extractFlashscoreJudgeEvidence({ outcome: "miss" })).toBeNull();
    expect(
      extractFlashscoreJudgeEvidence({
        outcome: "matched",
        finished: true,
        stats: {},
      }),
    ).toBeNull();
  });

  it("times, placar e estatísticas saem na ordem do evento da aposta, com o mandante real à parte", () => {
    // O snapshot grava placar e estatísticas já orientados pela aposta
    // (`home` = 1º time do evento) e os times na ordem do FlashScore.
    const base = {
      outcome: "matched",
      finished: true,
      score: { home: 2, away: 1 },
      stats: {
        corners: { home: 6, away: 3 },
        yellowCards: { home: 1, away: 2 },
        redCards: { home: 1, away: 0 },
      },
    };
    // Aposta "Flamengo x Vasco", FlashScore lista Vasco como mandante.
    const swapped = extractFlashscoreJudgeEvidence({
      ...base,
      providerTeams: { home: "Vasco", away: "Flamengo", swapped: true },
    })?.evidenceText;
    expect(swapped).toContain("Times, na ordem do evento da aposta: Flamengo x Vasco (mandante no FlashScore: Vasco)");
    expect(swapped).toContain("Placar: Flamengo 2 x 1 Vasco");
    expect(swapped).toContain("Escanteios: Flamengo=6, Vasco=3");
    expect(swapped).toContain("Pontos de cartões (amarelo=1, vermelho=2): Flamengo=3, Vasco=2");
    expect(swapped).not.toMatch(/casa=|visitante=|Vasco vs Flamengo/);

    // Mesma aposta, FlashScore na mesma ordem.
    const straight = extractFlashscoreJudgeEvidence({
      ...base,
      providerTeams: { home: "Flamengo", away: "Vasco", swapped: false },
    })?.evidenceText;
    expect(straight).toContain("Times, na ordem do evento da aposta: Flamengo x Vasco (mandante no FlashScore: Flamengo)");
    expect(straight).toContain("Placar: Flamengo 2 x 1 Vasco");
    expect(straight).toContain("Escanteios: Flamengo=6, Vasco=3");
  });

  it("sem a orientação gravada, não põe nome de time no lado do placar", () => {
    const ev = extractFlashscoreJudgeEvidence({
      outcome: "matched",
      finished: true,
      score: { home: 2, away: 1 },
      providerTeams: { home: "A", away: "B" },
    })?.evidenceText;
    expect(ev).toContain("Placar: 1º time da aposta 2 x 1 2º time da aposta");
    expect(ev).not.toContain("Times");
  });

  it("não expõe placar agregado quando faltam os 90 minutos", () => {
    expect(
      extractFlashscoreJudgeEvidence({
        outcome: "matched",
        finished: true,
        stage: "After Penalties",
        settlementOutcome: "manual_extra_time",
        score: { home: 5, away: 4 },
        stats: { corners: { home: 8, away: 7 } },
      }),
    ).toBeNull();
  });

  it("usa somente o placar regulamentar quando há prorrogação", () => {
    const ev = extractFlashscoreJudgeEvidence({
      outcome: "matched",
      finished: true,
      stage: "Finished after extra time",
      settlementOutcome: "settled_from_regulation_score",
      score: { home: 3, away: 2 },
      regulationScore: { home: 1, away: 1 },
      stats: { corners: { home: 8, away: 7 } },
    });
    expect(ev?.evidenceText).toContain("Placar regulamentar: 1º time da aposta 1 x 1 2º time da aposta");
    expect(ev?.evidenceText).not.toContain("Placar: ");
    expect(ev?.evidenceText).not.toContain("Escanteios");
    // A prorrogação vem do provider, não de palavra no texto: o teto da dúvida usa este campo.
    expect(ev).toMatchObject({ decidedAfterRegulation: true });
    expect(extractFlashscoreJudgeEvidence({ outcome: "matched", finished: true, score: { home: 2, away: 1 } }))
      .toMatchObject({ decidedAfterRegulation: false });
  });

  it("usa stats de escanteios", () => {
    const ev = extractFlashscoreJudgeEvidence({
      outcome: "matched",
      finished: true,
      stats: { corners: { home: 5, away: 7 } },
    });
    expect(ev?.evidenceText).toContain("Escanteios: 1º time da aposta=5, 2º time da aposta=7");
  });

  it("inclui pontos de cartões (amarelo=1, vermelho=2)", () => {
    const ev = extractFlashscoreJudgeEvidence({
      outcome: "matched",
      finished: true,
      stats: {
        yellowCards: { home: 2, away: 3 },
        redCards: { home: 0, away: 1 },
      },
    });
    expect(ev?.evidenceText).toContain("Cartões amarelos");
    expect(ev?.evidenceText).toContain(
      "Pontos de cartões (amarelo=1, vermelho=2): 1º time da aposta=2, 2º time da aposta=5",
    );
  });
});

describe("flashscoreMatchNotPlayed", () => {
  it("partida cancelada/adiada é VOID determinístico, sem LLM", () => {
    expect(flashscoreMatchNotPlayed({ outcome: "matched", cancelled: true })).toBe("cancelled");
    expect(flashscoreMatchNotPlayed({ outcome: "matched", postponed: true })).toBe("postponed");
    expect(flashscoreMatchNotPlayed({ outcome: "matched", finished: true })).toBeNull();
    expect(flashscoreMatchNotPlayed({ outcome: "no_match", cancelled: true })).toBeNull();
    expect(flashscoreMatchNotPlayed(null)).toBeNull();
  });
});

describe("tryResolveFromFlashscoreStats", () => {
  it("resolve linha no mercado sem transbordar para o LLM", () => {
    const result = tryResolveFromFlashscoreStats({
      mercado: "Total de Escanteios 9.5",
      selecao: "Over",
      evento: "Flamengo vs Vasco",
      odds: 1.85,
      stake: 1,
      resultSnapshot: {
        outcome: "matched",
        finished: true,
        stats: { corners: { home: 6, away: 5 } },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      status: "WON",
      statistic: "corners",
      values: { home: 6, away: 5 },
    });
  });

  it("aceita par de estatística gravado como string numérica", () => {
    const result = tryResolveFromFlashscoreStats({
      mercado: "Total (Bookings) – Match",
      selecao: "Under 5.5",
      evento: "A vs B",
      odds: 1.9,
      stake: 1,
      resultSnapshot: {
        outcome: "matched",
        finished: true,
        stats: {
          yellowCards: { home: "1", away: "1" },
          redCards: { home: "0", away: "0" },
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      status: "WON",
      statistic: "booking_points",
      values: { home: 1, away: 1 },
    });
  });

  it("resolve Bookings Under a partir do snapshot FS", () => {
    const result = tryResolveFromFlashscoreStats({
      mercado: "Total (Bookings) – Match",
      selecao: "Under 5.5",
      evento: "A vs B",
      odds: 1.9,
      stake: 1,
      resultSnapshot: {
        outcome: "matched",
        finished: true,
        stats: {
          yellowCards: { home: 1, away: 1 },
          redCards: { home: 0, away: 0 },
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      status: "WON",
      statistic: "booking_points",
      values: { home: 1, away: 1 },
    });
  });

  it("usa cartão vermelho mesmo quando o snapshot não traz amarelos", () => {
    for (const mercado of ["Total Red Cards – Match", "Total de Cartões Vermelhos – Match"]) {
      const result = tryResolveFromFlashscoreStats({
        mercado,
        selecao: "Under 2.5",
        evento: "A vs B",
        odds: 1.9,
        stake: 1,
        resultSnapshot: {
          outcome: "matched",
          finished: true,
          stats: { redCards: { home: 1, away: 0 } },
        },
      });
      // Mercado que DECLARA a cor tem família própria: conta o vermelho (1),
      // não os pontos asiáticos (amarelo=1 + vermelho=2). O veredito é o mesmo
      // aqui; o que importa é a unidade não mentir.
      expect(result, mercado).toMatchObject({
        ok: true,
        status: "WON",
        statistic: "red_cards",
        values: { home: 1, away: 0 },
      });
    }
  });

  it("retorna null sem stats utilizáveis", () => {
    expect(
      tryResolveFromFlashscoreStats({
        mercado: "Total (Bookings) – Match",
        selecao: "Under 5.5",
        evento: "A vs B",
        odds: 1.9,
        stake: 1,
        resultSnapshot: { outcome: "matched", stats: {} },
      }),
    ).toBeNull();
  });

  it("não usa estatísticas agregadas de partida com prorrogação", () => {
    expect(
      tryResolveFromFlashscoreStats({
        mercado: "Total de Escanteios 9.5",
        selecao: "Over",
        evento: "A vs B",
        odds: 1.9,
        stake: 1,
        resultSnapshot: {
          outcome: "matched",
          finished: true,
          stage: "After Penalties",
          settlementOutcome: "manual_extra_time",
          stats: { corners: { home: 6, away: 5 } },
        },
      }),
    ).toBeNull();
  });
});

describe("prorrogação e jogo interrompido no snapshot", () => {
  it("prorrogação do basquete é fato rotulado, não o placar do jogo", () => {
    const snapshot = {
      outcome: "matched",
      finished: true,
      stage: "After Overtime",
      score: { home: 110, away: 105 },
    };
    expect(flashscoreAutoSettleBlocker(snapshot)).toBe("extra_time");
    const ev = extractFlashscoreJudgeEvidence(snapshot);
    expect(ev).toBeNull();
    expect(flashscoreJudgeFacts(snapshot)).toEqual([
      'Fato do FlashScore: houve prorrogação (estágio "After Overtime"). ' +
        "Placar listado, com prorrogação: 1º time da aposta 110 x 105 2º time da aposta. Placar do tempo regulamentar: não disponível no FlashScore.",
    ]);
  });

  it("futebol com os 90' reconstruídos informa os dois placares", () => {
    const snapshot = {
      outcome: "matched",
      finished: true,
      stage: "After Extra Time",
      score: { home: 2, away: 1 },
      regulationScore: { home: 1, away: 1 },
      providerTeams: { home: "Vasco", away: "Flamengo", swapped: true },
    };
    expect(extractFlashscoreJudgeEvidence(snapshot)?.evidenceText).toContain(
      "Placar listado, com prorrogação: Flamengo 2 x 1 Vasco. Placar do tempo regulamentar: Flamengo 1 x 1 Vasco.",
    );
  });

  it("abandono no tênis e bilhete com perna interrompida bloqueiam a liquidação sozinha", () => {
    expect(flashscoreAutoSettleBlocker({
      outcome: "matched", stage: "Finished / retired", score: { home: 1, away: 1 },
    })).toBe("interrupted");
    expect(flashscoreAutoSettleBlocker({ outcome: "matched", ticket: true, interrupted: 1, extraTimeBlocked: 0 }))
      .toBe("interrupted");
    expect(flashscoreAutoSettleBlocker({ outcome: "matched", ticket: true, interrupted: 0, extraTimeBlocked: 2 }))
      .toBe("extra_time");
  });

  it("jogo que o FlashScore ainda vê sem fim bloqueia e vira fato, com ou sem placar parcial", () => {
    const tennis = {
      outcome: "matched", sportId: 2, stage: "2nd set", finished: false, cancelled: false, postponed: false,
      providerKickoff: "2026-01-01T18:00:00.000Z", score: { home: 1, away: 0 },
    };
    expect(flashscoreAutoSettleBlocker(tennis)).toBe("not_finished");
    // O placar parcial não pode ir ao juiz como "Placar": vai à busca, com o fato.
    expect(extractFlashscoreJudgeEvidence(tennis)).toBeNull();
    expect(flashscoreJudgeFacts(tennis)).toEqual([
      'Fato do FlashScore: a partida ainda não terminou (estágio "2nd set"; início no FlashScore: 2026-01-01T18:00:00.000Z). ' +
        "Placar listado até agora: 1º time da aposta 1 x 0 2º time da aposta.",
    ]);
    expect(flashscoreAutoSettleBlocker({ ...tennis, stage: null, score: null })).toBe("not_finished");
    expect(flashscoreAutoSettleBlocker({ ...tennis, sportId: 3, stage: "Q4" })).toBe("not_finished");
  });

  it("esporte inferido, sem flag de fim, e jogo já encerrado não bloqueiam", () => {
    const volleyball = { outcome: "matched", sportId: 12, stage: null, finished: false, score: { home: 3, away: 1 } };
    expect(flashscoreAutoSettleBlocker(volleyball)).toBeNull();
    expect(flashscoreAutoSettleBlocker({ ...volleyball, sportId: 2, finished: true })).toBeNull();
  });

  it("bilhete com jogo casado ainda sem fim ou adiado bloqueia; perna só não casada, não", () => {
    const ticket = { outcome: "matched", ticket: true, sportId: 1, unfinished: true, interrupted: 0, extraTimeBlocked: 0 };
    expect(flashscoreAutoSettleBlocker({ ...ticket, live: 1, postponedWaiting: 0 })).toBe("not_finished");
    expect(flashscoreAutoSettleBlocker({ ...ticket, live: 0, postponedWaiting: 1 })).toBe("not_finished");
    expect(flashscoreJudgeFacts({ ...ticket, live: 1, postponedWaiting: 0 })).toEqual([
      "Fato do FlashScore: ao menos um jogo desta múltipla ainda não terminou ou está adiado.",
    ]);
    // Perna que o FlashScore nem casou é o caso do fallback: o juiz liquida.
    expect(flashscoreAutoSettleBlocker({ ...ticket, live: 0, postponedWaiting: 0 })).toBeNull();
    // Esporte inferido: jogo sem fim é só a espera da estabilidade.
    expect(flashscoreAutoSettleBlocker({ ...ticket, sportId: 6, live: 1, postponedWaiting: 0 })).toBeNull();
  });

  it("jogo normal não bloqueia nem acrescenta fato", () => {
    const snapshot = { outcome: "matched", stage: "Finished", finished: true, score: { home: 2, away: 1 } };
    expect(flashscoreAutoSettleBlocker(snapshot)).toBeNull();
    expect(flashscoreJudgeFacts(snapshot)).toEqual([]);
  });
});
