import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { applyDelegatedSettlementPlan, buildDelegatedSettlementPlan } from "@/src/services/bets/delegated-settlement";
import { applyManualBetStatusChange } from "../helpers/settle";
import { getTrilhaDaAposta } from "@/src/services/painel/aposta/trilha";
import { purgeOldAuditEvents } from "@/src/services/ops/audit-purge";

vi.mock("@/src/services/bets/settle-effects", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/services/bets/settle-effects")>(),
  finishBetStatusChange: vi.fn(),
}));
let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

const EVIDENCIA = "Placar oficial 2x1 conferido no FlashScore.";

async function seed(n = 1) {
  await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Delegada sintética", slug: "delegada", valorUnidade: 50 } });
  const conta = await db.prisma.conta.create({ data: { titular: "Sintético", casaDeAposta: "Betano", saldoInicial: 500, saldoAtual: 500 } });
  const bets = [];
  for (let i = 0; i < n; i++) {
    bets.push(await db.prisma.bet.create({ data: { bankrollId: bankroll.id, contaId: conta.id, casaDeAposta: "Betano", evento: `Time ${i} vs Outro`, esporte: "Soccer",
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), mercado: "Money Line – Match", selecao: `Time ${i}`, odds: 2, stake: 1, valorUnidade: 50,
      data: new Date("2026-09-01T12:00:00Z") } }));
  }
  return { conta, bets };
}
const pedido = (betIds: string[], extra: Record<string, unknown> = {}) => ({
  agent: "antigravity", approvedBy: "operador", ...extra,
  items: betIds.map((betId) => ({ betId, newStatus: "WON", evidence: EVIDENCIA })),
});
async function planoOk(betIds: string[]) {
  const result = await buildDelegatedSettlementPlan(pedido(betIds), new Date("2026-09-15T12:00:00Z"));
  if (!result.ok) throw new Error(JSON.stringify(result.refusals));
  return result.plan;
}

