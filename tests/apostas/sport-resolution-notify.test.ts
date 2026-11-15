import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), notify: vi.fn(async () => true), findNotice: vi.fn(async () => null as { id: string } | null), createNotice: vi.fn(),
}));
vi.mock("@/src/infra/prisma", () => ({ prisma: {
  bet: { findUnique: mocks.findUnique },
  auditEvent: { findFirst: mocks.findNotice, create: mocks.createNotice },
} }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperatorNotification: mocks.notify }));
const { avisarBuscaDeEsporteDesistiu, avisarConflitoDeEsporte, avisarEsportePendente } = await import("@/src/services/bets/sport-resolution/notify");

beforeEach(() => vi.clearAllMocks());

it("busca de esporte que desistiu aponta o jogo e a banca, não o id da aposta", async () => {
  mocks.findUnique.mockResolvedValue({ evento: "Flamengo vs Vasco", deletedAt: null, sportResolutionStatus: "PENDING", bankroll: { nome: "Tipster Alfa" } });
  await avisarBuscaDeEsporteDesistiu("bet-1");
  const [message] = mocks.notify.mock.calls[0] as unknown as [string];
  expect(message).toMatch(/^❓ Esporte não identificado · Flamengo vs Vasco \(tipster Tipster Alfa\)/);
  expect(message).not.toContain("bet-1");
  expect(message).toContain("👉 Confirme o esporte");
});

it("aposta que sumiu não pede confirmação de um recurso ausente", async () => {
  mocks.findUnique.mockResolvedValue(null);
  expect(await avisarBuscaDeEsporteDesistiu("bet-2")).toBe(false);
  expect(mocks.notify).not.toHaveBeenCalled();
});

it("fim das tentativas: o aviso diz quem discordou e não mostra o candidato desmentido", async () => {
  mocks.findUnique.mockResolvedValue({ evento: "Flamengo vs Corinthians", status: "PENDING", deletedAt: null, sportResolutionStatus: "PENDING" });
  await avisarEsportePendente({
    betId: "bet-3", status: "pending", candidate: null, reason: "candidate_dissent",
    candidates: [
      { sport: "Soccer", confidence: 100, source: "TEAM_ID", provider: "team_identity", strategy: "external_id_pair_contradicted" },
      { sport: "Basketball", confidence: 95, source: "WEB", provider: "web", country: "Brazil" },
      { sport: "Volleyball", confidence: 80, source: "TEAM_ID", provider: "team_identity", strategy: "exact_local_identity" },
    ],
    dissent: { sport: "Volleyball", confidence: 80, source: "TEAM_ID", provider: "team_identity", fromPost: false },
  });
  const [message] = mocks.notify.mock.calls[0] as unknown as [string];
  expect(message).toContain("A busca achou: Basketball · Brazil");
  expect(message).toContain("Certeza de 95%, mas a identidade dos times aponta Volleyball (80%).");
});

describe("conflito do resolvedor", () => {
  const conflict = {
    betId: "bet-4", status: "conflict" as const, candidate: null, reason: "post_dissent",
    candidates: [{ sport: "Basketball" as const, confidence: 95, source: "WEB" as const, provider: "web" as const, country: "Chile", competition: "LNB" }],
    dissent: { sport: "Soccer" as const, confidence: 85, source: "LLM", fromPost: true },
  };

  it("avisa na hora, com o que a busca achou e quem discorda, uma vez por aposta", async () => {
    mocks.findUnique.mockResolvedValue({ evento: "Leones vs Universidad", deletedAt: null, sportResolutionStatus: "CONFLICT" });
    expect(await avisarConflitoDeEsporte(conflict)).toBe(true);
    const [message] = mocks.notify.mock.calls[0] as unknown as [string];
    expect(message).toBe("⚠️ Esporte em conflito · Leones vs Universidad\n"
      + "A busca achou: Basketball · Chile · LNB\n"
      + "Mas a leitura da IA aponta Soccer (85%).\n"
      + "👉 Confirme o esporte na caixa de ações do painel.");
    expect(mocks.createNotice).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "bet.sport_conflict_notified", resource: "bet", resourceId: "bet-4",
    }) });

    vi.clearAllMocks();
    mocks.findNotice.mockResolvedValueOnce({ id: "aviso-1" });
    expect(await avisarConflitoDeEsporte(conflict)).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("a aposta que nasceu em conflito na captura é avisada pelo resolvedor quando a chegada não avisou", async () => {
    // Como o resolvedor grava: os candidatos dele e, em `capture`, a leitura da captura.
    // O lote, a DM e o conserto pela DM não falam do esporte na chegada.
    const sportEvidence = {
      candidates: conflict.candidates, selected: null, reason: "capture_conflict",
      capture: { status: "CONFLICT", signals: [{ source: "EMOJI", sport: "Soccer", confidence: 95, value: "⚽" }] },
    };
    mocks.findUnique.mockResolvedValue({ evento: "A vs B", deletedAt: null, sportResolutionStatus: "CONFLICT", sportEvidence });
    expect(await avisarConflitoDeEsporte({ ...conflict, reason: "capture_conflict", dissent: undefined })).toBe(true);
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining("⚠️ Esporte em conflito · A vs B"), { key: "sport-conflict:bet-4" });
    expect(mocks.createNotice).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "bet.sport_conflict_notified" }) });
  });
});

it.each([
  { deletedAt: new Date("2026-09-24T12:00:00Z"), sportResolutionStatus: "PENDING" },
  { deletedAt: null, sportResolutionStatus: "CONFIRMED" },
])("dead-letter antiga não avisa quando a aposta mudou: %j", async (state) => {
  mocks.findUnique.mockResolvedValue({ evento: "A vs B", bankroll: { nome: "Alfa" }, ...state });
  expect(await avisarBuscaDeEsporteDesistiu("bet-old")).toBe(false);
  expect(mocks.notify).not.toHaveBeenCalled();
});
