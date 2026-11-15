import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { findStalledSettlementCandidates } from "@/src/services/settlement/ia-judge/candidates";
import {
  AUTO_SETTLE_MIN_CONFIDENCE,
  autoSettleGroundedIaJudgeSuggestion,
  runIaJudgeCycle,
} from "@/src/services/settlement/ia-judge/cycle";
import { approveIaJudgeSuggestion, rejectIaJudgeSuggestion } from "@/src/services/settlement/ia-judge/suggestions";
import { operationalActionFingerprint, reportOperationalAction } from "@/src/services/ops/operational-actions";
import { llmGenerateJson } from "@/src/infra/llm/cascade";
import { geminiGenerateJsonWithSearch, resolveGroundingRedirectHost } from "@/src/infra/llm/gemini-search";
import { sendOperatorNotification } from "@/src/services/ops/alerts";

vi.mock("@/src/infra/llm/cascade", () => ({ llmGenerateJson: vi.fn() }));
vi.mock("@/src/infra/llm/gemini-search", () => ({
  geminiGenerateJsonWithSearch: vi.fn(),
  resolveGroundingRedirectHost: vi.fn(),
}));

vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: vi.fn(),
  sendOperatorNotification: vi.fn(),
}));

let db: TestDb;

const PAST = new Date("2026-01-01T12:00:00Z");
const NOW = new Date("2026-01-01T20:00:00Z"); // 8h após o kickoff

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
  vi.resetAllMocks();
});

async function seed(overrides?: {
  evento?: string;
  esporte?: string;
  competicao?: string;
  mercado?: string;
  selecao?: string;
  liveScoreHome?: number;
  liveScoreAway?: number;
  liveTextAtCapture?: boolean;
}) {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Banca Auto-Settle", slug: "banca-auto-settle", valorUnidade: 50 },
  });
  const conta = await db.prisma.conta.create({
    data: {
      casaDeAposta: "Pinnacle",
      titular: "Fabricio",
      saldoInicial: 1000,
      saldoAtual: 1000,
    },
  });

  const bet = await db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      contaId: conta.id,
      data: PAST,
      evento: "Dumbarton vs Celtic B",
      esporte: "Soccer",
      competicao: "Scottish Challenge Cup",
      odds: 1.8,
      stake: 1,
      status: "PENDING",
      mercado: "Handicap – Match",
      selecao: "Celtic II +0.5",
      ...overrides,
    },
  });

  return { bankroll, conta, bet };
}

