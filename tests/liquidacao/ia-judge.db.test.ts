import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  findIaJudgeCandidates,
  FAILURE_COOLDOWN_MS,
  QUOTA_COOLDOWN_MS,
  formatCooldownHours,
} from "@/src/services/settlement/ia-judge/candidates";
import { runIaJudgeCycle } from "@/src/services/settlement/ia-judge/cycle";
import {
  approveIaJudgeSuggestion,
  dismissOrphanedIaJudgeSuggestions,
  getPendingIaJudgeSuggestionsPage,
  rejectIaJudgeSuggestion,
} from "@/src/services/settlement/ia-judge/suggestions";
import {
  notifyPersistedOperationalAlert,
  sendOperationalAlert,
  sendOperatorNotification,
} from "@/src/services/ops/alerts";
import { llmGenerateJson } from "@/src/infra/llm/cascade";
import { geminiGenerateJsonWithSearch } from "@/src/infra/llm/gemini-search";
import type { BetStatus } from "@/src/generated/prisma/client";

vi.mock("@/src/infra/llm/cascade", () => ({ llmGenerateJson: vi.fn() }));
vi.mock("@/src/infra/llm/gemini-search", () => ({
  geminiGenerateJsonWithSearch: vi.fn(),
  resolveGroundingRedirectHost: vi.fn(),
}));

const enrich = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({}) }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ cancelPendingSharpEnrich: enrich.cancel }));

vi.mock("@/src/services/ops/alerts", () => ({
  notifyPersistedOperationalAlert: vi.fn(),
  sendOperationalAlert: vi.fn(),
  sendOperatorNotification: vi.fn(),
}));

let db: TestDb;

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

/** Kickoff há ~8h — dentro da janela 6h–7d do IA-Judge. */
const PAST = new Date("2026-01-01T12:00:00Z");
const FUTURE = new Date("2099-01-01T12:00:00Z");
const NOW = new Date("2026-01-01T20:00:00Z");

async function seed() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Banca E2E", slug: "banca-e2e", valorUnidade: 50 },
  });
  const conta = await db.prisma.conta.create({
    data: {
      casaDeAposta: "Bet365",
      titular: "Fabricio",
      saldoInicial: 1000,
      saldoAtual: 1000,
    },
  });

  let n = 0;
  const mk = (over: {
    mercado: string;
    selecao: string;
    data?: Date;
    status?: BetStatus;
  }) =>
    db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: (over.status ?? "PENDING") === "PENDING" ? null : (over.data ?? PAST),
        bankrollId: bankroll.id,
        contaId: conta.id,
        data: over.data ?? PAST,
        evento: `Evento ${(n += 1)}`,
        esporte: "Soccer",
        odds: 1.9,
        stake: 2,
        status: over.status ?? "PENDING",
        mercado: over.mercado,
        selecao: over.selecao,
      },
    });

  return {
    bankroll,
    conta,
    corners: await mk({ mercado: "Total de Escanteios", selecao: "Mais de 9.5" }),
    // BTTS resolve por placar — IA-Judge só pega props/stats.
    // Evitar "Total …": o filtro Prisma aproximado trata startsWith Total
    // como game-line; "Cartões" cai nas exclusões de stat.
    cards: await mk({ mercado: "Cartões", selecao: "Under 5.5" }),
    moneyline: await mk({ mercado: "Moneyline", selecao: "Time A" }),
    future: await mk({
      mercado: "Total de Escanteios",
      selecao: "Mais de 9.5",
      data: FUTURE,
    }),
    won: await mk({
      mercado: "Total de Escanteios",
      selecao: "Mais de 8.5",
      status: "WON",
    }),
    // Exposto para quem precisa de uma aposta a mais sem mudar a conta dos
    // casos que fixam o tamanho do lote.
    mk,
  };
}

