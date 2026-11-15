import { describe, expect, it } from "vitest";
import {
  extractLiveScoresAtTip,
  identityEventName,
  mentionsLiveEntryNearBet,
  resolveLiveScoreAtTip,
  stripKickoffFromSelection,
  stripLiveScoreAtTip,
  stripLiveScoreAtTipPrefix,
} from "@/src/domain/live-score-at-tip";

describe("placar no instante da tip", () => {
  it("lê prefixo na seleção e na linha rotulada da legenda", () => {
    expect(extractLiveScoresAtTip("(1-0) TPS +0.25")).toEqual([{ home: 1, away: 0 }]);
    expect(extractLiveScoresAtTip("🔴 Entrada: (2–0)+0.25\n1u @1.90")).toEqual([
      { home: 2, away: 0 },
    ]);
    expect(extractLiveScoresAtTip("Tip: (3:2) Away 0.0")).toEqual([
      { home: 3, away: 2 },
    ]);
  });

  it("não transforma resultado citado no meio de uma frase em placar da tip", () => {
    expect(extractLiveScoresAtTip("Jogo anterior terminou (1-0), agora vamos de Away +0.25"))
      .toEqual([]);
    expect(extractLiveScoresAtTip("(1-0)")).toEqual([]);
  });

  it("aceita sufixo somente em AH com linha numérica explícita", () => {
    expect(resolveLiveScoreAtTip({
      texts: ["Universitatea Craiova 0.0 (0-1)"],
      market: "Asian Handicap",
    })).toEqual({ ok: true, score: { home: 0, away: 1 } });
    expect(resolveLiveScoreAtTip({
      texts: ["Entrada: Copalera +025 (1-0)"],
      market: "Handicap – Match",
    })).toEqual({ ok: true, score: { home: 1, away: 0 } });
    expect(stripLiveScoreAtTip("Copalera +0.25 (1-0)", "Asian Handicap"))
      .toBe("Copalera +0.25");
  });

  it("não transforma DNB nem o mercado 1x2 em placar live", () => {
    expect(resolveLiveScoreAtTip({
      texts: ["Sanderfjord 2 DNB (1-0)"],
      market: "Handicap – Match",
    })).toEqual({ ok: true, score: null });
    expect(resolveLiveScoreAtTip({
      texts: ["Polisportiva Ossese +0 (1x2)"],
      market: "Handicap – Match",
    })).toEqual({ ok: true, score: null });
  });

  it("aceita evidência repetida, mas falha fechado quando seleção e legenda divergem", () => {
    expect(resolveLiveScoreAtTip({ texts: ["(1-0) Away 0", "Entrada: (1-0) Away 0"] }))
      .toEqual({ ok: true, score: { home: 1, away: 0 } });
    expect(resolveLiveScoreAtTip({ texts: ["(1-0) Away 0", "Entrada: (2-0) Away 0"] }))
      .toEqual({ ok: false, reason: "conflicting_live_score" });
  });

  it("na liquidação o remainder exige o par estruturado", () => {
    expect(resolveLiveScoreAtTip({
      texts: ["(1-0) Away 0"],
      requireStructured: true,
    })).toEqual({ ok: false, reason: "incomplete_live_score" });
    expect(resolveLiveScoreAtTip({
      liveScoreHome: 1,
      liveScoreAway: 0,
      texts: ["(1-0) Away 0"],
      requireStructured: true,
    })).toEqual({ ok: true, score: { home: 1, away: 0 } });
    expect(resolveLiveScoreAtTip({
      requireStructured: true,
    })).toEqual({ ok: true, score: null });
  });

  it.each([
    "⚽ (16:00) Flamengo x Palmeiras",
    "⏰ (21:00) Lakers x Celtics",
    "🕘(21:30) Real x Barça",
    "(20:45) - Real x Barça",
    "(19-09) Real x Barça",
    "Tip: (9:05) Away 0.0",
  ])("horário ou data entre parênteses não é placar: %s", (text) => {
    expect(extractLiveScoresAtTip(text)).toEqual([]);
    expect(stripLiveScoreAtTipPrefix(text)).toBe(text);
  });

  it("horário depois da linha do handicap também não é placar", () => {
    const caption = "🏀 NBA - Lakers x Celtics\nLakers -4.5 (21:00)\n@1.91 | 2u";
    expect(resolveLiveScoreAtTip({ texts: ["Lakers -4.5", caption], market: "Handicap" }))
      .toEqual({ ok: true, score: null });
    expect(stripLiveScoreAtTip("Lakers -4.5 (21:30)", "Handicap")).toBe("Lakers -4.5 (21:30)");
    // Uma legenda com dois jogos e seus horários não vira placar em conflito.
    expect(resolveLiveScoreAtTip({ texts: ["(16:00) Flamengo x Palmeiras\n(18:30) Santos x Corinthians"] }))
      .toEqual({ ok: true, score: null });
  });

  it.each([
    ["(21:00) Lakers -4.5", "Lakers -4.5"],
    ["⏰ (20:00) - Over 2.5", "Over 2.5"],
    ["Lakers -4.5 (21:00)", "Lakers -4.5"],
    ["Over 2.5 (19-09)", "Over 2.5"],
    // O sinal da linha no começo fica: sem ele o handicap se inverte.
    ["-4.5 (21:00)", "-4.5"],
    ["+2.5 (20:00)", "+2.5"],
    ["-1 (19-09)", "-1"],
    ["(21:00) -4.5", "-4.5"],
    ["(21:00)-4.5", "-4.5"],
    ["⏰ (21:00) -4.5", "-4.5"],
    ["(19-09) -1", "-1"],
    ["(21:00) - -4.5", "-4.5"],
    ["(21:00) - 4.5", "- 4.5"],
    ["(21:00) – 1", "– 1"],
    // Sem zero à esquerda o par pode ser o placar de um basquete: fica para a captura recusar.
    ["(20:45) Lakers -4.5", "(20:45) Lakers -4.5"],
    ["(1-0) Flamengo -0.5", "(1-0) Flamengo -0.5"],
    ["(0-0) Over 2.5", "(0-0) Over 2.5"],
    ["(21:00)", "(21:00)"],
  ])("horário ou data colados à seleção saem dela: %s → %s", (selection, expected) => {
    expect(stripKickoffFromSelection(selection)).toBe(expected);
  });

  it("placar com dois pontos continua placar quando não tem forma de horário", () => {
    expect(extractLiveScoresAtTip("(45:38) Lakers -4.5")).toEqual([{ home: 45, away: 38 }]);
    expect(extractLiveScoresAtTip("(0:0) Flamengo -0.5")).toEqual([{ home: 0, away: 0 }]);
    expect(extractLiveScoresAtTip("AO VIVO 21:30")).toEqual([{ home: 21, away: 30 }]);
  });

  it("reconhece prefixo fora do teto como inválido em vez de fingir ausência", () => {
    expect(resolveLiveScoreAtTip({ texts: ["(999-0) Away +0.25"] }))
      .toEqual({ ok: false, reason: "invalid_live_score" });
  });

  it("remove só o prefixo reconhecido da seleção financeira", () => {
    expect(stripLiveScoreAtTipPrefix("(1-0) TPS +0.25")).toBe("TPS +0.25");
    expect(stripLiveScoreAtTipPrefix("TPS +0.25 (1-0)")).toBe("TPS +0.25 (1-0)");
  });

  describe("prefixo 1x2/1×2 não é lido como placar live 1-2", () => {
    it.each([
      "(1x2) Flamengo -0.5",
      "(1×2) Flamengo -0.5",
      "(1X2) Real Madrid ML",
      "( 1 x 2 ) Chelsea -1",
      "( 1 × 2 ) Barcelona -0.75",
    ])("não extrai placar live de tag literal de mercado 1x2 no prefixo: %s", (text) => {
      expect(extractLiveScoresAtTip(text)).toEqual([]);
      expect(resolveLiveScoreAtTip({ texts: [text] })).toEqual({ ok: true, score: null });
      expect(stripLiveScoreAtTipPrefix(text)).toBe(text);
    });

    it("continua extraindo placares reais de futebol com separador x/× no prefixo", () => {
      expect(extractLiveScoresAtTip("(1x0) Flamengo -0.5")).toEqual([{ home: 1, away: 0 }]);
      expect(extractLiveScoresAtTip("(2×1) Flamengo -0.5")).toEqual([{ home: 2, away: 1 }]);
      expect(extractLiveScoresAtTip("(0x0) Flamengo -0.5")).toEqual([{ home: 0, away: 0 }]);
      expect(extractLiveScoresAtTip("(1×0) Flamengo -0.5")).toEqual([{ home: 1, away: 0 }]);
      expect(extractLiveScoresAtTip("(0×2) Flamengo -0.5")).toEqual([{ home: 0, away: 2 }]);
      expect(extractLiveScoresAtTip("(2×1) Flamengo -0.5")).toEqual([{ home: 2, away: 1 }]);
    });

    it("continua extraindo placar real 1-2 quando separador não é x/×", () => {
      expect(extractLiveScoresAtTip("(1-2) Flamengo -0.5")).toEqual([{ home: 1, away: 2 }]);
      expect(extractLiveScoresAtTip("(1:2) Flamengo -0.5")).toEqual([{ home: 1, away: 2 }]);
      expect(extractLiveScoresAtTip("(1–2) Flamengo -0.5")).toEqual([{ home: 1, away: 2 }]);
      expect(resolveLiveScoreAtTip({ texts: ["(1-2) Flamengo -0.5"] })).toEqual({
        ok: true,
        score: { home: 1, away: 2 },
      });
      expect(stripLiveScoreAtTipPrefix("(1-2) Flamengo -0.5")).toBe("Flamengo -0.5");
    });
  });
});