describe("IA-Judge — Auto-Settlement (SET-004)", () => {
  it("declara o limiar mínimo de auto-liquidação em 95%", () => {
    expect(AUTO_SETTLE_MIN_CONFIDENCE).toBe(0.95);
  });

  it("identifica apostas paradas de mercado placar (Handicap/Totais) que o Flashscore não cobriu", async () => {
    const s = await seed();
    const stalled = await findStalledSettlementCandidates(NOW);
    expect(stalled.map((b) => b.id)).toContain(s.bet.id);
  });

  it("auto-liquida somente com confiança >= 0.95 e citação grounded confiável", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: true,
        valueFound: "2-2",
        suggestedOutcome: "WON",
        confidence: 0.98,
        reason: "Placar oficial final foi Dumbarton 2x2 Celtic B",
        sourceUrl: "https://www.bbc.com/sport/football",
      },
      provider: "gemini",
      sources: [{
        url: "https://www.bbc.com/sport/football",
        title: "BBC Sport",
      }],
      supports: [{
        text: "Dumbarton 2-2 Celtic B",
        sources: [{ url: "https://www.bbc.com/sport/football", title: "BBC Sport" }],
      }],
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    const result = await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });
    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.created).toBe(1);

    // Aposta foi liquidada diretamente para WON
    const updatedBet = await db.prisma.bet.findUniqueOrThrow({
      where: { id: s.bet.id },
    });
    expect(updatedBet.status).toBe("WON");
    expect(updatedBet.settledAt).not.toBeNull();
    expect(Number(updatedBet.lucro)).toBeCloseTo(0.8);

    // Sugestão gravada como APPROVED
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirst({
      where: { betId: s.bet.id },
    });
    expect(suggestion).not.toBeNull();
    expect(suggestion?.status).toBe("APPROVED");
    expect(suggestion?.resolvedBy).toBe("ia_judge_auto");
    expect(suggestion?.sourceUrl).toBe("https://www.bbc.com/sport/football");
    expect(suggestion?.evidenceKind).toBe("GROUNDED_WEB");
    expect(suggestion?.groundingQuery).toContain("Dumbarton vs Celtic B");
    expect(suggestion?.groundingSources).toEqual([{
      url: "https://www.bbc.com/sport/football",
      title: "BBC Sport",
    }]);
    expect(suggestion?.groundedAt).not.toBeNull();

    // Saldo da conta foi atualizado
    const updatedConta = await db.prisma.conta.findUniqueOrThrow({
      where: { id: s.conta.id },
    });
    expect(Number(updatedConta.saldoAtual)).toBeGreaterThan(1000);
  });

  it("quarto de linha asiática não liquida sozinho: a confiança vira a da dúvida e a sugestão fica para o dono", async () => {
    const s = await seed({ selecao: "Celtic II +0.25" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: true, valueFound: "2-2", suggestedOutcome: "WON", confidence: 0.98,
        reason: "Placar oficial final foi Dumbarton 2x2 Celtic B", sourceUrl: "https://www.bbc.com/sport/football",
      },
      provider: "gemini",
      sources: [{ url: "https://www.bbc.com/sport/football", title: "BBC Sport" }],
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    expect(await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true })).toMatchObject({ created: 1 });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    expect(suggestion.status).toBe("PENDING");
    expect(Number(suggestion.confidence)).toBe(0.9);
  });

  it("futebol decidido na prorrogação não liquida sozinho, mesmo com o modelo certo de si", async () => {
    const s = await seed({ mercado: "Money Line – Match", selecao: "Dumbarton" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: true, valueFound: "placar 1-1 no tempo regulamentar", suggestedOutcome: "LOST", confidence: 0.97,
        reason: "Empate nos 90 minutos; Celtic B venceu na prorrogação.", sourceUrl: "https://www.bbc.com/sport/football",
        decidedAfterRegulation: true, interruptedOrWalkover: false,
      },
      provider: "gemini",
      sources: [{ url: "https://www.bbc.com/sport/football", title: "BBC Sport" }],
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    expect(await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true })).toMatchObject({ created: 1 });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    expect(suggestion.status).toBe("PENDING");
    expect(Number(suggestion.confidence)).toBe(0.9);
  });

  it("'não houve prorrogação' no texto do modelo não segura a liquidação do futebol", async () => {
    const s = await seed({ mercado: "Money Line – Match", selecao: "Dumbarton" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: true, valueFound: "placar 2-1 no tempo regulamentar", suggestedOutcome: "WON", confidence: 0.97,
        reason: "Dumbarton venceu por 2-1; não houve prorrogação nem pênaltis.", sourceUrl: "https://www.bbc.com/sport/football",
        decidedAfterRegulation: false, interruptedOrWalkover: false,
      },
      provider: "gemini",
      sources: [{ url: "https://www.bbc.com/sport/football", title: "BBC Sport" }],
      // O Gemini divide o resumo por frase: os times vêm na anterior.
      supports: [
        { text: "Dumbarton recebeu o Celtic B.", sources: [{ url: "https://www.bbc.com/sport/football", title: "BBC Sport" }] },
        { text: "Dumbarton 2-1 Celtic B no tempo regulamentar.", sources: [{ url: "https://www.bbc.com/sport/football", title: "BBC Sport" }] },
      ],
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    expect(await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true })).toMatchObject({ created: 1 });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("WON");
  });

  it("falha fechado sem citations mesmo com confiança 0.99", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: true,
        valueFound: "2-2",
        suggestedOutcome: "WON",
        confidence: 0.99,
        reason: "O modelo declarou resultado, mas a busca não citou fonte",
        sourceUrl: "https://www.bbc.com/sport/football",
      },
      provider: "gemini",
      sources: [],
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    expect(await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true }))
      .toMatchObject({ created: 1 });

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } });
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({
      where: { betId: s.bet.id },
    });
    const conta = await db.prisma.conta.findUniqueOrThrow({ where: { id: s.conta.id } });
    expect(bet.status).toBe("PENDING");
    expect(bet.settledAt).toBeNull();
    expect(suggestion.status).toBe("PENDING");
    expect(suggestion.sourceUrl).toBeNull();
    expect(suggestion.groundingSources).toEqual([]);
    expect(Number(conta.saldoAtual)).toBe(1000);
  });

  it("não auto-liquida resposta estruturada do LLM sem busca grounded", async () => {
    const s = await seed({
      mercado: "Player Shots on Target",
      selecao: "Player X Over 0.5",
    });
    await db.prisma.betResult.create({
      data: {
        betId: s.bet.id,
        resultProvider: "flashscore",
        resultFinal: false,
        resultSnapshot: {
          outcome: "matched",
          finished: true,
          score: { home: 2, away: 2 },
        },
      },
    });
    vi.mocked(llmGenerateJson).mockResolvedValue({
      data: {
        resolved: true,
        valueFound: "2 finalizações no alvo",
        suggestedOutcome: "WON",
        confidence: 0.99,
        reason: "Inferência sobre evidência estruturada",
        sourceUrl: "https://www.bbc.com/sport/football",
      },
      provider: "gemini",
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    expect(await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true }))
      .toMatchObject({ created: 1 });

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } });
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({
      where: { betId: s.bet.id },
    });
    expect(geminiGenerateJsonWithSearch).not.toHaveBeenCalled();
    expect(bet.status).toBe("PENDING");
    expect(suggestion.status).toBe("PENDING");
    expect(suggestion.evidenceKind).toBe("FLASHSCORE_STRUCTURED");
    expect(suggestion.groundingSources).toBeNull();
  });

  it("gera sugestão PENDING para homologação quando confiança é intermediária (0.85)", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: true,
        valueFound: "Possível 2-2",
        suggestedOutcome: "WON",
        confidence: 0.85,
        reason: "Fonte preliminar indica empate",
        sourceUrl: "https://example.com/score",
      },
      provider: "gemini",
      sources: [],
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    const result = await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });
    expect(result.created).toBe(1);

    // Aposta permanece PENDING
    const bet = await db.prisma.bet.findUniqueOrThrow({
      where: { id: s.bet.id },
    });
    expect(bet.status).toBe("PENDING");

    // Sugestão criada como PENDING para 1 clique
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirst({
      where: { betId: s.bet.id },
    });
    expect(suggestion).not.toBeNull();
    expect(suggestion?.status).toBe("PENDING");
  });
});