describe("IA-Judge — candidatas", () => {
  it("seleciona só PENDING, janela de kickoff e mercado não-placar", async () => {
    const s = await seed();
    const ids = (await findIaJudgeCandidates(NOW)).map((c) => c.id);

    expect(ids).toContain(s.corners.id);
    expect(ids).toContain(s.cards.id);
    expect(ids).not.toContain(s.moneyline.id);
    expect(ids).not.toContain(s.future.id);
    expect(ids).not.toContain(s.won.id);
    expect(ids).toHaveLength(2);
  });

  /**
   * Estatística declarada só na SELEÇÃO precisa chegar aqui.
   *
   * O espelho SQL só olha `mercado`; o domínio olha `mercado` E `selecao`. Uma
   * aposta no meio dos dois ficaria sem ninguém: o liquidador por placar a
   * recusa em silêncio (`return false`) e um `NOT` em SQL a cortaria daqui
   * ANTES de a revalidação do domínio, logo abaixo, ter chance de resgatá-la.
   * Só o card de settlement manual, em kickoff+6h, chegaria nela.
   */
  it("resgata a aposta cujo mercado parece de placar e a seleção não é", async () => {
    const s = await seed();
    const limbo = await s.mk({ mercado: "Moneyline", selecao: "Time A 2+ cards" });

    const ids = (await findIaJudgeCandidates(NOW)).map((c) => c.id);

    expect(ids).toContain(limbo.id);
    // E o contra-peso: moneyline de verdade continua fora do juízo, senão o
    // resgate viraria um funil que engole o que o placar resolve sozinho.
    expect(ids).not.toContain(s.moneyline.id);
  });

  it("ignora tip com kickoffInferido (horário provisório)", async () => {
    const s = await seed();
    await db.prisma.bet.update({
      where: { id: s.corners.id },
      data: { kickoffInferido: true },
    });
    const ids = (await findIaJudgeCandidates(NOW)).map((c) => c.id);
    expect(ids).not.toContain(s.corners.id);
    expect(ids).toContain(s.cards.id);
  });

  it("ignora kickoff com mais de 7 dias", async () => {
    const s = await seed();
    const ancient = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: s.bankroll.id,
        contaId: s.conta.id,
        data: new Date("2025-12-01T12:00:00Z"),
        evento: "Evento antigo",
        esporte: "Soccer",
        odds: 1.9,
        stake: 2,
        status: "PENDING",
        mercado: "Total de Escanteios",
        selecao: "Mais de 9.5",
      },
    });
    const ids = (await findIaJudgeCandidates(NOW)).map((c) => c.id);
    expect(ids).not.toContain(ancient.id);
  });

  it("ignora tip que já tem sugestão PENDING", async () => {
    const s = await seed();
    await db.prisma.iaJudgeSuggestion.create({
      data: {
        betId: s.corners.id,
        suggestedStatus: "WON",
        evidenceKind: "GROUNDED_WEB",
        valueFound: "11",
        confidence: 0.9,
        reason: "Ganhou",
        provider: "gemini",
        status: "PENDING",
      },
    });

    const ids = (await findIaJudgeCandidates(NOW)).map((c) => c.id);
    expect(ids).not.toContain(s.corners.id);
    expect(ids).toContain(s.cards.id);
    expect(ids).toHaveLength(1);
  });

  it("respeita cooldown por tip", async () => {
    const s = await seed();
    await db.prisma.iaJudgeCooldown.create({
      data: {
        key: `bet:${s.corners.id}`,
        reason: "llm_unavailable",
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      },
    });
    const ids = (await findIaJudgeCandidates(NOW)).map((c) => c.id);
    expect(ids).not.toContain(s.corners.id);
    expect(ids).toContain(s.cards.id);
  });
});