describe("normalização de seleção e remoção de placar ao vivo", () => {
  it("remove placar ao vivo da seleção limpa para qualquer tipo de mercado", () => {
    expect(stripLiveScoreAtTip("(1-0) Flamengo -0.5", "Handicap Asiático")).toBe("Flamengo -0.5");
    expect(stripLiveScoreAtTip("(1-0) Over 2.5", "Over/Under")).toBe("Over 2.5");
    expect(stripLiveScoreAtTip("(2-1) Real Madrid", "1x2")).toBe("Real Madrid");
  });
});

describe("placar da entrada escrito numa linha própria", () => {
  it.each([
    ["AO VIVO 1x0", { home: 1, away: 0 }],
    ["🔴 AO VIVO: 0-2", { home: 0, away: 2 }],
    ["Placar: 1-0", { home: 1, away: 0 }],
    ["Placar atual 2x1", { home: 2, away: 1 }],
  ])("'%s' é o placar estruturado da tip", (line, score) => {
    expect(extractLiveScoresAtTip(line)).toEqual([score]);
  });

  it.each(["AO VIVO 1x2", "Placar final: 2-1 ✅", "Já está 1x0 pro Flamengo", "🔴 AO VIVO"])("'%s' não é", (line) => {
    expect(extractLiveScoresAtTip(line)).toEqual([]);
  });
});

