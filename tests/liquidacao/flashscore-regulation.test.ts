import { describe, expect, it } from "vitest";
import {
  flashscoreListedScoreIncludesOvertime,
  loadFlashscoreRegulationContext,
  ticketFixtureExtraTimeNeed,
} from "@/src/services/settlement/flashscore/regulation";
import type { SummaryCache } from "@/src/services/settlement/flashscore/settle";
import { fixtureMercados } from "@/src/services/settlement/flashscore/ticket";
import type { FlashscoreMatchCandidate } from "@/src/providers/flashscore/match";

/**
 * A reconstrução de 90' só serve a quem prometeu 90': o Over 2.5 que ganhou no
 * 2–2 da prorrogação não pode sair perdido pelo 1–1 dos 90'. Quem prometeu 120'
 * e foi aos pênaltis é manual.
 */

function candidate(status: { afterExtraTime: boolean; afterPenalties: boolean }): FlashscoreMatchCandidate {
  return {
    score: 2,
    swapped: false,
    strategy: "provider_id",
    match: {
      match_id: "fs-et-1",
      timestamp: 1_700_000_000,
      home_team: { team_id: "h", name: "Casa" },
      away_team: { team_id: "a", name: "Fora" },
      scores: { home: 2, away: 2 },
      match_status: {
        stage: status.afterPenalties ? "After Penalties" : "Finished after extra time",
        is_cancelled: false,
        is_postponed: false,
        is_started: true,
        is_in_progress: false,
        is_finished: true,
        is_finished_after_extra_time: status.afterExtraTime,
        is_finished_after_penalties: status.afterPenalties,
      },
    },
  };
}

/** Conta quantas vezes a reconstrução de 90' foi buscar o summary. */
function spyCache() {
  const cache = new Map() as SummaryCache & { lookups: number };
  cache.lookups = 0;
  const get = cache.get.bind(cache);
  cache.get = (key: string) => {
    cache.lookups += 1;
    return get(key) ?? Promise.resolve(null);
  };
  return cache;
}

async function context(params: {
  mercado: string;
  selecao?: string;
  legs?: { mercado: string; selecao: string }[];
  penalties?: boolean;
  sportId?: number;
}) {
  const cache = spyCache();
  const ctx = await loadFlashscoreRegulationContext({
    candidate: candidate({ afterExtraTime: true, afterPenalties: params.penalties ?? true }),
    mercado: params.mercado,
    selecao: params.selecao,
    legs: params.legs,
    scoreOnlyMarket: true,
    cache,
    sportId: params.sportId ?? 1,
    evento: "Casa vs Fora",
  });
  return { ...ctx, summaryLookups: cache.lookups };
}