describe("IA-Judge — ciclo", () => {
  it("estatísticas que a IA não resolve não tiram a vaga da aposta parada nem da recém-chegada", async () => {
    const s = await seed();
    await db.prisma.bet.deleteMany({ where: { id: { in: [s.corners.id, s.cards.id, s.moneyline.id] } } });
    // 40 estatísticas antigas, tentadas há 3h e de volta à fila: sozinhas enchem dois lotes.
    for (let index = 0; index < 40; index += 1) {
      const bet = await s.mk({ mercado: "Total de Escanteios", selecao: `Mais de ${index}.5`, data: new Date(PAST.getTime() - 86_400_000 + index * 1_000) });
      await db.prisma.betResult.create({ data: { betId: bet.id, resultProvider: "flashscore", resultFinal: true } });
      await db.prisma.iaJudgeCooldown.create({ data: {
        key: `bet:${bet.id}`, reason: "unresolved",
        expiresAt: new Date(NOW.getTime() - 60_000), updatedAt: new Date(NOW.getTime() - 3 * 3_600_000),
      } });
    }
    const recemChegada = await s.mk({ mercado: "Total de Escanteios", selecao: "Mais de 8.5" });
    await db.prisma.betResult.create({ data: { betId: recemChegada.id, resultProvider: "flashscore", resultFinal: true } });
    // Moneyline que o FlashScore não casou: só o grupo das paradas a alcança.
    const parada = await s.mk({ mercado: "Moneyline", selecao: "Time A" });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: { resolved: false, valueFound: "", confidence: 0.2, reason: "sem dado" },
      provider: "gemini",
      sources: [],
    });

    await runIaJudgeCycle(NOW, { includeStalled: true });

    const julgadas = vi.mocked(geminiGenerateJsonWithSearch).mock.calls.map(([params]) => params.query);
    expect(julgadas).toHaveLength(20);
    for (const bet of [recemChegada, parada]) {
      expect(julgadas.some((query) => query.includes(`"evento":"${bet.evento}"`))).toBe(true);
    }
  });

  it("revalida a janela no reload quando enrich move o próximo kickoff", async () => {
    const s = await seed();
    await db.prisma.bet.update({
      where: { id: s.corners.id },
      data: { data: new Date(PAST.getTime() - 3_600_000) },
    });
    vi.mocked(geminiGenerateJsonWithSearch).mockImplementation(async () => {
      // `corners` é a primeira candidata. Enquanto ela é avaliada, simula o
      // enrich corrigindo o kickoff de `cards`, já descoberto no mesmo lote.
      await db.prisma.bet.update({
        where: { id: s.cards.id },
        data: { data: FUTURE },
      });
      return {
        data: {
          resolved: true,
          valueFound: "11",
          suggestedOutcome: "WON",
          confidence: 0.95,
          reason: "resultado confirmado",
          sourceUrl: "",
        },
        provider: "gemini",
        sources: [],
      };
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    const result = await runIaJudgeCycle(NOW);
    expect(result).toMatchObject({ candidates: 2, created: 1, skipped: 1, failed: 0 });
    expect(geminiGenerateJsonWithSearch).toHaveBeenCalledTimes(1);
    expect(await db.prisma.iaJudgeSuggestion.count({ where: { betId: s.cards.id } })).toBe(0);
  });

  it("rodada abortada no prazo não avalia candidata nova; elas ficam para o ciclo seguinte", async () => {
    await seed();

    const result = await runIaJudgeCycle(NOW, { signal: AbortSignal.abort() });

    expect(result).toMatchObject({ candidates: 2, created: 0, skipped: 0, failed: 0 });
    expect(geminiGenerateJsonWithSearch).not.toHaveBeenCalled();
    expect(await db.prisma.iaJudgeSuggestion.count()).toBe(0);
  });

  it("persiste sugestão e alerta quando confiança ≥ 0.8", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: true,
        valueFound: "11",
        suggestedOutcome: "WON",
        confidence: 0.95,
        reason: "Jogo teve 11 escanteios",
        sourceUrl: "https://example.com/stats",
      },
      provider: "gemini",
      sources: [],
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    const result = await runIaJudgeCycle(NOW);
    expect(result.candidates).toBe(2);
    expect(result.created).toBe(2);

    const suggestion = await db.prisma.iaJudgeSuggestion.findFirst({
      where: { betId: s.corners.id },
    });
    expect(suggestion).not.toBeNull();
    expect(suggestion?.suggestedStatus).toBe("WON");
    expect(suggestion?.status).toBe("PENDING");
    expect(suggestion?.confidence).toBe(0.95);
    expect(sendOperatorNotification).toHaveBeenCalled();
  });

  it("com stats FlashScore resolve Bookings/cantos sem LLM", async () => {
    const s = await seed();
    await db.prisma.bet.update({
      where: { id: s.corners.id },
      data: { mercado: "Total de Escanteios 9.5", selecao: "Over" },
    });
    await db.prisma.betResult.create({
      data: {
        betId: s.corners.id,
        resultProvider: "flashscore",
        resultFinal: true,
        resultSnapshot: {
          outcome: "matched",
          finished: true,
          stats: { corners: { home: 6, away: 5 } },
        },
      },
    });
    vi.mocked(llmGenerateJson).mockResolvedValue({
      data: {
        resolved: true,
        valueFound: "should-not-use",
        suggestedOutcome: "LOST",
        confidence: 0.99,
        reason: "não deveria ser chamado",
        sourceUrl: "",
      },
      provider: "groq",
    });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: true,
        valueFound: "from-search",
        suggestedOutcome: "LOST",
        confidence: 0.99,
        reason: "não deveria ser chamado para corners com FS",
      },
      provider: "gemini",
      sources: [],
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    const result = await runIaJudgeCycle(NOW);
    expect(result.created).toBeGreaterThanOrEqual(1);
    // Corners com stats FS: determinístico (sem LLM). Cards sem snapshot ainda
    // pode cair no Search — por isso não assertamos "search zero calls".
    expect(llmGenerateJson).not.toHaveBeenCalled();
    const cornersSuggestion = await db.prisma.iaJudgeSuggestion.findFirst({
      where: { betId: s.corners.id },
    });
    expect(cornersSuggestion?.provider).toBe("flashscore-stats");
    expect(cornersSuggestion?.confidence).toBe(1);
    expect(cornersSuggestion?.valueFound).toContain("corners");
  });

  /**
   * Indisponibilidade de provider não é decisão humana. Uma tip com
   * `llm_unavailable` numa ação `autoResolve: false` ficaria aberta por dias,
   * mesmo depois de o FAILURE_COOLDOWN_MS resolver o problema, na caixa do
   * operador. Caixa com item morto é caixa que se aprende a ignorar.
   */
  it("ciclo com falha só transitória alerta com autoResolve, e a real sem", async () => {
    await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(null);

    const transitorio = await runIaJudgeCycle(NOW);
    expect(transitorio.failed).toBeGreaterThan(0);
    expect(vi.mocked(sendOperationalAlert)).toHaveBeenCalledWith(
      expect.stringContaining("a IA estava fora do ar"),
      expect.objectContaining({ source: "settlement.ia-judge", autoResolve: true }),
    );
    expect(
      await db.prisma.iaJudgeCooldown.findFirst({ where: { reason: "llm_unavailable" } }),
    ).not.toBeNull();

    // Falha de CONTRATO (schema recusado) continua exigindo decisão humana.
    vi.mocked(sendOperationalAlert).mockClear();
    await db.prisma.iaJudgeCooldown.deleteMany({});
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: { resolved: "nao é booleano" },
      provider: "gemini",
      sources: [],
    } as never);

    await runIaJudgeCycle(NOW);
    expect(vi.mocked(sendOperationalAlert)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ autoResolve: false }),
    );
  });

  it("ciclo sem falha fecha a ação transitória do judge", async () => {
    const { reportOperationalAction } = await import("@/src/services/ops/operational-actions");
    const aberta = await reportOperationalAction({
      source: "settlement.ia-judge",
      key: "cycle-failure",
      area: "incidentes",
      actionType: "incident.review",
      title: "Falhas no ciclo do IA-Judge",
      description: "transitório",
      autoResolve: true,
    });
    await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: false,
        valueFound: "",
        suggestedOutcome: "VOID",
        confidence: 0.2,
        reason: "sem dado",
      },
      provider: "gemini",
      sources: [],
    });

    const result = await runIaJudgeCycle(NOW);
    expect(result.failed).toBe(0);
    await expect(db.prisma.operationalAction.findUniqueOrThrow({ where: { id: aberta.id } }))
      .resolves.toMatchObject({ status: "RESOLVED" });
  });

  it("não persiste quando resolved=false ou confiança baixa", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: false,
        valueFound: "",
        suggestedOutcome: "VOID",
        confidence: 0.2,
        reason: "Não achei dados",
      },
      provider: "gemini",
      sources: [],
    });

    const result = await runIaJudgeCycle(NOW);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(await db.prisma.iaJudgeSuggestion.count()).toBe(0);
    const cooldown = await db.prisma.iaJudgeCooldown.findUniqueOrThrow({
      where: { key: `bet:${s.corners.id}` },
    });
    expect(cooldown.reason).toBe("unresolved");
    expect(cooldown.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(cooldown.expiresAt.getTime()).toBeLessThan(NOW.getTime() + 4 * 3_600_000);
  });

  it("resolved=false de jogo de 5 dias espera 24h, não as 3h do primeiro dia", async () => {
    const s = await seed();
    const cincoDiasAtras = new Date(NOW.getTime() - 5 * 24 * 3_600_000);
    await db.prisma.bet.update({ where: { id: s.corners.id }, data: { data: cincoDiasAtras } });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: { resolved: false, valueFound: "", suggestedOutcome: "VOID", confidence: 0.2, reason: "Não achei dados" },
      provider: "gemini",
      sources: [],
    });

    await runIaJudgeCycle(NOW);

    const antiga = await db.prisma.iaJudgeCooldown.findUniqueOrThrow({ where: { key: `bet:${s.corners.id}` } });
    expect(antiga.reason).toBe("unresolved");
    expect(antiga.expiresAt.getTime() - NOW.getTime()).toBe(24 * 3_600_000);
    const recente = await db.prisma.iaJudgeCooldown.findUniqueOrThrow({ where: { key: `bet:${s.cards.id}` } });
    expect(recente.expiresAt.getTime() - NOW.getTime()).toBe(3 * 3_600_000);
  });

  it("confiança alta com resolved=false não é skip de 24h", async () => {
    const s = await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue({
      data: {
        resolved: false,
        valueFound: "11-8",
        suggestedOutcome: "WON",
        confidence: 0.9,
        reason: "achei o par mas não liquido sozinho",
      },
      provider: "gemini",
      sources: [],
    });

    const result = await runIaJudgeCycle(NOW);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    const cooldown = await db.prisma.iaJudgeCooldown.findUniqueOrThrow({
      where: { key: `bet:${s.corners.id}` },
    });
    expect(cooldown.reason).toBe("unresolved");
    expect(cooldown.expiresAt.getTime() - NOW.getTime()).toBeLessThan(4 * 3_600_000);
  });

  it("evidência do FlashScore: a cascata só aceita resposta que o schema do juiz aceita", async () => {
    const s = await seed();
    await db.prisma.betResult.create({ data: {
      betId: s.corners.id, resultProvider: "flashscore", resultFinal: true,
      resultSnapshot: { outcome: "matched", finished: true, score: { home: 1, away: 0 } },
    } });
    vi.mocked(llmGenerateJson).mockResolvedValue({
      data: { resolved: false, valueFound: "", suggestedOutcome: null, confidence: 0.2, reason: "sem escanteios", sourceUrl: null },
      provider: "groq",
    });
    vi.mocked(geminiGenerateJsonWithSearch).mockResolvedValue(null);

    await runIaJudgeCycle(NOW);

    const params = vi.mocked(llmGenerateJson).mock.calls[0]?.[0];
    expect(params?.accept?.({ resolved: "talvez" })).toBe(false);
    expect(params?.accept?.({ resolved: true, valueFound: "6-5", suggestedOutcome: "won", confidence: 0.97, reason: "11" })).toBe(true);
    // resolved=false sem resultado é "sem base", não contrato quebrado: esfria só 3h.
    const cooldown = await db.prisma.iaJudgeCooldown.findUniqueOrThrow({ where: { key: `bet:${s.corners.id}` } });
    expect(cooldown.reason).toBe("unresolved");
  });

  it("aceita confiança 85% e reason não-string no schema do juiz", async () => {
    const { responseSchema } = await import("@/src/services/settlement/ia-judge/prompt");
    const parsed = responseSchema.safeParse({
      resolved: true,
      valueFound: 11,
      suggestedOutcome: "WON",
      confidence: "85%",
      reason: { text: "escanteios 6-5" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.confidence).toBe(0.85);
      expect(parsed.data.valueFound).toBe("11");
      expect(parsed.data.reason).toContain("escanteios");
    }
  });

  it("descarta a resposta se a aposta mudar durante a pesquisa", async () => {
    await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockImplementation(async () => {
      await db.prisma.bet.updateMany({
        where: { status: "PENDING" },
        data: { competicao: "Competição corrigida durante a pesquisa" },
      });
      return {
        data: {
          resolved: true,
          valueFound: "11",
          suggestedOutcome: "WON",
          confidence: 0.95,
          reason: "Resultado encontrado",
          sourceUrl: "https://example.com/stats",
        },
        provider: "gemini",
        sources: [],
      };
    });

    const result = await runIaJudgeCycle(NOW);

    expect(result).toMatchObject({ candidates: 2, created: 0, skipped: 2, failed: 0 });
    expect(await db.prisma.iaJudgeSuggestion.count()).toBe(0);
    expect(sendOperatorNotification).not.toHaveBeenCalled();
  });

  it("alerta quando o ciclo tem falhas", async () => {
    await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockRejectedValue(new Error("boom"));
    vi.mocked(sendOperationalAlert).mockResolvedValue(true);

    const result = await runIaJudgeCycle(NOW);
    expect(result.failed).toBe(2);
    expect(sendOperationalAlert).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`2 de \\d+ apostas falharam[\\s\\S]*de novo em ${formatCooldownHours(FAILURE_COOLDOWN_MS)}`),
      ),
      expect.objectContaining({ source: "settlement.ia-judge" }),
    );
  });

  it("propaga falha ao persistir o incidente do ciclo", async () => {
    await seed();
    vi.mocked(geminiGenerateJsonWithSearch).mockRejectedValue(new Error("boom"));
    vi.mocked(sendOperationalAlert).mockRejectedValue(new Error("incidente indisponível"));

    await expect(runIaJudgeCycle(NOW)).rejects.toThrow("incidente indisponível");
  });

  it("alerta e sai cedo quando há cooldown de quota", async () => {
    await seed();
    await db.prisma.iaJudgeCooldown.create({
      data: {
        key: "quota:global",
        reason: "429 RESOURCE_EXHAUSTED",
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      },
    });
    vi.mocked(sendOperatorNotification).mockResolvedValue(true);

    const result = await runIaJudgeCycle(NOW);
    expect(result).toEqual({ candidates: 0, created: 0, skipped: 0, failed: 0 });
    expect(geminiGenerateJsonWithSearch).not.toHaveBeenCalled();
    expect(sendOperatorNotification).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`cota do Gemini acabou[\\s\\S]*cerca de ${formatCooldownHours(QUOTA_COOLDOWN_MS)}`),
      ),
    );
  });
});

