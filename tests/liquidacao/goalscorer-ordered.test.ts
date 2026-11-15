import { describe, expect, it } from "vitest";
import { orderedGoalsFromFlashscoreSummary, type FlashscoreSummaryResponse } from "@/src/providers/flashscore/summary";
import {
  orderedGoalscorerMarketOrder,
  resolveOrderedGoalscorer,
  type OrderedGoal,
} from "@/src/domain/settlement/goalscorer";

const jogadores = [
  { playerId: "p1", nome: "Haaland Erling", gols: 1, golsContra: 0, minutosJogados: 90, titular: true },
  { playerId: "p2", nome: "Foden Phil", gols: 1, golsContra: 0, minutosJogados: 75, titular: true },
  { playerId: "p3", nome: "Silva Bernardo", gols: 0, golsContra: 0, minutosJogados: 60, titular: true },
] as const;

const gols: OrderedGoal[] = [
  { playerId: "p2", nome: "Foden Phil", minuto: "12", ordinal: 1 },
  { playerId: "p1", nome: "Haaland Erling", minuto: "90+2", ordinal: 2 },
];

describe("artilheiro First/Last", () => {
  it.each([
    ["First Goalscorer", "first"],
    ["Primeiro a Marcar - Goalscorer", "first"],
    ["Last Goalscorer", "last"],
    ["Último Marcador", "last"],
  ] as const)("classifica %s como %s", (mercado, ordem) => {
    expect(orderedGoalscorerMarketOrder(mercado)).toBe(ordem);
  });

  it("mantém Anytime fora do resolver ordenado", () => {
    expect(orderedGoalscorerMarketOrder("Anytime Goalscorer")).toBeNull();
  });

  it.each([
    ["First Goalscorer", "Phil Foden", "WON"],
    ["First Goalscorer", "Erling Haaland", "LOST"],
    ["Last Goalscorer", "Erling Haaland", "WON"],
    ["Last Goalscorer", "Bernardo Silva", "LOST"],
  ] as const)("resolve %s / %s como %s", (mercado, selecao, status) => {
    expect(resolveOrderedGoalscorer({ mercado, selecao, jogadores, gols }))
      .toMatchObject({ ok: true, status });
  });

  it("recusa jogador ambíguo em vez de escolher um homônimo", () => {
    expect(resolveOrderedGoalscorer({
      mercado: "First Goalscorer",
      selecao: "Silva",
      jogadores: [
        { playerId: "p3", nome: "Silva Bernardo", gols: 0, golsContra: 0 },
        { playerId: "p4", nome: "Silva Andre", gols: 0, golsContra: 0 },
      ],
      gols,
    })).toMatchObject({ ok: false, reason: "jogador_ambiguo" });
  });
});

describe("sequência de gols do summary", () => {
  const summary = (events: FlashscoreSummaryResponse) =>
    orderedGoalsFromFlashscoreSummary({
      summary: events,
      listedScore: { home: 1, away: 1 },
    });

  it("preserva a ordem e usa o slug completo quando o nome vem abreviado", () => {
    expect(summary([
      {
        minutes: "12",
        team: "home",
        players: [{
          type: "Goal",
          name: "Foden P.",
          player_id: "p2",
          player_url: "/foden-phil/p2/",
        }],
      },
      {
        minutes: "90+2",
        team: "away",
        players: [{
          type: "Goal",
          name: "Haaland E.",
          player_id: "p1",
          player_url: "/haaland-erling/p1/",
        }],
      },
    ])).toEqual({
      ok: true,
      gols: [
        {
          playerId: "p2",
          nome: "foden phil",
          nomeCurto: "Foden P.",
          minuto: "12",
          ordinal: 1,
        },
        {
          playerId: "p1",
          nome: "haaland erling",
          nomeCurto: "Haaland E.",
          minuto: "90+2",
          ordinal: 2,
        },
      ],
    });
  });

  it.each([
    {
      label: "summary vazio",
      events: [],
      listedScore: { home: 0, away: 0 },
      reason: "summary_vazio",
    },
    {
      label: "placar não explicado",
      events: [{
        minutes: "12", team: "home" as const,
        players: [{ type: "Goal", name: "Foden", player_id: "p2" }],
      }],
      listedScore: { home: 2, away: 0 },
      reason: "summary_incompleto",
    },
    {
      label: "gols fora de ordem",
      events: [
        { minutes: "80", team: "home" as const, players: [{ type: "Goal", name: "Foden", player_id: "p2" }] },
        { minutes: "12", team: "away" as const, players: [{ type: "Goal", name: "Haaland", player_id: "p1" }] },
      ],
      listedScore: { home: 1, away: 1 },
      reason: "gols_nao_ordenados",
    },
    {
      label: "gol contra",
      events: [{
        minutes: "12", team: "away" as const,
        players: [{ type: "Own goal", name: "Defensor", player_id: "p4" }],
      }],
      listedScore: { home: 1, away: 0 },
      reason: "gol_contra_envolvido",
    },
  ])("recusa $label", ({ events, listedScore, reason }) => {
    expect(orderedGoalsFromFlashscoreSummary({ summary: events, listedScore }))
      .toEqual({ ok: false, reason });
  });
});


