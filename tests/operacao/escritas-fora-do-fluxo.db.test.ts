import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { checkEscritasForaDoFluxo } from "@/src/services/ops/consistency/escritas-fora-do-fluxo";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

const agora = new Date("2026-09-15T06:40:00Z");
const horasAtras = (h: number) => new Date(agora.getTime() - h * 3_600_000);

async function seedBet() {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Escritas", slug: "escritas" } });
  return db.prisma.bet.create({ data: { bankrollId: bankroll.id, casaDeAposta: "Betano", evento: "A vs B", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: horasAtras(30), mercado: "Money Line – Match", selecao: "A", odds: 2, stake: 1, data: horasAtras(30) } });
}
async function liquidacao(betId: string, source: string, createdAt: Date) {
  await db.prisma.settlementEvent.create({ data: { betId, type: "STATUS_CHANGED", payload: { source, from: "PENDING", to: "WON" }, payloadHash: `${source}-${createdAt.toISOString()}`, createdAt } });
}

describe("checkEscritasForaDoFluxo (Postgres real)", () => {
  it("fluxo automático e operador do painel não geram revisão", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    const bet = await seedBet();
    await db.prisma.auditEvent.createMany({ data: [
      { actor: "system", action: "identidade_auto", createdAt: horasAtras(1) },
      { actor: "telegram-channel:gemini-vision", action: "bet.create", createdAt: horasAtras(2) },
      { actor: "operador", action: "bet.soft_delete", createdAt: horasAtras(3) },
    ] });
    await liquidacao(bet.id, "flashscore", horasAtras(1));
    await liquidacao(bet.id, "manual:operador", horasAtras(2));
    expect((await checkEscritasForaDoFluxo(agora)).escritas).toEqual([]);
    expect(await db.prisma.operationalAction.count()).toBe(0);
  });

  it("eventos de prop de jogador não são mudança de status: o `source` deles não é autor", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    const bet = await seedBet();
    const evento = (type: string, payload: object, hora: number) => db.prisma.settlementEvent.create({ data: {
      betId: bet.id, type, payload, payloadHash: `${type}-${hora}`, createdAt: horasAtras(hora),
    } });
    await evento("PLAYER_PROP_OBSERVATION", { source: { provider: "flashscore", endpoints: ["/x"] } }, 1);
    await evento("PLAYER_PROP_VALIDATION", { source: "conferi no sofascore", actor: "operador" }, 2);
    await evento("PLAYER_PROP_DIVERGENCE_REVIEWED", { actor: "operador" }, 3);
    expect((await checkEscritasForaDoFluxo(agora)).escritas).toEqual([]);
    expect(await db.prisma.operationalAction.count()).toBe(0);
  });

  it("agrupa escritas sem autoria e delegadas num único item do dia", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    const bet = await seedBet();
    await db.prisma.auditEvent.createMany({ data: [
      { actor: "operator", action: "bet.edit", createdAt: horasAtras(1) },
      { actor: "operator", action: "operational_action.resolved", createdAt: horasAtras(1) },
      { actor: "auto-curadoria:recalibracao", action: "team_identity.promote", createdAt: horasAtras(5) },
      { actor: "agent:antigravity:por:operador", action: "bet.settle_delegated", createdAt: horasAtras(2) },
      // Fora da janela de 24h.
      { actor: "auto-healer", action: "mercado.auto_heal", createdAt: horasAtras(25) },
    ] });
    await liquidacao(bet.id, "operator:audit:Auditado", horasAtras(1));
    await liquidacao(bet.id, "manual:operator", horasAtras(1.5));

    const { escritas } = await checkEscritasForaDoFluxo(agora);
    expect(escritas.map((e) => [e.quem, e.origem, e.eventos])).toEqual([
      ["operator", "unattributed", 2],
      ["auto-curadoria:recalibracao", "unattributed", 1],
      ["liquidação:manual:operator", "unattributed", 1],
      ["liquidação:operator:audit:Auditado", "unattributed", 1],
      ["agent:antigravity:por:operador", "delegated", 1],
    ]);
    const actions = await db.prisma.operationalAction.findMany();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ title: "Escritas fora do fluxo automático", risk: "HIGH", status: "OPEN" });

    await checkEscritasForaDoFluxo(agora);
    expect(await db.prisma.operationalAction.count()).toBe(1);
  });

  it("tentativas de login não entram na revisão nem empurram escrita real para fora da lista", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    await db.prisma.auditEvent.createMany({ data: [
      ...Array.from({ length: 25 }, (_, i) => ({
        actor: `anonimo-${i}`, action: "auth.login_failed", resource: "auth", outcome: "failure", createdAt: horasAtras(1),
      })),
      // Username forjado como delegado não pode se passar por agente.
      { actor: "agent:x:por:operador", action: "auth.login_failed", resource: "auth", outcome: "failure", createdAt: horasAtras(1) },
      { actor: "auto-healer", action: "mercado.auto_heal", resource: "mercado", createdAt: horasAtras(3) },
    ] });
    const { escritas } = await checkEscritasForaDoFluxo(agora);
    expect(escritas.map((e) => [e.quem, e.origem, e.eventos])).toEqual([["auto-healer", "unattributed", 1]]);
    const action = await db.prisma.operationalAction.findFirstOrThrow();
    expect(action.description).not.toContain("anonimo");
    expect(action.description).not.toContain("… e mais");
  });

  it("em auth, só as tentativas de login saem da revisão", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    await db.prisma.auditEvent.createMany({ data: [
      { actor: "anonimo", action: "auth.login_claimed", resource: "auth", createdAt: horasAtras(1) },
      { actor: "anonimo", action: "auth.login_ok", resource: "auth", createdAt: horasAtras(1) },
      { actor: "script-senha", action: "auth.password_reset", resource: "auth", createdAt: horasAtras(2) },
    ] });
    const { escritas } = await checkEscritasForaDoFluxo(agora);
    expect(escritas.map((e) => [e.quem, e.acoes])).toEqual([["script-senha", ["auth.password_reset"]]]);
  });

  it("só delegadas: item de risco baixo", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    await db.prisma.auditEvent.create({ data: { actor: "agent:antigravity:por:operador", action: "bet.settle_delegated", createdAt: horasAtras(2) } });
    await checkEscritasForaDoFluxo(agora);
    expect(await db.prisma.operationalAction.findFirstOrThrow()).toMatchObject({ risk: "LOW" });
  });

  it("decisões do funcionário de IA, com evidência e dentro do teto, não abrem item", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    await db.prisma.auditEvent.createMany({ data: [
      { actor: "agent:gemini:por:operador", action: "bet.settle_delegated", details: { evidence: "FlashScore: 2 x 1, encerrado" }, createdAt: horasAtras(2) },
      { actor: "agent:gemini:por:operador", action: "training_case.resolve", details: { evidence: "Pinnacle lista o jogo às 12h" }, createdAt: horasAtras(3) },
      { actor: "agent:claude:por:operador", action: "training_case.defer", details: { reason: "Nenhum candidato serve" }, createdAt: horasAtras(4) },
    ] });
    expect((await checkEscritasForaDoFluxo(agora)).escritas).toEqual([]);
    expect(await db.prisma.operationalAction.count()).toBe(0);
  });

  it("escrita de agente fora do funcionário abre item, e a rotina do funcionário fica fora da lista", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    await db.prisma.auditEvent.createMany({ data: [
      { actor: "agent:gemini:por:operador", action: "bet.settle_delegated", details: { evidence: "FlashScore: 2 x 1, encerrado" }, createdAt: horasAtras(2) },
      // O lote do ops-resolve-sport e um script de correção: sem evidência, fora do MCP.
      { actor: "agent:gemini:por:operador", action: "bet.sport_resolve.operator", details: { status: "resolved", reason: "strong_candidate_applied", forced: false }, createdAt: horasAtras(2) },
      { actor: "agent:claude:por:operador", action: "ops.apagar_aliases", createdAt: horasAtras(3) },
    ] });
    const { escritas } = await checkEscritasForaDoFluxo(agora);
    expect(escritas.map((e) => [e.quem, e.acoes])).toEqual([
      ["agent:claude:por:operador", ["ops.apagar_aliases"]],
      ["agent:gemini:por:operador", ["bet.sport_resolve.operator"]],
    ]);
    const action = await db.prisma.operationalAction.findFirstOrThrow();
    expect(action).toMatchObject({ risk: "LOW", status: "OPEN" });
    expect(action.description).toContain("1 decisões do funcionário de IA");
  });

  it("decisões com evidência acima do teto do dono deixam de ser rotina", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    await db.prisma.auditEvent.createMany({ data: Array.from({ length: 51 }, (_, i) => ({
      actor: i % 2 ? "agent:gemini:por:operador" : "agent:claude:por:operador", action: "bet.settle_delegated",
      details: { evidence: "FlashScore: placar final" }, createdAt: horasAtras(2),
    })) });
    const { escritas } = await checkEscritasForaDoFluxo(agora);
    expect(escritas.reduce((sum, e) => sum + e.eventos, 0)).toBe(51);
    expect(await db.prisma.operationalAction.count()).toBe(1);
  });

  it("a revisão começa onde a última concluída parou: o dia em que o job não rodou não se perde", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    expect((await checkEscritasForaDoFluxo(horasAtras(60))).escritas).toEqual([]);
    // Escrita de 40 h atrás: fora das 24 h, mas depois da última revisão concluída.
    await db.prisma.auditEvent.create({ data: { actor: "auto-healer", action: "mercado.auto_heal", createdAt: horasAtras(40) } });

    const { escritas } = await checkEscritasForaDoFluxo(agora);
    expect(escritas.map((e) => e.quem)).toEqual(["auto-healer"]);
    expect((await db.prisma.operationalAction.findFirstOrThrow()).description).toContain("60h até");
    // Já revista: a próxima rodada não a traz de novo.
    expect((await checkEscritasForaDoFluxo(new Date(agora.getTime() + 3_600_000))).escritas).toEqual([]);
  });

  it("sem rodar há mais de 7 dias, a revisão volta só 7 dias", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    await checkEscritasForaDoFluxo(horasAtras(30 * 24));
    await db.prisma.auditEvent.createMany({ data: [
      { actor: "auto-healer", action: "mercado.auto_heal", createdAt: horasAtras(8 * 24) },
      { actor: "outro-script", action: "bet.edit", createdAt: horasAtras(6 * 24) },
    ] });
    expect((await checkEscritasForaDoFluxo(agora)).escritas.map((e) => e.quem)).toEqual(["outro-script"]);
  });

  it("delegada por operador que não é do painel conta como sem autor: risco alto", async () => {
    await db.prisma.authSessionState.create({ data: { username: "operador", epoch: 1n } });
    await db.prisma.auditEvent.create({ data: { actor: "agent:claude:por:admin", action: "bet.delete", createdAt: horasAtras(2) } });
    const { escritas } = await checkEscritasForaDoFluxo(agora);
    expect(escritas.map((e) => [e.quem, e.origem])).toEqual([["agent:claude:por:admin", "unattributed"]]);
    expect(await db.prisma.operationalAction.findFirstOrThrow()).toMatchObject({ risk: "HIGH" });
  });
});