describe("IA-Judge — homologação", () => {
  it("a fila de homologação vem pelo jogo mais antigo, não pela sugestão mais antiga", async () => {
    const s = await seed();
    const tarde = await s.mk({ mercado: "Cartões", selecao: "Over 4.5", data: new Date("2025-12-30T21:00:00Z") });
    const cedo = await s.mk({ mercado: "Cartões", selecao: "Over 3.5", data: new Date("2025-12-28T12:00:00Z") });
    // A sugestão do jogo mais tarde nasce antes.
    for (const bet of [tarde, cedo]) {
      await db.prisma.iaJudgeSuggestion.create({ data: {
        betId: bet.id, suggestedStatus: "WON", evidenceKind: "GROUNDED_WEB", valueFound: "5",
        confidence: 0.9, reason: "Ganhou", provider: "gemini", status: "PENDING",
      } });
    }
    const { items } = await getPendingIaJudgeSuggestionsPage();
    expect(items.map((i) => i.betId)).toEqual([cedo.id, tarde.id]);
  });

  it("descarta PENDING de apostas soft-deletadas", async () => {
    const s = await seed();
    const suggestion = await db.prisma.iaJudgeSuggestion.create({
      data: {
        betId: s.corners.id,
        suggestedStatus: "LOST",
        evidenceKind: "GROUNDED_WEB",
        valueFound: "8",
        confidence: 0.9,
        reason: "Perdeu",
        provider: "gemini",
        status: "PENDING",
      },
    });

    await db.prisma.bet.update({
      where: { id: s.corners.id },
      data: { deletedAt: new Date(), status: "CANCELED", settledAt: new Date() },
    });

    expect(await dismissOrphanedIaJudgeSuggestions()).toBe(1);
    const updated = await db.prisma.iaJudgeSuggestion.findUniqueOrThrow({
      where: { id: suggestion.id },
    });
    expect(updated.status).toBe("REJECTED");
    expect(updated.resolvedBy).toBe("system");
  });

  it("approve liquida a tip e marca APPROVED na mesma operação", async () => {
    const s = await seed();
    const suggestion = await db.prisma.iaJudgeSuggestion.create({
      data: {
        betId: s.corners.id,
        suggestedStatus: "WON",
        evidenceKind: "GROUNDED_WEB",
        valueFound: "11",
        confidence: 0.9,
        reason: "Ganhou",
        provider: "gemini",
        status: "PENDING",
        betUpdatedAt: s.corners.updatedAt,
      },
    });

    const r = await approveIaJudgeSuggestion({
      suggestionId: suggestion.id,
      actor: "operator:fabricio",
    });
    expect(r.status).toBe("WON");

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: s.corners.id } });
    expect(bet.status).toBe("WON");
    expect(bet.settledAt).not.toBeNull();

    const sug = await db.prisma.iaJudgeSuggestion.findUniqueOrThrow({
      where: { id: suggestion.id },
    });
    expect(sug.status).toBe("APPROVED");
    expect(sug.resolvedBy).toBe("operator:fabricio");
    // Liquidada, a aposta não precisa mais do enrich que estava na fila.
    expect(enrich.cancel).toHaveBeenCalledWith(expect.anything(), s.corners.id, "settled");
  });

  /**
   * O approve liquida DENTRO da própria transação, chamando
   * `applyBetStatusChangeTx` direto, e simplesmente descartava
   * `semContaElegivel`. Resultado: aprovar sugestão de uma aposta cuja conta não
   * está unicamente vinculada mudava o status, NÃO mexia no saldo e não avisava
   * ninguém — divergência financeira em silêncio. O wrapper
   * `applyBetStatusChange` sempre avisou; este caminho, não.
   */
  it("avisa quando a homologação liquida sem movimentar a conta", async () => {
    const s = await seed();
    // Banca que exige vínculo + DUAS contas da mesma casa sem vínculo nenhum:
    // ambíguo, então nenhuma é elegível e o ledger não pode seguir.
    await db.prisma.bankroll.update({
      where: { id: s.bankroll.id },
      data: { vincularContas: true },
    });
    await db.prisma.conta.create({
      data: {
        casaDeAposta: "Bet365",
        titular: "Segundo Titular",
        saldoInicial: 500,
        saldoAtual: 500,
      },
    });
    const aposta = await db.prisma.bet.create({
      data: {
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: s.bankroll.id,
        contaId: null,
        casaDeAposta: "Bet365",
        data: PAST,
        evento: "Evento sem conta elegível",
        esporte: "Soccer",
        odds: 1.9,
        stake: 2,
        status: "PENDING",
        mercado: "Total de Escanteios",
        selecao: "Mais de 9.5",
        sportResolutionStatus: "CONFIRMED",
      },
    });
    const suggestion = await db.prisma.iaJudgeSuggestion.create({
      data: {
        betId: aposta.id,
        suggestedStatus: "WON",
        evidenceKind: "GROUNDED_WEB",
        valueFound: "11",
        confidence: 0.9,
        reason: "Ganhou",
        provider: "gemini",
        status: "PENDING",
        betUpdatedAt: aposta.updatedAt,
      },
    });

    const r = await approveIaJudgeSuggestion({
      suggestionId: suggestion.id,
      actor: "operator:fabricio",
    });

    expect(r.status).toBe("WON");
    // A aposta liquida — não travar é decisão do dono —, mas o silêncio é que
    // não pode existir.
    expect(notifyPersistedOperationalAlert).toHaveBeenCalledWith(
      expect.stringContaining("sem mexer no saldo da conta"),
      expect.objectContaining({
        source: "bets.settle-sem-conta",
        key: aposta.id,
        autoResolve: false,
      }),
    );
    const movimentacoes = await db.prisma.movimentacao.count({
      where: { betId: aposta.id },
    });
    expect(movimentacoes).toBe(0);
    expect(await db.prisma.operationalAction.count({
      where: { resource: "bet", resourceId: aposta.id, status: "OPEN" },
    })).toBe(1);
  });

  it("recusa homologar sugestão criada contra uma versão antiga da aposta", async () => {
    const s = await seed();
    const version = (await db.prisma.bet.findUniqueOrThrow({
      where: { id: s.corners.id },
      select: { updatedAt: true },
    })).updatedAt;
    const suggestion = await db.prisma.iaJudgeSuggestion.create({
      data: {
        betId: s.corners.id,
        suggestedStatus: "WON",
        evidenceKind: "GROUNDED_WEB",
        valueFound: "11",
        confidence: 0.9,
        reason: "Ganhou",
        provider: "gemini",
        status: "PENDING",
        betUpdatedAt: version,
      },
    });
    await db.prisma.bet.update({
      where: { id: s.corners.id },
      data: { evento: "Evento corrigido" },
    });

    await expect(approveIaJudgeSuggestion({
      suggestionId: suggestion.id,
      actor: "operator:fabricio",
    })).rejects.toThrow(/desatualizada/i);
    const current = await db.prisma.bet.findUniqueOrThrow({ where: { id: s.corners.id } });
    expect(current.status).toBe("PENDING");
  });

  it("reject mantém tip PENDING", async () => {
    const s = await seed();
    const suggestion = await db.prisma.iaJudgeSuggestion.create({
      data: {
        betId: s.corners.id,
        suggestedStatus: "WON",
        evidenceKind: "GROUNDED_WEB",
        valueFound: "11",
        confidence: 0.9,
        reason: "Ganhou",
        provider: "gemini",
        status: "PENDING",
      },
    });

    await rejectIaJudgeSuggestion({
      suggestionId: suggestion.id,
      actor: "operator:fabricio",
    });

    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: s.corners.id } });
    expect(bet.status).toBe("PENDING");

    const sug = await db.prisma.iaJudgeSuggestion.findUniqueOrThrow({
      where: { id: suggestion.id },
    });
    expect(sug.status).toBe("REJECTED");
    const cooldown = await db.prisma.iaJudgeCooldown.findUniqueOrThrow({
      where: { key: `bet:${s.corners.id}` },
    });
    expect(cooldown.reason).toBe("manual_rejection");
    expect(cooldown.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