/**
 * Formato REAL das citações do Gemini em produção (estrutura copiada da tabela
 * `ia_judge_suggestions`, sem dados): a URL é um redirecionamento do Google e
 * o domínio da página vem no `title`.
 */
const REDIRECT_SOFASCORE =
  "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHexemploSofascore";
const REDIRECT_FORA_DA_LISTA =
  "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHexemploForaDaLista";
const REAL_SOURCES = [
  { url: REDIRECT_SOFASCORE, title: "sofascore.com" },
  { url: REDIRECT_FORA_DA_LISTA, title: "noticias-esportivas.example" },
];

/** Trecho da busca que o Google amarra à citação (formato de `groundingSupports`). */
const SUPPORTS_SOFASCORE = [{ text: "Dumbarton e Celtic B empataram por 2 a 2.", sources: [REAL_SOURCES[0]!] }];

function groundedAnswer(sourceUrl: string, sources = REAL_SOURCES, supports = SUPPORTS_SOFASCORE) {
  return {
    data: {
      resolved: true,
      valueFound: "2-2",
      suggestedOutcome: "WON",
      confidence: 1,
      reason: "Placar final 2x2",
      sourceUrl,
    },
    provider: "gemini" as const,
    sources,
    supports,
  };
}

describe("IA-Judge — citações no formato real do Gemini", () => {
  beforeEach(() => {
    // O HEAD do redirecionamento aponta para o domínio do title.
    vi.mocked(resolveGroundingRedirectHost).mockResolvedValue("www.sofascore.com");
  });

  it("liquida sozinho quando a fonte afirmada é o redirecionamento citado de um domínio confiável", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(groundedAnswer(REDIRECT_SOFASCORE));
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("WON");
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    expect(suggestion).toMatchObject({ status: "APPROVED", sourceUrl: REDIRECT_SOFASCORE });
    expect(sendOperatorNotification).toHaveBeenCalledWith(expect.stringContaining("Fonte: sofascore.com"), expect.objectContaining({ key: expect.stringMatching(/^ia-judge-settlement:/) }));
  });

  it("aceita a página afirmada quando o domínio dela está entre as citações", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(
      groundedAnswer("https://www.sofascore.com/football/match/dumbarton-celtic-b/abc"),
    );
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    expect(suggestion).toMatchObject({
      status: "APPROVED",
      sourceUrl: "https://www.sofascore.com/football/match/dumbarton-celtic-b/abc",
    });
  });

  it("resultado sem trecho sustentado pelo domínio confiável fica para homologação", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(groundedAnswer(
      REDIRECT_SOFASCORE,
      REAL_SOURCES,
      [{ text: "Dumbarton e Celtic B empataram por 2 a 2.", sources: [REAL_SOURCES[1]!] }],
    ));
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    expect(await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } }))
      .toMatchObject({ status: "PENDING", sourceUrl: REDIRECT_SOFASCORE });
    expect(resolveGroundingRedirectHost).not.toHaveBeenCalled();
  });

  it("número de outra estatística no trecho fica para homologação, sem mexer no saldo", async () => {
    const s = await seed({ mercado: "Total (Corners) – Match", selecao: "Over 9.5" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      ...groundedAnswer(REDIRECT_SOFASCORE, REAL_SOURCES, [
        { text: "Dumbarton e Celtic B: 11 faltas e 7 escanteios.", sources: [REAL_SOURCES[0]!] },
      ]),
      data: { ...groundedAnswer(REDIRECT_SOFASCORE).data, valueFound: "escanteios 11" },
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    expect(await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } }))
      .toMatchObject({ status: "PENDING" });
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: s.conta.id } })).saldoAtual)).toBe(1000);
    expect(resolveGroundingRedirectHost).not.toHaveBeenCalled();
  });

  it("placar invertido no trecho ('venceu por 2 a 1' contra '1-2') fica para homologação", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      ...groundedAnswer(REDIRECT_SOFASCORE, REAL_SOURCES, [
        { text: "O mandante venceu por 2 a 1.", sources: [REAL_SOURCES[0]!] },
      ]),
      data: { ...groundedAnswer(REDIRECT_SOFASCORE).data, valueFound: "1-2" },
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    expect(resolveGroundingRedirectHost).not.toHaveBeenCalled();
  });

  it("o HEAD confere a citação que sustenta o placar, não só a afirmada", async () => {
    const s = await seed();
    const REDIRECT_TRECHO =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHexemploTrecho";
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(groundedAnswer(
      REDIRECT_SOFASCORE,
      [...REAL_SOURCES, { url: REDIRECT_TRECHO, title: "sofascore.com" }],
      [{ text: "Dumbarton e Celtic B empataram por 2 a 2.", sources: [{ url: REDIRECT_TRECHO, title: "sofascore.com" }] }],
    ));
    // O redirect do trecho aponta para outro domínio, apesar do title.
    vi.mocked(resolveGroundingRedirectHost).mockImplementation(async (url) =>
      url === REDIRECT_TRECHO ? "golpe.example" : "www.sofascore.com");
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect(resolveGroundingRedirectHost).toHaveBeenCalledWith(REDIRECT_TRECHO);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
  });

  it("redirecionamento que o HEAD não confirma para o domínio do title fica para homologação", async () => {
    const s = await seed();
    vi.mocked(resolveGroundingRedirectHost).mockResolvedValue("sofascore.com.golpe.example");
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(groundedAnswer(REDIRECT_SOFASCORE));
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect(resolveGroundingRedirectHost).toHaveBeenCalledWith(REDIRECT_SOFASCORE);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    expect(await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } }))
      .toMatchObject({ status: "PENDING" });
  });

  it("não liquida quando a fonte afirmada só tem citação de domínio fora da lista", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(groundedAnswer(REDIRECT_FORA_DA_LISTA));
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    expect(suggestion).toMatchObject({ status: "PENDING", sourceUrl: null });
  });

  it("fonte afirmada fora das citações não é trocada por outra citação confiável", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(groundedAnswer(
      "https://www.espn.com/soccer/match/_/gameId/1",
      [{ url: "https://www.bbc.com/sport/football", title: "BBC Sport" }],
    ));
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    expect(suggestion).toMatchObject({ status: "PENDING", sourceUrl: null });
  });
});