describe("T2-BUG-04: Goalscorer composto First or Last", () => {
  it.each([
    "First or Last Goalscorer",
    "Primeiro ou Último Marcador",
    "First/Last Goalscorer",
    "First Last Goalscorer",
    "Last or First Scorer",
    "Marcador - Primeiro e Último",
  ])("retorna null para mercado composto com first e last: %s", (mercado) => {
    expect(orderedGoalscorerMarketOrder(mercado)).toBeNull();
    expect(
      resolveOrderedGoalscorer({
        mercado,
        selecao: "Phil Foden",
        jogadores,
        gols,
      }),
    ).toEqual({ ok: false, reason: "mercado_sem_ordem" });
  });
});

describe("T2-BUG-05: Goalscorer com qualificadores de período", () => {
  it.each([
    "1st Half Goalscorer",
    "First Half Goalscorer",
    "1º Tempo Marcador",
    "Primeiro Tempo Marcador",
    "Marcador 1st Half",
    "Marcador 1T",
    "Marcador 1º Tempo",
    "Marcador 1st Quarter",
    "1st Half - First Goalscorer",
    "First Half - Last Goalscorer",
  ])("retorna null para mercado de artilheiro de período: %s", (mercado) => {
    expect(orderedGoalscorerMarketOrder(mercado)).toBeNull();
    expect(
      resolveOrderedGoalscorer({
        mercado,
        selecao: "Phil Foden",
        jogadores,
        gols,
      }),
    ).toEqual({ ok: false, reason: "mercado_sem_ordem" });
  });
});

describe("T2-R2-BUG-01: Goalscorer com escopo de periodo recusado via marketPeriodOf", () => {
  it.each([
    "HT First Goalscorer",
    "2nd Half - Last Goalscorer",
    "1st Period First Goalscorer",
    "Overtime First Goalscorer",
    "Half Time First Goalscorer",
    "1T Marcador - Primeiro",
    "2T Marcador - Ultimo",
    "Primeiro Tempo - Primeiro Marcador",
  ])("recusa mercado de periodo que nao seja FT: %s", (mercado) => {
    expect(orderedGoalscorerMarketOrder(mercado)).toBeNull();
    expect(
      resolveOrderedGoalscorer({
        mercado,
        selecao: "Phil Foden",
        jogadores,
        gols,
      }),
    ).toEqual({ ok: false, reason: "mercado_sem_ordem" });
  });
});