describe("entrada ao vivo dita perto da aposta", () => {
  it.each([
    ["🔴 AO VIVO\nJogo: Flamengo x Palmeiras\nEntrada: Flamengo -0.5\n@1.90\n1u", true],
    ["Jogo: Flamengo x Palmeiras\nEntrada: Flamengo -0.5 ao vivo\n@1.90\n1u", true],
    ["Jogo: Flamengo x Palmeiras\nEntrada: Flamengo -0.5\n@1.90\n1u\n\n📺 Acompanhe nossa live", false],
    ["Flamengo -0.5 @1.90 1u\n\nLive hoje às 20h", false],
  ] as const)("%j → %s", (caption, expected) => {
    expect(mentionsLiveEntryNearBet(caption, "Flamengo -0.5")).toBe(expected);
  });
});


it("a identidade mantém a ordem do placar mesmo numa entrada ao vivo em 0-0", () => {
  expect(identityEventName({ providerHome: "Palmeiras SP", providerAway: "Flamengo RJ", swapped: true, liveScoreHome: 0, liveScoreAway: 0 }))
    .toBe("Flamengo RJ vs Palmeiras SP");
});

it("a identidade mantém a ordem do post para a seleção que fala pela posição dos times", () => {
  const game = { providerHome: "Cruzeiro", providerAway: "Atletico Mineiro" };
  expect(identityEventName({ ...game, swapped: true, selectionFollowsOrder: true })).toBe("Atletico Mineiro vs Cruzeiro");
  expect(identityEventName({ ...game, swapped: false, selectionFollowsOrder: true })).toBe("Cruzeiro vs Atletico Mineiro");
  expect(identityEventName({ ...game, swapped: true })).toBe("Cruzeiro vs Atletico Mineiro");
});