describe("IA-Judge — só o resultado do jogo inteiro liquida sozinho", () => {
  beforeEach(() => {
    vi.mocked(resolveGroundingRedirectHost).mockResolvedValue("www.sofascore.com");
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);
  });

  /** Veredito certo de si, com a fonte afirmada citada e o trecho dela provando o resultado. */
  function citedVerdict(valueFound: string, text: string) {
    return {
      data: {
        resolved: true, valueFound, suggestedOutcome: "WON", confidence: 0.99,
        reason: "Conferido na fonte citada", sourceUrl: REDIRECT_SOFASCORE,
      },
      provider: "gemini" as const,
      sources: REAL_SOURCES,
      supports: [{ text, sources: [REAL_SOURCES[0]!] }],
    };
  }

  async function expectOnlySuggestion(bet: { bet: { id: string }; conta: { id: string } }) {
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.bet.id } })).status).toBe("PENDING");
    expect(await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: bet.bet.id } }))
      .toMatchObject({ status: "PENDING", suggestedStatus: "WON" });
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: bet.conta.id } })).saldoAtual)).toBe(1000);
  }

  it.each([
    {
      caso: "1º tempo",
      bet: { mercado: "1º Tempo - Resultado", selecao: "Dumbarton" },
      valueFound: "1º tempo: 1-0",
      text: "Dumbarton 1-0 Celtic B no primeiro tempo.",
    },
    {
      caso: "escanteios",
      bet: { mercado: "Total (Corners) – Match", selecao: "Over 9.5" },
      valueFound: "escanteios 6-5",
      text: "Dumbarton e Celtic B: escanteios 6-5.",
    },
    {
      caso: "artilheiro",
      bet: { mercado: "Anytime Goalscorer", selecao: "Pedro" },
      valueFound: "Pedro marcou no 2-1",
      text: "Pedro marcou e o Dumbarton venceu o Celtic B por 2 a 1.",
    },
    {
      caso: "prop de jogador",
      bet: {
        evento: "Lakers vs Celtics", esporte: "Basketball", competicao: "NBA",
        mercado: "Player Points", selecao: "Jayson Tatum Over 27.5",
      },
      valueFound: "Tatum 31 pontos no 110-105",
      text: "Jayson Tatum scored 31 as the Lakers beat the Celtics 110-105.",
    },
  ])("$caso com confiança 0,99 e citação perfeita vira sugestão para o dono", async ({ bet, valueFound, text }) => {
    const s = await seed(bet);
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(citedVerdict(valueFound, text));

    expect(await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true })).toMatchObject({ created: 1 });

    await expectOnlySuggestion(s);
  });

  it("múltipla não liquida sozinha, nem com o placar de uma perna citado", async () => {
    const s = await seed({
      evento: "Dumbarton vs Celtic B | Flamengo vs Vasco",
      mercado: "Money Line – Match",
      selecao: "Dumbarton / Flamengo",
    });
    await db.prisma.bet.update({
      where: { id: s.bet.id },
      data: {
        legsJson: {
          kind: "parlay",
          legs: [
            { evento: "Dumbarton vs Celtic B", mercado: "Money Line – Match", selecao: "Dumbarton" },
            { evento: "Flamengo vs Vasco", mercado: "Money Line – Match", selecao: "Flamengo" },
          ],
        },
      },
    });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(
      citedVerdict("placar 2-1", "Dumbarton venceu o Celtic B por 2 a 1."),
    );

    expect(await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true })).toMatchObject({ created: 1 });

    await expectOnlySuggestion(s);
  });

  it("múltipla registrada à mão sem as pernas também não liquida sozinha", async () => {
    const s = await seed({
      evento: "Dumbarton vs Celtic B | Flamengo vs Vasco",
      mercado: "Money Line – Match",
      selecao: "Dumbarton e Flamengo",
    });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(
      citedVerdict("placar 2-1", "Dumbarton venceu o Celtic B por 2 a 1."),
    );

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    await expectOnlySuggestion(s);
  });

  it("placar do intervalo no trecho não liquida o jogo inteiro", async () => {
    const s = await seed({ mercado: "Money Line – Match", selecao: "Dumbarton" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(
      citedVerdict("placar 1-0", "At the break, Dumbarton led Celtic B 1-0."),
    );

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    await expectOnlySuggestion(s);
  });

  it.each([
    { caso: "com o placar da entrada", bet: { liveScoreHome: 1, liveScoreAway: 0 } },
    { caso: "com a legenda dizendo ao vivo", bet: { liveTextAtCapture: true } },
  ])("handicap pego ao vivo $caso não liquida pelo placar do jogo inteiro", async ({ bet }) => {
    // Entrada com 1-0 e final 1-0: depois da entrada foi 0-0, e o -0.5 perdeu.
    const s = await seed({ selecao: "Dumbarton -0.5", ...bet });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(citedVerdict("placar 1-0", "Dumbarton 1-0 Celtic B."));

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    await expectOnlySuggestion(s);
    if (bet.liveScoreHome !== undefined) {
      expect(vi.mocked(geminiGenerateJsonWithSearch).mock.calls[0]![0].query).toContain('"placarNaEntrada":"1-0"');
    }
  });

  it("veredito que a conta do placar citado não dá fica para o dono", async () => {
    // 1-1 são dois gols: o Over 2.5 perdeu, e o modelo disse WON.
    const s = await seed({ mercado: "Total – Match", selecao: "Over 2.5" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(citedVerdict("placar 1-1", "Dumbarton 1-1 Celtic B."));

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    await expectOnlySuggestion(s);
    expect(resolveGroundingRedirectHost).not.toHaveBeenCalled();
  });

  it("vencedor com o trecho em frase corrida não diz de quem é cada número: fica para o dono", async () => {
    const s = await seed({ mercado: "Money Line – Match", selecao: "Dumbarton" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(
      citedVerdict("placar 2-1", "Dumbarton e Celtic B se enfrentaram, e o jogo terminou 2-1."),
    );

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    await expectOnlySuggestion(s);
  });

  it("vencedor com o trecho na forma de placar liquida, mesmo com o visitante escrito primeiro", async () => {
    const s = await seed({ mercado: "Money Line – Match", selecao: "Dumbarton" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(citedVerdict("placar 1-2", "Celtic B 1-2 Dumbarton."));

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("WON");
  });

  it("total do jogo com um placar só e sem parte do jogo liquida sozinho", async () => {
    const s = await seed({ mercado: "Total – Match", selecao: "Over 2.5" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(
      citedVerdict("placar 2-2", "Dumbarton e Celtic B empataram por 2 a 2."),
    );

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("WON");
    expect(await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } }))
      .toMatchObject({ status: "APPROVED", resolvedBy: "ia_judge_auto" });
  });
});

describe("IA-Judge — prorrogação e jogo interrompido só viram sugestão", () => {
  it("escanteios de 90' em jogo com prorrogação: sugere, não liquida, e a busca recebe o fato", async () => {
    const s = await seed({
      evento: "Dumbarton vs Celtic B",
      mercado: "Total (Corners) – Match",
      selecao: "Over 9.5",
    });
    await db.prisma.betResult.create({
      data: {
        betId: s.bet.id,
        resultProvider: "flashscore",
        resultFinal: false,
        resultSnapshot: {
          outcome: "matched",
          settlementOutcome: "manual_extra_time",
          stage: "After Extra Time",
          finished: true,
          score: { home: 2, away: 1 },
        },
      },
    });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(groundedAnswer(REDIRECT_SOFASCORE));
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    expect(suggestion.status).toBe("PENDING");
    expect(suggestion.groundingQuery).toContain("houve prorrogação");
    expect(suggestion.groundingQuery).toContain("Placar do tempo regulamentar: não disponível");
    expect(vi.mocked(geminiGenerateJsonWithSearch).mock.calls[0]![0].query).toContain("houve prorrogação");
  });

  it("jogo interrompido que o FlashScore ainda observa: sugere, não liquida", async () => {
    const s = await seed({
      evento: "Sinner vs Alcaraz",
      esporte: "Tennis",
      competicao: "ATP",
      mercado: "Match Winner",
      selecao: "Sinner",
    });
    await db.prisma.betResult.create({
      data: {
        betId: s.bet.id,
        resultProvider: "flashscore",
        resultFinal: false,
        resultSnapshot: {
          outcome: "matched",
          settlementOutcome: "manual_abandoned",
          stage: "Abandoned",
          finished: false,
          score: { home: 1, away: 1 },
        },
      },
    });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(groundedAnswer(REDIRECT_SOFASCORE));
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    expect(suggestion.status).toBe("PENDING");
    expect(suggestion.groundingQuery).toContain("não foi jogada até o fim");
  });

  it("jogo que o FlashScore casou e ainda vê sem fim: sugere, não liquida, e a busca recebe o fato", async () => {
    // Tênis atrasado pela chuva: 8h depois do horário previsto ainda não começou.
    const s = await seed({
      evento: "Sinner vs Alcaraz", esporte: "Tennis", competicao: "ATP", mercado: "Match Winner", selecao: "Sinner",
    });
    await db.prisma.betResult.create({ data: {
      betId: s.bet.id, resultProvider: "flashscore", resultFinal: false,
      resultSnapshot: {
        outcome: "matched", settlementOutcome: "not_attempted", sportId: 2, stage: null,
        cancelled: false, postponed: false, finished: false, score: null,
        providerKickoff: "2026-01-01T12:00:00.000Z",
      },
    } });
    vi.mocked(resolveGroundingRedirectHost).mockResolvedValue("www.sofascore.com");
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(groundedAnswer(REDIRECT_SOFASCORE));
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    const suggestion = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    expect(suggestion.status).toBe("PENDING");
    expect(suggestion.groundingQuery).toContain("a partida ainda não terminou");
  });
});

describe("IA-Judge — a recusa do dono vale para a liquidação sozinha", () => {
  const HOUR = 3_600_000;
  const citedWin = (confidence: number) => ({
    data: {
      resolved: true, valueFound: "2-2", suggestedOutcome: "WON", confidence,
      reason: "Placar oficial final foi Dumbarton 2x2 Celtic B", sourceUrl: "https://www.bbc.com/sport/football",
    },
    provider: "gemini" as const,
    sources: [{ url: "https://www.bbc.com/sport/football", title: "BBC Sport" }],
    supports: [{
      text: "Dumbarton 2-2 Celtic B",
      sources: [{ url: "https://www.bbc.com/sport/football", title: "BBC Sport" }],
    }],
  });

  it("depois do 'Rejeitar', a IA volta a olhar e só sugere, mesmo certa de si com fonte", async () => {
    // O cooldown da recusa usa o relógio real: o ciclo roda relativo a ele.
    const base = new Date();
    const s = await seed();
    await db.prisma.bet.update({ where: { id: s.bet.id }, data: { data: new Date(base.getTime() - 8 * HOUR) } });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(citedWin(0.9));
    expect(await runIaJudgeCycle(base, { includeStalled: true, autoSettle: true })).toMatchObject({ created: 1 });
    const doubt = await db.prisma.iaJudgeSuggestion.findFirstOrThrow({ where: { betId: s.bet.id } });
    await rejectIaJudgeSuggestion({ suggestionId: doubt.id, actor: "operator:fabricio" });

    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(citedWin(0.98));
    vi.mocked(resolveGroundingRedirectHost).mockResolvedValue("www.bbc.com");
    const later = new Date(base.getTime() + 25 * HOUR);
    expect(await runIaJudgeCycle(later, { includeStalled: true, autoSettle: true })).toMatchObject({ created: 1 });

    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("PENDING");
    const suggestions = await db.prisma.iaJudgeSuggestion.findMany({
      where: { betId: s.bet.id }, orderBy: { createdAt: "asc" },
    });
    expect(suggestions.map((item) => item.status)).toEqual(["REJECTED", "PENDING"]);
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: s.conta.id } })).saldoAtual)).toBe(1000);
  });

  it("sugestão descartada com a remoção da aposta não conta como recusa do dono", async () => {
    const s = await seed();
    // Como a remoção deixa a sugestão pendente: REJECTED pelo ator que removeu.
    await db.prisma.iaJudgeSuggestion.create({ data: {
      betId: s.bet.id, suggestedStatus: "WON", valueFound: "2-2", confidence: 0.9, reason: "dúvida",
      provider: "gemini", evidenceKind: "GROUNDED_WEB", status: "REJECTED", resolvedBy: "fabricio",
      resolvedAt: PAST, betUpdatedAt: s.bet.updatedAt,
    } });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(citedWin(0.98));

    expect(await runIaJudgeCycle(NOW, { includeStalled: true, autoSettle: true })).toMatchObject({ created: 1 });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: s.bet.id } })).status).toBe("WON");
  });
});