describe("liquidação delegada (Postgres real)", () => {
  it("plano não grava nada e mostra o lucro previsto", async () => {
    const { bets } = await seed();
    const plan = await planoOk([bets[0]!.id]);
    expect(plan.items[0]).toMatchObject({ bankrollSlug: "delegada", expectedVersion: 1, preview: { lucroPrevisto: 1 } });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bets[0]!.id } })).status).toBe("PENDING");
    expect(await db.prisma.settlementEvent.count()).toBe(0);
    expect(await db.prisma.auditEvent.count()).toBe(0);
  });

  it("recusa o lote inteiro quando uma aposta não pode ser liquidada", async () => {
    const { bets } = await seed(3);
    await applyManualBetStatusChange({ betId: bets[1]!.id, newStatus: "LOST", source: "manual:operador" });
    await db.prisma.bet.update({ where: { id: bets[2]!.id }, data: { deletedAt: new Date() } });
    const result = await buildDelegatedSettlementPlan(pedido(bets.map((b) => b.id)), new Date("2026-09-15T12:00:00Z"));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusals.map((r) => r.betId).sort()).toEqual([bets[1]!.id, bets[2]!.id].sort());
  });

  it("recusa evento futuro e aprovador que não é usuário do painel", async () => {
    const { bets } = await seed();
    const futuro = await buildDelegatedSettlementPlan(pedido([bets[0]!.id]), new Date("2026-08-01T12:00:00Z"));
    expect(futuro.ok).toBe(false);
    await expect(buildDelegatedSettlementPlan(pedido([bets[0]!.id], { approvedBy: "fantasma" }))).rejects.toThrow(/não é usuário do painel/);
  });

  it("sem sugestão do IA-Judge aberta, só liquida o jogo começado há 3 h", async () => {
    const { bets } = await seed(2);
    const [semSugestao, comSugestao] = bets as [typeof bets[number], typeof bets[number]];
    const duasHorasDepois = new Date("2026-09-01T14:00:00Z");
    await db.prisma.iaJudgeSuggestion.create({ data: {
      betId: comSugestao.id, suggestedStatus: "WON", valueFound: "2-1", confidence: 0.9, reason: "busca",
      provider: "gemini", evidenceKind: "GROUNDED_WEB", status: "PENDING", betUpdatedAt: comSugestao.updatedAt,
    } });

    const cedo = await buildDelegatedSettlementPlan(pedido(bets.map((b) => b.id)), duasHorasDepois);
    expect(cedo).toMatchObject({ ok: false, refusals: [{ betId: semSugestao.id, reason: expect.stringMatching(/menos de 3 h/) }] });
    expect(await buildDelegatedSettlementPlan(pedido(bets.map((b) => b.id)), new Date("2026-09-01T15:00:00Z")))
      .toMatchObject({ ok: true });

    // Horário provisório: nem depois das 3 h, sem sugestão.
    await db.prisma.bet.update({ where: { id: semSugestao.id }, data: { kickoffInferido: true } });
    expect(await buildDelegatedSettlementPlan(pedido([semSugestao.id]), new Date("2026-09-03T12:00:00Z")))
      .toMatchObject({ ok: false, refusals: [{ reason: expect.stringMatching(/provisório/) }] });
  });

  it("sugestão de perda não autoriza pedido de ganho antes das 3 h", async () => {
    const { bets } = await seed();
    const bet = bets[0]!;
    await db.prisma.iaJudgeSuggestion.create({ data: {
      betId: bet.id, suggestedStatus: "LOST", valueFound: "0-1", confidence: 0.9, reason: "resultado comprovado",
      provider: "gemini", evidenceKind: "GROUNDED_WEB", status: "PENDING", betUpdatedAt: bet.updatedAt,
    } });
    expect(await buildDelegatedSettlementPlan(pedido([bet.id]), new Date("2026-09-01T14:00:00Z")))
      .toMatchObject({ ok: false, refusals: [{ reason: expect.stringMatching(/menos de 3 h/) }] });
  });

  it("bilhete de ontem com perna ainda em andamento exige sugestão do mesmo resultado", async () => {
    const { bets } = await seed();
    const bet = await db.prisma.bet.update({ where: { id: bets[0]!.id }, data: {
      evento: "Time 0 vs Outro | Santos vs Grêmio", mercado: "Parlay", selecao: "Time 0 + Santos",
      legsJson: { version: 1, legs: [
        { evento: "Time 0 vs Outro", mercado: "Moneyline", selecao: "Time 0" },
        { evento: "Santos vs Grêmio", mercado: "Moneyline", selecao: "Santos" },
      ] },
    } });
    expect(await buildDelegatedSettlementPlan(pedido([bet.id]), new Date("2026-09-02T14:00:00Z")))
      .toMatchObject({ ok: false, refusals: [{ reason: expect.stringMatching(/múltipla/) }] });
  });

  it("sugestão retirada após o plano não permite aplicar antes das 3 h", async () => {
    const { bets } = await seed();
    const kickoff = new Date(Date.now() - 2 * 3_600_000);
    const bet = await db.prisma.bet.update({ where: { id: bets[0]!.id }, data: { data: kickoff } });
    const suggestion = await db.prisma.iaJudgeSuggestion.create({ data: {
      betId: bet.id, suggestedStatus: "WON", valueFound: "2-1", confidence: 0.9, reason: "resultado comprovado",
      provider: "gemini", evidenceKind: "GROUNDED_WEB", status: "PENDING", betUpdatedAt: bet.updatedAt,
    } });
    const planned = await buildDelegatedSettlementPlan(pedido([bet.id]));
    if (!planned.ok) throw new Error(JSON.stringify(planned.refusals));
    await db.prisma.iaJudgeSuggestion.update({ where: { id: suggestion.id }, data: { status: "REJECTED" } });
    expect(await applyDelegatedSettlementPlan(planned.plan, planned.plan.planHash))
      .toMatchObject([{ kind: "refused", message: expect.stringMatching(/menos de 3 h/) }]);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
    expect(await db.prisma.manualSettlementReceipt.count()).toBe(0);
    expect(await db.prisma.movimentacao.count()).toBe(0);
  });

  it("ops-settle homologa a sugestão aberta com o mesmo resultado e permite repetir o plano", async () => {
    const { bets, conta } = await seed();
    const bet = bets[0]!;
    const suggestion = await db.prisma.iaJudgeSuggestion.create({ data: {
      betId: bet.id, suggestedStatus: "WON", valueFound: "2-1", confidence: 0.9, reason: "resultado comprovado",
      provider: "gemini", evidenceKind: "GROUNDED_WEB", status: "PENDING", betUpdatedAt: bet.updatedAt,
    } });
    const plan = await planoOk([bet.id]);
    expect(await applyDelegatedSettlementPlan(plan, plan.planHash)).toMatchObject([{ kind: "saved", duplicate: false }]);
    expect(await db.prisma.iaJudgeSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } }))
      .toMatchObject({ status: "APPROVED", resolvedBy: "agent:antigravity:por:operador" });
    expect(await applyDelegatedSettlementPlan(plan, plan.planHash)).toMatchObject([{ kind: "saved", duplicate: true }]);
    expect(await db.prisma.settlementEvent.count()).toBe(1);
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(550);
  });

  it("antecipa recusas do settlement: esporte não confirmado e HALF em mercado inteiro", async () => {
    const { bets } = await seed(2);
    await db.prisma.bet.update({ where: { id: bets[0]!.id }, data: { esporte: "Unknown", sportResolutionStatus: "PENDING", sportResolvedAt: null } });
    const result = await buildDelegatedSettlementPlan({ agent: "antigravity", approvedBy: "operador", items: [
      { betId: bets[0]!.id, newStatus: "WON", evidence: EVIDENCIA },
      { betId: bets[1]!.id, newStatus: "HALF_WON", evidence: EVIDENCIA },
    ] }, new Date("2026-09-15T12:00:00Z"));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusals.map((r) => r.reason)).toEqual(["esporte da aposta não confirmado", "mercado não admite HALF_WON"]);
  });

  it("aplica pelo caminho do painel: recibo, fonte manual e trilha do agente na mesma gravação", async () => {
    const { bets, conta } = await seed();
    const plan = await planoOk([bets[0]!.id]);
    expect(await applyDelegatedSettlementPlan(plan, plan.planHash)).toEqual([{ betId: bets[0]!.id, kind: "saved", lucro: 1, duplicate: false }]);
    const event = await db.prisma.settlementEvent.findFirstOrThrow();
    expect(event.payload).toMatchObject({ source: "manual:operador", from: "PENDING", to: "WON" });
    expect(await db.prisma.manualSettlementReceipt.count()).toBe(1);
    const audit = await db.prisma.auditEvent.findFirstOrThrow({ where: { action: "bet.settle_delegated" } });
    expect(audit).toMatchObject({ actor: "agent:antigravity:por:operador", resourceId: bets[0]!.id });
    expect(audit.details).toMatchObject({ agent: "antigravity", approvedBy: "operador", planHash: plan.planHash, evidence: EVIDENCIA, from: "PENDING", to: "WON", lucro: 1 });
    const trail = await getTrilhaDaAposta(bets[0]!.id);
    expect(trail.linhas.some((line) => line.id === audit.id && line.chave === "liquidacao_delegada")).toBe(true);
    expect(trail.linhas.flatMap((line) => line.frase).map((part) => part.texto).join("")).toContain("antigravity");
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(550);
    const now = new Date();
    await db.prisma.auditEvent.update({ where: { id: audit.id }, data: { createdAt: new Date(now.getTime() - 31 * 86_400_000) } });
    await purgeOldAuditEvents(now);
    expect(await db.prisma.auditEvent.count({ where: { id: audit.id } })).toBe(1);
  });

  it("reaplicar o mesmo plano não liquida de novo nem duplica a trilha", async () => {
    const { bets, conta } = await seed();
    const plan = await planoOk([bets[0]!.id]);
    await applyDelegatedSettlementPlan(plan, plan.planHash);
    expect(await applyDelegatedSettlementPlan(plan, plan.planHash)).toEqual([{ betId: bets[0]!.id, kind: "saved", lucro: 1, duplicate: true }]);
    expect(await db.prisma.settlementEvent.count()).toBe(1);
    expect(await db.prisma.auditEvent.count({ where: { action: "bet.settle_delegated" } })).toBe(1);
    expect(Number((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(550);
  });

  it("aposta alterada depois do plano vira conflito, sem sobrescrever", async () => {
    const { bets } = await seed(2);
    const plan = await planoOk(bets.map((b) => b.id));
    await applyManualBetStatusChange({ betId: bets[0]!.id, newStatus: "LOST", source: "manual:operador" });
    const results = await applyDelegatedSettlementPlan(plan, plan.planHash);
    expect(results[0]).toMatchObject({ kind: "conflict", currentStatus: "LOST" });
    expect(results[1]).toMatchObject({ kind: "saved" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bets[0]!.id } })).status).toBe("LOST");
  });

  it("plano editado ou hash de outro plano não é aplicado", async () => {
    const { bets } = await seed();
    const plan = await planoOk([bets[0]!.id]);
    const editado = { ...plan, items: [{ ...plan.items[0]!, newStatus: "LOST" as const }] };
    await expect(applyDelegatedSettlementPlan(editado, plan.planHash)).rejects.toThrow(/alterado/);
    await expect(applyDelegatedSettlementPlan(plan, "f".repeat(64))).rejects.toThrow(/não corresponde/);
    expect(await db.prisma.settlementEvent.count()).toBe(0);
  });
});
