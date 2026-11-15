import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { preparePlayerCaptureBatch } from "@/src/domain/player-prop-capture";
import { toNumber } from "@/src/domain/money";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { playerPropRule } from "@/src/domain/settlement/player-prop-rules";
import { settlePersistentPlayerProp } from "@/src/services/settlement/flashscore/player-props";
import { resolvePlayerIdentity } from "@/src/services/players/resolve";
import { applyPlayerPanelCommand } from "@/src/services/players/panel";
import { applyAutomaticBetStatusChange } from "@/src/services/bets/settle";
import { applyManualBetStatusChange } from "../helpers/settle";
import { normalizePlayerAppearances } from "@/src/providers/flashscore/lineups";
import { registerCaptureBatch } from "@/src/services/capture/channel/register-post";
import { captureFinancialContext } from "@/src/services/capture/capture-financial-context";
import ganso from "../fixtures/player-props/ganso-three-singles.json";
import type { ParsedBetPost } from "@/src/domain/bet-capture";
import type { SportResolutionDecision } from "@/src/domain/sports/detect";
import { ProviderRequestError } from "@/src/domain/provider-error";
import { BetSettlementTermsChangedError } from "@/src/services/bets/settle-terms";
import { notifyPersistedOperationalAlert, sendOperatorNotification } from "@/src/services/ops/alerts";

const mocked = vi.hoisted(() => ({ getEvidence: vi.fn(), cancelEnrich: vi.fn() }));
vi.mock("@/src/providers/flashscore/player-evidence", () => ({ getFlashscorePlayerEvidence: mocked.getEvidence }));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperatorNotification: vi.fn(), sendOperationalAlert: vi.fn(), notifyPersistedOperationalAlert: vi.fn(),
}));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({}) }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ cancelPendingSharpEnrich: mocked.cancelEnrich }));
vi.mock(import("@/src/services/bets/sport-resolution/capture"), async (original) => ({
  ...await original(),
  resolveSportForCaptureAsync: vi.fn(async () => ({ sport: "Soccer", status: "CONFIRMED", confidence: 100, source: "LEGACY", evidence: [], resolverVersion: 1 }) satisfies SportResolutionDecision),
}));

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); vi.clearAllMocks(); });

const now = new Date("2026-09-08T20:00:00Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const lineups = ["home", "away"].map((side) => ({ side,
  startingLineups: Array.from({ length: 11 }, (_, i) => ({ player_id: i === 0 && side === "home" ? "tom" : `${side}${i}`, name: i === 0 && side === "home" ? "Fellows T." : `${side} Player ${i}` })),
  substitutes: [], substitutedPlayers: [],
}));
function evidence(minutes: number, value = 2) {
  return { lineups, fetchedAt: at(minutes), stats: { players: [{ player_id: "tom", name: "Fellows Tom", team_id: "h", in_base_lineup: true, stats: { SHOTS_TOTAL: { raw_value: String(value) }, MATCH_MINUTES_PLAYED: { raw_value: "90" } } }] } };
}
async function fixture(automatic = false) {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Igux teste", slug: "igux", sharpMode: "IDENTITY_ONLY", playerPropsAutoSettlement: automatic, imageStakeAsUnits: true } });
  const bet = await db.prisma.bet.create({ data: { bankrollId: bankroll.id, evento: "Southampton vs Swansea", esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: at(-180), mercado: "Player Shots", selecao: "Tom Fellows Over 1.5", competicao: "Championship", casaDeAposta: "Bet365", data: at(-180), registradoEm: at(-240), odds: 2.32, stake: 1.25 } });
  await db.prisma.betPlayerProp.create({ data: { betId: bet.id, terms: buildPlayerPropTerms(bet)!, rule: playerPropRule("Bet365", "shots_total") } });
  const current = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
  return { bankroll, bet: current, params: { bet: { ...current, playerPropRevision: 1 }, matchId: "fixture", homeId: "h", awayId: "a", swapped: false, extraTime: false, now } };
}