describe("promessa de prorrogação decide o placar que paga", () => {
  it("mercado que inclui prorrogação e foi aos pênaltis não usa os 90' (manual)", async () => {
    const ctx = await context({ mercado: "Total de Gols (incluindo prorrogação)" });
    expect(ctx.extraTimeCompatible).toBe(false);
    expect(ctx.regulationEvidence).toBeNull();
    expect(ctx.summaryLookups).toBe(0);
  });

  it("a frase na seleção conta como promessa", async () => {
    const ctx = await context({ mercado: "Total de Gols", selecao: "Over 2.5 incluindo prorrogação" });
    expect(ctx.summaryLookups).toBe(0);
    const semPenaltis = await context({
      mercado: "Total de Gols", selecao: "Over 2.5 incluindo prorrogação", penalties: false,
    });
    expect(semPenaltis.extraTimeCompatible).toBe(true);
  });

  it("Criar Aposta: perna que promete prorrogação não é paga pelos 90'", async () => {
    const ctx = await context({
      mercado: "Criar Aposta",
      legs: [
        { mercado: "Resultado Final", selecao: "Casa" },
        { mercado: "Total de Gols", selecao: "Over 2.5 incluindo prorrogação" },
      ],
      penalties: false,
    });
    // Mistura de 90' e 120' no mesmo jogo: nenhum número paga as duas.
    expect(ctx.extraTimeCompatible).toBe(false);
    expect(ctx.regulationEvidence).toBeNull();
    expect(ctx.summaryLookups).toBe(0);
  });

  it("Criar Aposta: a frase de uma perna na seleção do bilhete não vale para as outras", async () => {
    // Em produção a seleção guarda o texto inteiro do bilhete. A frase da perna
    // de total não pode marcar o "Casa" de 90' como 120': o bilhete seria pago
    // pelo placar da prorrogação.
    const ctx = await context({
      mercado: "Criar Aposta",
      selecao: "Casa + Over 2.5 incluindo prorrogação",
      legs: [
        { mercado: "Resultado Final", selecao: "Casa" },
        { mercado: "Total de Gols", selecao: "Over 2.5 incluindo prorrogação" },
      ],
      penalties: false,
    });
    expect(ctx.extraTimeCompatible).toBe(false);
    expect(ctx.regulationEvidence).toBeNull();
  });

  it("Criar Aposta cujo mercado inclui prorrogação vale para todas as pernas", async () => {
    const ctx = await context({
      mercado: "Criar Aposta (incluindo prorrogação)",
      legs: [
        { mercado: "Resultado Final", selecao: "Casa" },
        { mercado: "Total de Gols", selecao: "Over 2.5" },
      ],
      penalties: false,
    });
    expect(ctx.extraTimeCompatible).toBe(true);
  });

  it("mercado de 90' continua reconstruindo pelo summary no futebol", async () => {
    const ctx = await context({ mercado: "Resultado Final", selecao: "Casa" });
    expect(ctx.summaryLookups).toBe(1);
  });

  /**
   * Os pênaltis não provam a prorrogação: há copa que vai direto a eles. Prova
   * a flag (ou o estágio) ou um gol depois dos 90'.
   */
  it.each([
    [{ afterExtraTime: false, afterPenalties: true }, ["30", "60"], false],
    [{ afterExtraTime: false, afterPenalties: true }, ["30", "105"], true],
    [{ afterExtraTime: true, afterPenalties: true }, ["30", "60"], true],
  ])("%j com gols aos %j: prorrogação jogada = %s", async (status, minutos, jogada) => {
    const gol = (minutes: string, team: "home" | "away") => ({ minutes, team, players: [{ type: "Goal" }] });
    const base = candidate(status);
    const cache: SummaryCache = new Map([[base.match.match_id, Promise.resolve([gol(minutos[0]!, "home"), gol(minutos[1]!, "away")])]]) as SummaryCache;
    const ctx = await loadFlashscoreRegulationContext({
      candidate: { ...base, match: { ...base.match, scores: { home: 1, away: 1 } } },
      mercado: "Resultado Final", selecao: "Casa", scoreOnlyMarket: true, cache, sportId: 1, evento: "Casa vs Fora",
    });
    expect(ctx.regulationEvidence).not.toBeNull();
    expect(ctx.extraTimePlayed).toBe(jogada);
  });

  it("hóquei decidido na prorrogação não reconstrói 90' (a prorrogação começa aos 60')", async () => {
    const ctx = await context({ mercado: "Resultado Final", selecao: "Casa", sportId: 4, penalties: false });
    expect(ctx.regulationEvidence).toBeNull();
    expect(ctx.summaryLookups).toBe(0);
  });
});

describe("bilhete de vários jogos", () => {
  const status = { is_finished: true, is_finished_after_extra_time: true, is_finished_after_penalties: false };

  it("lê a promessa na seleção da perna", () => {
    const mercados = fixtureMercados(
      { kind: "parlay", legs: [
        { evento: "Casa x Fora", mercado: "Total de Gols", selecao: "Over 2.5 incluindo prorrogação" },
        { evento: "A x B", mercado: "Resultado Final", selecao: "A" },
      ] },
      "Casa x Fora",
    );
    expect(ticketFixtureExtraTimeNeed({ status, mercados, sportId: 1 })).toBe("aggregate");
  });

  it("hóquei com mercado de 60' e prorrogação fica bloqueado", () => {
    expect(ticketFixtureExtraTimeNeed({ status, mercados: ["Resultado Final Casa"], sportId: 4 })).toBe("blocked");
  });
});