describe("T2-R2-BUG-02: DNP em First/Last Goalscorer", () => {
  it("reserva que não entrou sai VOID", () => {
    const jogadoresComDNP = [
      { playerId: "p1", nome: "Haaland Erling", gols: 1, golsContra: 0, minutosJogados: 90 },
      { playerId: "p2", nome: "Foden Phil", gols: 1, golsContra: 0, minutosJogados: 75 },
      { playerId: "p3", nome: "Silva Bernardo", gols: 0, golsContra: 0, minutosJogados: 0 },
    ] as const;

    expect(
      resolveOrderedGoalscorer({
        mercado: "First Goalscorer",
        selecao: "Bernardo Silva",
        jogadores: jogadoresComDNP,
        gols,
      }),
    ).toMatchObject({ ok: true, status: "VOID" });

    expect(
      resolveOrderedGoalscorer({
        mercado: "Last Goalscorer",
        selecao: "Bernardo Silva",
        jogadores: jogadoresComDNP,
        gols,
      }),
    ).toMatchObject({ ok: true, status: "VOID" });
  });

  it("sem minutos, o titular que marcou mas não primeiro sai LOST: estava em campo no primeiro gol", () => {
    const semMinutos = jogadores.map(({ minutosJogados: _minutos, ...jogador }) => jogador);
    expect(resolveOrderedGoalscorer({
      mercado: "First Goalscorer", selecao: "Erling Haaland", jogadores: semMinutos, gols,
    })).toMatchObject({ ok: true, status: "LOST" });
  });

  it("sem minutos nem titularidade, marcar depois do primeiro gol não prova que já estava em campo nele", () => {
    const semEntrada = jogadores.map(({ minutosJogados: _minutos, titular: _titular, ...jogador }) => jogador);
    expect(resolveOrderedGoalscorer({
      mercado: "First Goalscorer", selecao: "Erling Haaland", jogadores: semEntrada, gols,
    })).toEqual({ ok: false, reason: "entrada_apos_primeiro_gol_nao_descartada" });
  });

  it("recusa quando o selecionado não marcou primeiro e o feed não prova que ele entrou", () => {
    const semMinutos = [
      ...jogadores.slice(0, 2),
      { playerId: "p3", nome: "Silva Bernardo", gols: 0, golsContra: 0 },
    ];
    expect(resolveOrderedGoalscorer({
      mercado: "First Goalscorer", selecao: "Bernardo Silva", jogadores: semMinutos, gols,
    })).toEqual({ ok: false, reason: "participacao_nao_comprovada" });
  });

  it("titular que jogou e não marcou primeiro/último sai LOST", () => {
    for (const mercado of ["First Goalscorer", "Last Goalscorer"]) {
      expect(resolveOrderedGoalscorer({ mercado, selecao: "Bernardo Silva", jogadores, gols }), mercado)
        .toMatchObject({ ok: true, status: "LOST" });
    }
  });
});

/**
 * No primeiro a marcar, a casa anula a aposta no reserva que entrou depois do
 * primeiro gol: ele nunca teve chance de ganhar. LOST só com prova de que ele
 * já estava em campo no gol.
 */
describe("primeiro a marcar com reserva", () => {
  const comReserva = (minutosJogados: number) => [
    ...jogadores.slice(0, 2),
    { playerId: "p3", nome: "Silva Bernardo", gols: 0, golsContra: 0, minutosJogados, titular: false },
  ];

  it("reserva com 20 minutos e primeiro gol aos 12' não sai LOST: vai para o operador", () => {
    expect(resolveOrderedGoalscorer({
      mercado: "First Goalscorer", selecao: "Bernardo Silva", jogadores: comReserva(20), gols,
    })).toEqual({ ok: false, reason: "entrada_apos_primeiro_gol_nao_descartada" });
  });

  it("reserva que marcou depois do primeiro gol também não sai LOST sem prova da entrada", () => {
    const reservaQueMarcou = [
      jogadores[1],
      { playerId: "p1", nome: "Haaland Erling", gols: 1, golsContra: 0, minutosJogados: 30, titular: false },
    ];
    expect(resolveOrderedGoalscorer({
      mercado: "First Goalscorer", selecao: "Erling Haaland", jogadores: reservaQueMarcou, gols,
    })).toEqual({ ok: false, reason: "entrada_apos_primeiro_gol_nao_descartada" });
  });

  it("reserva cujos minutos provam a entrada antes do primeiro gol sai LOST", () => {
    // 40 minutos jogados: entrou até os 65', mesmo com 15 de acréscimo; o gol foi aos 80'.
    const golTardio: OrderedGoal[] = [{ playerId: "p2", nome: "Foden Phil", minuto: "80", ordinal: 1 }];
    expect(resolveOrderedGoalscorer({
      mercado: "First Goalscorer", selecao: "Bernardo Silva", jogadores: comReserva(40), gols: golTardio,
    })).toMatchObject({ ok: true, status: "LOST" });
  });

  it("último a marcar não muda: o reserva que entrou disputa o último gol", () => {
    expect(resolveOrderedGoalscorer({
      mercado: "Last Goalscorer", selecao: "Bernardo Silva", jogadores: comReserva(20), gols,
    })).toMatchObject({ ok: true, status: "LOST" });
  });
});