describe("identidade e liquidação comprovada em PostgreSQL", () => {
  it("indisponibilidade durante seis horas mantém dinheiro pendente e encaminha para revisão", async () => {
    const f = await fixture();
    mocked.getEvidence.mockRejectedValue(new ProviderRequestError("flashscore", { error: "temporariamente indisponível", status: 503 }));
    expect(await settlePersistentPlayerProp(f.params)).toMatchObject({ aguardando: true });
    expect(await settlePersistentPlayerProp({ ...f.params, now: at(360) })).toMatchObject({ aguardando: false, unsupported: true });
    expect((await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: f.bet.id } })).evidence).toMatchObject({ endedAt: now.toISOString(), reason: "provider_indisponivel" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).status).toBe("PENDING");
  });
  it.each([
    { liveTextAtCapture: true },
    { liveScoreHome: 0, liveScoreAway: 0 },
    { kickoffInferido: true },
  ])("não comprova pré-jogo só pelo horário diante de %j", async (change) => {
    const f = await fixture(true);
    await db.prisma.bet.update({ where: { id: f.bet.id }, data: change });
    const current = await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } });
    const params = { ...f.params, bet: { ...current, playerPropRevision: 1 } };
    mocked.getEvidence.mockResolvedValueOnce(evidence(0)).mockResolvedValueOnce(evidence(10));
    await settlePersistentPlayerProp(params);
    expect(await settlePersistentPlayerProp({ ...params, now: at(10) })).toMatchObject({ settled: false });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).status).toBe("PENDING");
    expect((await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: f.bet.id } })).evidence)
      .toMatchObject({ decision: { ok: false, reason: "regra_ao_vivo_nao_comprovada" } });
    expect(await db.prisma.movimentacao.count()).toBe(0);
  });

  it("só habilita após 20 resultados conferidos em três competições", async () => {
    const f = await fixture();
    const terms = buildPlayerPropTerms(f.bet)!;
    for (let i = 0; i < 20; i++) {
      const bet = i === 0 ? f.bet : await db.prisma.bet.create({ data: { bankrollId: f.bankroll.id, evento: `Casa ${i} vs Fora ${i}`, esporte: "Soccer", sportResolutionStatus: "CONFIRMED", sportResolvedAt: at(-180), mercado: "Player Shots", selecao: "Tom Fellows Over 1.5", competicao: `Liga ${i % 3}`, casaDeAposta: "Bet365", data: at(-180), registradoEm: at(-240), odds: 2, stake: 1 } });
      if (i !== 0) await db.prisma.betPlayerProp.create({ data: { betId: bet.id, terms, rule: playerPropRule("Bet365", "shots_total") } });
      await db.prisma.betPlayerProp.update({ where: { betId: bet.id }, data: { evidence: { stable: true, proposedStatus: "WON" } } });
      await applyPlayerPanelCommand({ kind: "result", betId: bet.id, status: "WON", evidence: "Conferência sintética do bilhete" }, "teste");
      if (i === 18) await expect(applyPlayerPanelCommand({ kind: "settings", bankrollId: f.bankroll.id, automatic: true, imageStakeAsUnits: true }, "teste")).rejects.toThrow(/20 apostas/);
    }
    await applyPlayerPanelCommand({ kind: "settings", bankrollId: f.bankroll.id, automatic: true, imageStakeAsUnits: true }, "teste");
    expect((await db.prisma.bankroll.findUniqueOrThrow({ where: { id: f.bankroll.id } })).playerPropsAutoSettlement).toBe(true);
  });
  it("duas observações separadas por 10 min geram proposta sem movimentar grupo em validação", async () => {
    const f = await fixture();
    mocked.getEvidence.mockResolvedValueOnce(evidence(0)).mockResolvedValueOnce(evidence(10));
    expect(await settlePersistentPlayerProp(f.params)).toMatchObject({ settled: false, aguardando: true });
    expect(await settlePersistentPlayerProp({ ...f.params, now: at(9) })).toMatchObject({ settled: false });
    expect(mocked.getEvidence).toHaveBeenCalledTimes(1);
    expect(await settlePersistentPlayerProp({ ...f.params, now: at(10) })).toMatchObject({ settled: false, settlementOutcome: "player_prop_shadow" });
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).toMatchObject({ status: "PENDING" });
    expect((await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: f.bet.id } })).evidence).toMatchObject({ stable: true, proposedStatus: "WON" });
    expect(await db.prisma.betSharp.count()).toBe(0);
  });
  it("grupo habilitado liquida uma vez, com prova e revisão dentro da transação financeira", async () => {
    const f = await fixture(true);
    await expect(applyAutomaticBetStatusChange({ betId: f.bet.id, newStatus: "WON", source: "flashscore", expectedTerms: f.params.bet })).rejects.toThrow(/evidência/);
    mocked.getEvidence.mockResolvedValueOnce(evidence(0)).mockResolvedValueOnce(evidence(10));
    await settlePersistentPlayerProp(f.params);
    expect(await settlePersistentPlayerProp({ ...f.params, now: at(10) })).toMatchObject({ settled: true });
    const bet = await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } });
    expect(bet.status).toBe("WON"); expect(Number(bet.lucro)).toBeCloseTo(1.65);
    // Os efeitos de toda liquidação automática: o aviso ao dono e o fim do enrich pendente.
    expect(sendOperatorNotification).toHaveBeenCalledTimes(1);
    expect(sendOperatorNotification).toHaveBeenCalledWith(expect.stringContaining("Resultado: Fellows Tom · 2 chutes (FlashScore)"), { key: `settlement:${f.bet.id}:${f.params.bet.manualSettlementVersion}` });
    expect(mocked.cancelEnrich).toHaveBeenCalledWith(expect.anything(), f.bet.id, "settled");
  });
  it("liquidação automática sem conta única avisa o dono, como as demais", async () => {
    const f = await fixture(true);
    for (const titular of ["Um", "Dois"]) {
      await db.prisma.conta.create({ data: { casaDeAposta: "Bet365", titular, saldoInicial: 100, saldoAtual: 100 } });
    }
    mocked.getEvidence.mockResolvedValueOnce(evidence(0)).mockResolvedValueOnce(evidence(10));
    await settlePersistentPlayerProp(f.params);
    expect(await settlePersistentPlayerProp({ ...f.params, now: at(10) })).toMatchObject({ settled: true });
    expect(await db.prisma.operationalAction.count({ where: { title: "Liquidada sem movimentar conta" } })).toBe(1);
    expect(notifyPersistedOperationalAlert).toHaveBeenCalledWith(
      expect.stringContaining("sem mexer no saldo"), expect.objectContaining({ key: f.bet.id }),
    );
  });
  it("aposta liquidada à mão durante a leitura não derruba a observação nem conta como liquidada", async () => {
    const f = await fixture(true);
    mocked.getEvidence.mockResolvedValueOnce(evidence(0)).mockImplementationOnce(async () => {
      await applyManualBetStatusChange({ betId: f.bet.id, newStatus: "LOST", source: "manual:teste" });
      return evidence(10);
    });
    await settlePersistentPlayerProp(f.params);
    expect(await settlePersistentPlayerProp({ ...f.params, now: at(10) }))
      .toMatchObject({ settled: false, settlementOutcome: "already_settled" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).status).toBe("LOST");
    expect(sendOperatorNotification).not.toHaveBeenCalled();
  });
  it("conferência em 24h sinaliza correção e preserva a decisão manual", async () => {
    const f = await fixture();
    mocked.getEvidence.mockResolvedValueOnce(evidence(0)).mockResolvedValueOnce(evidence(10)).mockResolvedValueOnce(evidence(1440, 0));
    await settlePersistentPlayerProp(f.params);
    await settlePersistentPlayerProp({ ...f.params, now: at(10) });
    await applyPlayerPanelCommand({ kind: "result", betId: f.bet.id, status: "WON", evidence: "Bilhete da casa conferido" }, "teste");
    await settlePersistentPlayerProp({ ...f.params, bet: { ...await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } }), playerPropRevision: 1 }, now: at(1440), recheck: true });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).status).toBe("WON");
    expect((await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: f.bet.id } })).evidence).toMatchObject({ correctionReview: true, checked24h: true });
    expect(await db.prisma.auditEvent.count({ where: { action: "player_prop.result_changed" } })).toBe(1);
    await expect(applyPlayerPanelCommand({ kind: "settings", bankrollId: f.bankroll.id, automatic: true, imageStakeAsUnits: true }, "teste")).rejects.toThrow(/20 apostas/);
  });
  it("revisão alterada ou resultado manual concorrente invalida o snapshot antigo", async () => {
    const f = await fixture(true);
    mocked.getEvidence.mockResolvedValue(evidence(0));
    await settlePersistentPlayerProp(f.params);
    await db.prisma.betPlayerProp.update({ where: { betId: f.bet.id }, data: { revision: { increment: 1 } } });
    await expect(settlePersistentPlayerProp({ ...f.params, now: at(10) })).rejects.toThrow(BetSettlementTermsChangedError);
    await applyManualBetStatusChange({ betId: f.bet.id, newStatus: "LOST", source: "manual:teste" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: f.bet.id } })).status).toBe("LOST");
  });
  it("remover o nome local do jogador reabre a leitura do resultado das apostas pendentes dele", async () => {
    const f = await fixture();
    const identity = await db.prisma.playerIdentity.create({ data: { canonicalName: "Tom Fellows", sport: "Soccer", providerPlayerId: "tom" } });
    const alias = await db.prisma.playerProviderAlias.create({ data: { playerIdentityId: identity.id, provider: "LOCAL",
      name: "Tom Fellows", normalizedName: "tom fellows", source: "MANUAL", confidence: 100 } });
    await db.prisma.betPlayerProp.update({ where: { betId: f.bet.id }, data: { playerIdentityId: identity.id } });
    await db.prisma.betResult.create({ data: { betId: f.bet.id, resultProvider: "flashscore", resultMatchId: "fixture",
      resultFinal: true, resultCheckedAt: at(-10) } });

    await applyPlayerPanelCommand({ kind: "removeAlias", aliasId: alias.id }, "teste");

    // O jogo vinculado fica; a leitura volta a ser feita com a identidade nova.
    expect(await db.prisma.betResult.findUniqueOrThrow({ where: { betId: f.bet.id } }))
      .toMatchObject({ resultMatchId: "fixture", resultFinal: false, resultCheckedAt: null });
    expect(await db.prisma.betPlayerProp.findUniqueOrThrow({ where: { betId: f.bet.id } }))
      .toMatchObject({ playerIdentityId: null, resolutionStatus: "PENDING" });
  });
  it("homônimos nunca aprendem alias automático; transferências preservam vínculo por partida", async () => {
    const players = ["one", "two"].map((playerId) => ({ playerId, nome: "João Silva", teamId: playerId, gols: 0, golsContra: 0 }));
    const result = await resolvePlayerIdentity({ selection: "Joao Silva Over 0.5", playerName: "Joao Silva", matchId: "m1", sport: "Soccer", players, appearances: [], now });
    expect(result).toMatchObject({ ok: false, reason: "jogador_ambiguo" });
    expect(await db.prisma.playerProviderAlias.count({ where: { provider: "LOCAL" } })).toBe(0);
    const appearances = normalizePlayerAppearances(lineups, { home: "h", away: "a" });
    const tom = { playerId: "tom", nome: "Tom Fellows", gols: 0, golsContra: 0 };
    await resolvePlayerIdentity({ selection: "Tom Fellows Over 1.5", playerName: "Tom Fellows", matchId: "m1", sport: "Soccer", players: [tom], appearances, now });
    await resolvePlayerIdentity({ selection: "Tom Fellows Over 1.5", playerName: "Tom Fellows", matchId: "m2", sport: "Soccer", players: [tom], appearances: appearances.map((a) => ({ ...a, teamId: "national" })), now });
    expect(await db.prisma.playerIdentity.count({ where: { providerPlayerId: "tom" } })).toBe(1);
    expect((await db.prisma.playerMatchAppearance.findMany({ where: { playerIdentity: { providerPlayerId: "tom" } } })).map((a) => a.providerTeamId).sort()).toEqual(["h", "national"]);
  });
});