function basketballCandidate(params: {
  afterExtraTime?: boolean;
  afterPenalties?: boolean;
  home?: number;
  away?: number;
}): FlashscoreMatchCandidate {
  return {
    score: 2,
    swapped: false,
    strategy: "provider_id",
    match: {
      match_id: "bb-ot-1",
      timestamp: 1_700_000_000,
      home_team: { team_id: "h", name: "Lakers" },
      away_team: { team_id: "a", name: "Celtics" },
      scores: { home: params.home ?? 112, away: params.away ?? 108 },
      match_status: {
        stage: "After Overtime",
        is_cancelled: false,
        is_postponed: false,
        is_started: true,
        is_in_progress: false,
        is_finished: true,
        is_finished_after_extra_time: params.afterExtraTime ?? true,
        is_finished_after_penalties: params.afterPenalties ?? false,
      },
    },
  };
}

describe("estágio do feed sem as flags de prorrogação", () => {
  const semFlags = (stage: string): FlashscoreMatchCandidate => {
    const base = candidate({ afterExtraTime: false, afterPenalties: false });
    return {
      ...base,
      match: {
        ...base.match,
        match_status: {
          ...base.match.match_status,
          stage,
          is_finished_after_extra_time: undefined,
          is_finished_after_penalties: undefined,
        },
      },
    };
  };

  it("\"After Extra Time\" sem flag ainda é jogo decidido na prorrogação", async () => {
    const ctx = await loadFlashscoreRegulationContext({
      candidate: semFlags("After Extra Time"),
      mercado: "Moneyline",
      scoreOnlyMarket: true,
      cache: spyCache(),
      sportId: 1,
      evento: "Casa vs Fora",
    });
    expect(ctx.decidedInExtraTime).toBe(true);
    expect(ctx.extraTimeCompatible).toBe(false);
  });

  it("\"After Penalties\" sem flag bloqueia até quem prometeu prorrogação", async () => {
    const ctx = await loadFlashscoreRegulationContext({
      candidate: semFlags("After Penalties"),
      mercado: "Total de Gols (incluindo prorrogação)",
      scoreOnlyMarket: true,
      cache: spyCache(),
      sportId: 1,
      evento: "Casa vs Fora",
    });
    expect(ctx.decidedInExtraTime).toBe(true);
    expect(ctx.extraTimeCompatible).toBe(false);
    expect(ticketFixtureExtraTimeNeed({
      status: { is_finished: true, stage: "After Penalties" },
      mercados: ["Vencedor incluindo prorrogação"],
    })).toBe("blocked");
  });

  it("\"After Overtime\" sem flag no basquete paga a Money Line pelo placar final", async () => {
    const ctx = await loadFlashscoreRegulationContext({
      candidate: semFlags("After Overtime"),
      mercado: "Money Line – Game",
      selecao: "Casa",
      scoreOnlyMarket: true,
      cache: spyCache(),
      sportId: 3,
      evento: "Casa vs Fora",
    });
    expect(ctx).toMatchObject({ decidedInExtraTime: true, extraTimeCompatible: true });
  });
});