describe("ação operacional de aposta parada", () => {
  it("auto-liquidação resolve a ação settlement.parado mesmo com autoResolve: false", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Banca IA Judge", slug: "ia-judge-bank" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        evento: "Palmeiras vs Santos",
        esporte: "Futebol",
        competicao: "Paulista",
        pais: "Brasil",
        mercado: "Match Odds",
        selecao: "Palmeiras",
        odds: 1.85,
        stake: 1.0,
        status: "PENDING",
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        data: new Date(),
        registradoEm: new Date(),
      },
    });

    // Cria sugestão de IA Judge vinculada à versão atual da aposta
    const suggestion = await db.prisma.iaJudgeSuggestion.create({
      data: {
        betId: bet.id,
        suggestedStatus: "WON",
        evidenceKind: "GROUNDED_WEB",
        valueFound: "Palmeiras 2 x 1 Santos",
        confidence: 0.95,
        reason: "Palmeiras venceu por 2 a 1",
        provider: "gemini",
        status: "PENDING",
        betUpdatedAt: bet.updatedAt,
      },
    });

    // Reporta ação operacional de settlement parado com autoResolve: false
    await reportOperationalAction({
      source: "settlement.parado",
      key: bet.id,
      area: "settlement",
      actionType: "liquidacao_parada",
      title: "Liquidação parada",
      description: "Aposta aguardando liquidação",
      autoResolve: false,
    });

    const actionBefore = await db.prisma.operationalAction.findUnique({
      where: { fingerprint: operationalActionFingerprint("settlement.parado", bet.id) },
    });
    expect(actionBefore?.status).toBe("OPEN");

    const now = new Date();
    await autoSettleGroundedIaJudgeSuggestion({
      suggestionId: suggestion.id,
      current: {
        id: bet.id,
        bankrollNome: bankroll.nome,
        evento: bet.evento,
        esporte: bet.esporte,
        competicao: bet.competicao,
        mercado: bet.mercado,
        selecao: bet.selecao,
        odds: Number(bet.odds),
        stake: Number(bet.stake),
        data: bet.data,
        updatedAt: bet.updatedAt,
        combinedTicket: false,
        liveEntry: false,
        liveScoreAtEntry: null,
      },
      confidence: 0.95,
      valueFound: "Palmeiras 2 x 1 Santos",
      reason: "Resultado confirmado pela súmula oficial",
      sourceUrl: "https://globoesporte.globo.com/jogo/palmeiras-santos",
      now,
    });

    const actionAfter = await db.prisma.operationalAction.findUnique({
      where: { fingerprint: operationalActionFingerprint("settlement.parado", bet.id) },
    });
    expect(actionAfter?.status).toBe("RESOLVED");
    expect(actionAfter?.resolutionNote).toBe("Liquidada automaticamente via IA-Judge");
  });

  it("aprovar a sugestão resolve na mesma transação a ação settlement.parado", async () => {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "BR-IA-Judge", slug: "br-ia-judge" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        bankrollId: bankroll.id,
        data: new Date(),
        status: "PENDING",
        stake: 100,
        odds: 2.0,
        evento: "Flamengo vs Vasco",
        mercado: "Resultado Final",
        selecao: "Flamengo",
        esporte: "Futebol",
        sportResolutionStatus: "CONFIRMED",
        sportSource: "MANUAL",
        sportConfidence: 1.0,
        sportResolvedAt: new Date(),
      },
    });

    await reportOperationalAction({
      source: "settlement.parado",
      key: bet.id,
      area: "settlement",
      actionType: "resolucao_pendente",
      title: "Settlement parado",
      description: "Aposta aguardando liquidação",
    });

    const actionBefore = await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: operationalActionFingerprint("settlement.parado", bet.id) },
    });
    expect(actionBefore.status).toBe("OPEN");

    const suggestion = await db.prisma.iaJudgeSuggestion.create({
      data: {
        betId: bet.id,
        suggestedStatus: "WON",
        valueFound: "Flamengo 2x0",
        confidence: 0.98,
        reason: "Gols confirmados",
        provider: "gemini-2.5-flash",
        evidenceKind: "GROUNDED_WEB",
        sourceUrl: "https://globoesporte.globo.com/jogo-1",
        groundingSources: [{ title: "GE", url: "https://globoesporte.globo.com/jogo-1" }],
        betUpdatedAt: bet.updatedAt,
      },
    });

    const result = await approveIaJudgeSuggestion({
      suggestionId: suggestion.id,
      actor: "ia_judge_auto",
    });
    expect(result.status).toBe("WON");

    const actionAfter = await db.prisma.operationalAction.findFirstOrThrow({
      where: { fingerprint: operationalActionFingerprint("settlement.parado", bet.id) },
    });
    expect(actionAfter.status).toBe("RESOLVED");
  });
});