describe("três simples: atomicidade e reentrega", () => {
  it("grava casa e regra pelo link compartilhado mesmo com guard numérico por simples", async () => {
    const f = await captureFixture();
    await registerCaptureBatch({ ...f, bets: f.bets.map((b) => ({ ...b, casaDeAposta: "", stakeSource: "caption" as const })), caption: "1u\n2u\n0.5u\nhttps://www.bet365.bet.br/dl/sportsbookredirect?bet=1" });
    const rows = await db.prisma.bet.findMany({ include: { playerProp: true, captureEvidence: true }, orderBy: { sourceExternalId: "asc" } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.casaDeAposta).toBe("Bet365");
      expect(row.playerProp?.rule).toMatchObject({ bookmaker: "Bet365", verified: true });
      expect(row.captureEvidence?.parsedJson).toMatchObject({ casaDeAposta: "Bet365" });
    }
    expect(rows.map((r) => Number(r.stake))).toEqual([1, 2, 0.5]);
  });
  it("fração da legenda chega ao banco e ao ledger com a precisão de cada etapa", async () => {
    const f = await captureFixture(100);
    const conta = await db.prisma.conta.create({ data: {
      casaDeAposta: 'KTO', titular: 'Simulação', saldoInicial: 1000, saldoAtual: 1000,
      bankrollLinks: { create: { bankrollId: f.bankroll.id } },
    } });
    const caption = '1/3u cada';
    const batch = preparePlayerCaptureBatch(f.bets.map((bet) => ({ ...bet, stake: 50, stakeSource: 'image_units' })), caption, true);
    expect(batch.ok).toBe(true);
    if (!batch.ok) throw new Error(batch.reason);
    expect(await registerCaptureBatch({ ...f, bets: batch.bets, caption })).toMatchObject({ kind: 'registered' });
    const bets = await db.prisma.bet.findMany({ include: { captureEvidence: true } });
    expect(bets).toHaveLength(3);
    for (const bet of bets) {
      expect(toNumber(bet.stake)).toBe(0.333333);
      expect(toNumber(bet.valorUnidade)).toBe(100);
      expect(bet.captureEvidence?.parsedJson).toMatchObject({ stake: 1 / 3 });
      await applyManualBetStatusChange({ betId: bet.id, newStatus: 'LOST', source: 'manual:teste' });
    }
    const movements = await db.prisma.movimentacao.findMany({ where: { contaId: conta.id } });
    expect(movements.map((movement) => toNumber(movement.valor))).toEqual([-33.33, -33.33, -33.33]);
    expect(toNumber((await db.prisma.conta.findUniqueOrThrow({ where: { id: conta.id } })).saldoAtual)).toBe(900.01);
  });

  async function captureFixture(unitValue?: number) {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: "Igux teste", slug: "igux", valorUnidade: unitValue, sharpMode: "IDENTITY_ONLY", imageStakeAsUnits: true } });
    const bets = ganso.items.map((b) => ({ ...b, data: at(-180) })) as ParsedBetPost[];
    const financial = await captureFinancialContext({ source: "telegram-channel:-1234", sourceExternalId: "20" }, { bankrollId: bankroll.id });
    return { bankroll: { ...bankroll, financialContextId: financial!.id, defaultStakeUnits: bankroll.defaultStakeUnits === null ? null : Number(bankroll.defaultStakeUnits) }, post: { chatId: -1234n, messageId: 20, postDate: at(-240) }, bets, via: "gemini-vision" as const, caption: "", mediaFileId: "original" };
  }
  it("captura repetida/concorrente e reordenada mantém três IDs", async () => {
    const f = await captureFixture();
    await registerCaptureBatch(f);
    await Promise.all([registerCaptureBatch(f), registerCaptureBatch({ ...f, bets: [...f.bets].reverse() })]);
    expect(await db.prisma.bet.count()).toBe(3);
    expect(await db.prisma.betPlayerProp.count()).toBe(3);
  });
  it("falha em um item não deixa os anteriores gravados", async () => {
    const f = await captureFixture();
    const bad = { ...f.bets[1]!, odds: 999_999 };
    await registerCaptureBatch({ ...f, bets: [f.bets[0]!, bad, f.bets[2]!] }).catch(() => undefined);
    expect(await db.prisma.bet.count()).toBe(0);
    await registerCaptureBatch(f);
    expect((await db.prisma.bet.findMany({ orderBy: { sourceExternalId: "asc" } })).map((b) => Number(b.stake))).toEqual([1, 2, 0.5]);
  });
});