describe("basquete: o placar listado já inclui a prorrogação", () => {
  it("listedScoreIncludesOvertime so no basquete (sportId 3)", () => {
    expect(flashscoreListedScoreIncludesOvertime(3)).toBe(true);
    expect(flashscoreListedScoreIncludesOvertime(1)).toBe(false);
    expect(flashscoreListedScoreIncludesOvertime(4)).toBe(false);
  });

  it("contexto de basquete apos OT usa placar listado (sem reconstruir 90)", async () => {
    const ctx = await loadFlashscoreRegulationContext({
      candidate: basketballCandidate({}),
      mercado: "Money Line – Game",
      scoreOnlyMarket: true,
      cache: new Map(),
      sportId: 3,
      evento: "Lakers vs Celtics",
    });
    expect(ctx).toEqual({
      decidedInExtraTime: true,
      extraTimePlayed: true,
      extraTimeCompatible: true,
      regulationEvidence: null,
      regulationAttempted: false,
    });
  });

  it("aposta no tempo normal (empate, 1X2, dupla chance) não é paga pelo placar com prorrogação", async () => {
    for (const [mercado, selecao] of [
      ["Money Line – Game", "Empate"],
      ["1X2", "X"],
      ["1X2", "Lakers"],
      ["Resultado Final", "Empate"],
      ["Dupla Chance", "Lakers ou Empate"],
      ["Draw No Bet", "Lakers"],
      ["Handicap Europeu", "Lakers -5"],
      ["Vencedor (tempo regulamentar)", "Lakers"],
    ] as const) {
      const ctx = await loadFlashscoreRegulationContext({
        candidate: basketballCandidate({ home: 110, away: 105 }),
        mercado,
        selecao,
        scoreOnlyMarket: true,
        cache: new Map(),
        sportId: 3,
        evento: "Lakers vs Celtics",
      });
      expect(ctx, `${mercado} / ${selecao}`).toEqual({
        decidedInExtraTime: true,
        extraTimePlayed: true,
        extraTimeCompatible: false,
        regulationEvidence: null,
        regulationAttempted: false,
      });
    }
  });

  it("Money Line com o time continua pago pelo placar com prorrogação", async () => {
    const ctx = await loadFlashscoreRegulationContext({
      candidate: basketballCandidate({ home: 110, away: 105 }),
      mercado: "Money Line – Game",
      selecao: "Lakers",
      scoreOnlyMarket: true,
      cache: new Map(),
      sportId: 3,
      evento: "Lakers vs Celtics",
    });
    expect(ctx.extraTimeCompatible).toBe(true);
  });

  it("futebol apos prorrogacao continua exigindo 90 (nao e regex including OT)", async () => {
    const ctx = await loadFlashscoreRegulationContext({
      candidate: basketballCandidate({ home: 2, away: 1 }),
      mercado: "Moneyline",
      // Fora de mercado só-placar a reconstrução de 90' não é consultada.
      scoreOnlyMarket: false,
      cache: new Map(),
      sportId: 1,
      evento: "Lakers vs Celtics",
    });
    expect(ctx.decidedInExtraTime).toBe(true);
    expect(ctx.extraTimeCompatible).toBe(false);
    expect(ctx.regulationEvidence).toBeNull();
  });

  it("ticket de basquete com OT bloqueia a perna de tempo normal", () => {
    expect(
      ticketFixtureExtraTimeNeed({
        status: {
          is_finished: true,
          is_finished_after_extra_time: true,
          is_finished_after_penalties: false,
        },
        mercados: ["1X2 Empate"],
        sportId: 3,
        regulationOnly: true,
      }),
    ).toBe("blocked");
  });

  it("ticket de basquete com OT usa aggregate (placar final)", () => {
    expect(
      ticketFixtureExtraTimeNeed({
        status: {
          is_finished: true,
          is_finished_after_extra_time: true,
          is_finished_after_penalties: false,
        },
        mercados: ["Money Line – Game"],
        sportId: 3,
      }),
    ).toBe("aggregate");
  });

  it("ticket de futebol com OT sem including OT exige regulation", () => {
    expect(
      ticketFixtureExtraTimeNeed({
        status: {
          is_finished: true,
          is_finished_after_extra_time: true,
          is_finished_after_penalties: false,
        },
        mercados: ["Moneyline"],
        sportId: 1,
      }),
    ).toBe("regulation");
  });
});


it("o rótulo da primeira perna com prorrogação não muda a segunda perna de 90 minutos", async () => {
  const ctx = await context({ mercado: "Vencedor incluindo prorrogação", penalties: false, legs: [
    { mercado: "Vencedor incluindo prorrogação", selecao: "Casa" },
    { mercado: "Total – Match", selecao: "Over 2.5" },
  ] });
  expect(ctx.extraTimeCompatible).toBe(false);
  expect(ctx.regulationEvidence).toBeNull();
  expect(ctx.summaryLookups).toBe(0);
});
