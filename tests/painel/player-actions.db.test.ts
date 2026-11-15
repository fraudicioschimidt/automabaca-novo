import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Curadoria de jogadores pela server action, contra Postgres real: o resultado
 * de uma prop é liquidação como qualquer outra e passa pelos mesmos efeitos
 * pós-commit e pela mesma revalidação das telas financeiras.
 */
const h = vi.hoisted(() => ({ user: "tester", revalidate: vi.fn(), cancel: vi.fn(), notify: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => (k === "x-auth-user" ? h.user : null) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({}) }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ cancelPendingSharpEnrich: h.cancel }));
vi.mock("@/src/services/ops/alerts", () => ({ notifyPersistedOperationalAlert: h.notify }));

import { createTestDb, type TestDb } from "../helpers/db";
import { buildPlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { playerPropRule } from "@/src/domain/settlement/player-prop-rules";
import { curatePlayerAction } from "@/app/(painel)/config/player-actions";

let db: TestDb;
beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => {
  await db.reset();
  vi.clearAllMocks();
  h.user = "tester";
});

async function pendingProp(options: { vincularContas?: boolean } = {}) {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Props", slug: "props", vincularContas: options.vincularContas ?? false } });
  const bet = await db.prisma.bet.create({ data: {
    bankrollId: bankroll.id, evento: "Southampton vs Swansea", esporte: "Soccer", sportResolutionStatus: "CONFIRMED",
    sportResolvedAt: new Date("2026-09-08T17:00:00Z"), mercado: "Player Shots", selecao: "Tom Fellows Over 1.5",
    competicao: "Championship", casaDeAposta: "Bet365", data: new Date("2026-09-08T17:00:00Z"), odds: 2.32, stake: 1.25,
  } });
  await db.prisma.betPlayerProp.create({ data: { betId: bet.id, terms: buildPlayerPropTerms(bet)!, rule: playerPropRule("Bet365", "shots_total") } });
  return bet;
}

describe("curatePlayerAction: resultado da prop", () => {
  it("cancela o enrich pendente e revalida as telas financeiras", async () => {
    const bet = await pendingProp();
    await curatePlayerAction({ kind: "result", betId: bet.id, status: "WON", evidence: "Bilhete conferido" });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("WON");
    expect(h.cancel).toHaveBeenCalledWith(expect.anything(), bet.id, "settled");
    const paths = h.revalidate.mock.calls.map(([path]) => path);
    expect(paths).toEqual(expect.arrayContaining(["/config", "/", "/contas", "/aposta", "/operacoes"]));
  });

  it("avisa quando a liquidação não movimenta a conta", async () => {
    const bet = await pendingProp({ vincularContas: true });
    // Duas contas da mesma casa sem vínculo: nenhuma é elegível.
    for (const titular of ["A", "B"]) {
      await db.prisma.conta.create({ data: { casaDeAposta: "Bet365", titular, saldoInicial: 100, saldoAtual: 100 } });
    }
    await curatePlayerAction({ kind: "result", betId: bet.id, status: "LOST", evidence: "Bilhete conferido" });
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("sem mexer no saldo"),
      expect.objectContaining({ source: "bets.settle-sem-conta", key: bet.id }),
    );
  });

  it("aposta já liquidada volta como recusa com a mensagem, sem mexer no resultado", async () => {
    const bet = await pendingProp();
    await expect(curatePlayerAction({ kind: "result", betId: bet.id, status: "WON", evidence: "Bilhete conferido" }))
      .resolves.toEqual({ ok: true });
    await expect(curatePlayerAction({ kind: "result", betId: bet.id, status: "LOST", evidence: "Bilhete conferido de novo" }))
      .resolves.toEqual({ ok: false, erro: "Esta aposta não está mais pendente." });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("WON");
  });

  it("sem sessão é barrado antes de liquidar", async () => {
    const bet = await pendingProp();
    h.user = "";
    await expect(curatePlayerAction({ kind: "result", betId: bet.id, status: "WON", evidence: "Bilhete conferido" }))
      .rejects.toThrow(/Sessão inválida/);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  });
});
