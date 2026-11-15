import { randomUUID } from "node:crypto";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server actions de Operações contra Postgres real, com a borda Next mockada
 * (headers = papel/usuário; cache = revalidate noop). É nesta borda que uma
 * regressão de autorização escapa sem ser vista, por isso ela é testada aqui.
 * vi.hoisted permite alternar o papel por teste.
 */
const h = vi.hoisted(() => ({ user: "tester", revalidate: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (k: string) => (k === "x-auth-user" ? h.user : null),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));

// Captura o enqueue do enrich (a action re-enfileira via boss compartilhado).
const sendSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({ send: sendSpy }) }));

import { createTestDb, type TestDb } from "../helpers/db";
import {
  acknowledgeOperationalActionAction,
  approveIaJudgeAction,
  ignoreMatchAction,
  rejectIaJudgeAction,
  replayJobAction,
  resolveMatchAction,
  resolveOperationalActionAction,
  retryChannelTransientAction,
  retrySharpAction,
  settleBetsAction,
} from "@/app/(painel)/operacoes/actions";
import { QUEUES } from "@/src/infra/queue-contract";
import { toNumber } from "@/src/domain/money";
import { applyAutomaticBetStatusChange } from "@/src/services/bets/settle";

let db: TestDb;
beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  h.user = "tester";
});

async function seedBet() {
  const id = crypto.randomUUID();
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: `Banca ${id}`, slug: `banca-${id}`, valorUnidade: 50 },
  });
  const conta = await db.prisma.conta.create({
    data: { casaDeAposta: "Bet365", titular: "Fabricio", saldoInicial: 1000, saldoAtual: 1000 },
  });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: null,
      bankrollId: bankroll.id,
      contaId: conta.id,
      data: new Date("2026-08-02T19:00:00Z"),
      evento: "Santos vs Grêmio",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "Santos",
      odds: 1.8,
      stake: 2,
      status: "PENDING",
    },
  });
}

/** O pedido como a fila o manda: a versão que a tela mostrou e o id do clique. */
async function request(...betIds: string[]) {
  const shown = await db.prisma.bet.findMany({ where: { id: { in: betIds } }, select: { id: true, manualSettlementVersion: true } });
  return betIds.map((betId) => ({
    betId,
    expectedVersion: shown.find((bet) => bet.id === betId)?.manualSettlementVersion ?? 1,
    requestId: randomUUID(),
  }));
}

describe("settleBetsAction (Postgres real + borda mockada)", () => {
  it("aposta que mudou depois de exibida volta como conflito, sem liquidar; o pedido repetido não reaplica o resultado", async () => {
    const bet = await seedBet();
    const shown = await request(bet.id);
    // Outra sessão edita a aposta (odd, seleção) com a fila aberta.
    await db.prisma.bet.update({ where: { id: bet.id }, data: { manualSettlementVersion: { increment: 1 } } });
    expect(await settleBetsAction(shown, "won")).toMatchObject({ failures: 0, ignoradas: 0, conflicts: 1, mutadas: [] });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");

    const current = await request(bet.id);
    const saved = await settleBetsAction(current, "won");
    const after = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(saved).toMatchObject({ conflicts: 0, mutadas: [bet.id], versions: { [bet.id]: after.manualSettlementVersion } });
    // O mesmo clique reenviado (rede) não reaplica: a aposta já não é pendente.
    expect(await settleBetsAction(current, "won")).toMatchObject({ failures: 0, ignoradas: 1, conflicts: 0, mutadas: [] });
    expect(await db.prisma.settlementEvent.count({ where: { betId: bet.id, type: "STATUS_CHANGED" } })).toBe(1);
  });

  it("admin liquida: WON, settledAt setado, failures 0, source com o autor", async () => {
    const bet = await seedBet();
    const r = await settleBetsAction(await request(bet.id), "won");
    expect(r.failures).toBe(0);
    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.status).toBe("WON");
    expect(updated.settledAt).toBeInstanceOf(Date);
    const ev = await db.prisma.settlementEvent.findFirstOrThrow({ where: { betId: bet.id } });
    const payload = ev.payload as { source?: string } | null;
    expect(payload?.source).toBe("manual:tester");
    // O extrato da conta guarda quem liquidou, não "system".
    expect((await db.prisma.movimentacao.findFirstOrThrow({ where: { betId: bet.id } })).actor).toBe("tester");
  });

  it("desfazer volta a pendente só a liquidação manual deste operador (B09)", async () => {
    const propria = await seedBet();
    const automatica = await seedBet();
    expect((await settleBetsAction(await request(propria.id), "won")).failures).toBe(0);
    await applyAutomaticBetStatusChange({
      betId: automatica.id,
      newStatus: "WON",
      source: "flashscore",
    });

    const r = await settleBetsAction(await request(propria.id, automatica.id), "pending");
    expect(r.failures).toBe(0);
    expect(r.mutadas).toEqual([propria.id]);
    expect(r.ignoradas).toBe(1);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: propria.id } })).status).toBe("PENDING");
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: automatica.id } })).status).toBe("WON");
  });

  it("admin marca VOID (reembolso): status VOID, lucro 0, saldo da conta intacto", async () => {
    const bet = await seedBet();
    const r = await settleBetsAction(await request(bet.id), "void");
    expect(r.failures).toBe(0);
    const updated = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(updated.status).toBe("VOID");
    expect(updated.settledAt).toBeInstanceOf(Date);
    expect(toNumber(updated.lucro)).toBe(0); // reembolso: stake devolvida, sem P&L
    // VOID não move dinheiro — o saldo da conta vinculada segue intacto
    const conta = await db.prisma.conta.findFirstOrThrow({ where: { casaDeAposta: "Bet365" } });
    expect(toNumber(conta.saldoAtual)).toBe(1000);
  });

  it("admin liquida linhas asiáticas como meia ganha e meia perda", async () => {
    const base = await seedBet();
    const halfWon = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: base.bankrollId,
        contaId: base.contaId,
        data: new Date("2026-08-02T20:00:00Z"),
        evento: "Flamengo vs Palmeiras",
        esporte: "Soccer",
        mercado: "Handicap Asiático",
        selecao: "Flamengo -0.25",
        odds: 1.9,
        stake: 2,
      },
    });
    const halfLost = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: base.bankrollId,
        contaId: base.contaId,
        data: new Date("2026-08-02T20:00:00Z"),
        evento: "Flamengo vs Palmeiras",
        esporte: "Soccer",
        mercado: "Handicap Asiático",
        selecao: "Flamengo +0.25",
        odds: 1.9,
        stake: 2,
      },
    });

    const rWon = await settleBetsAction(await request(halfWon.id), "half_won");
    expect(rWon.failures).toBe(0);
    expect(rWon.mutadas).toEqual([halfWon.id]);

    const rLost = await settleBetsAction(await request(halfLost.id), "half_lost");
    expect(rLost.failures).toBe(0);
    expect(rLost.mutadas).toEqual([halfLost.id]);

    const rows = await db.prisma.bet.findMany({
      where: { id: { in: [halfWon.id, halfLost.id] } },
      select: { id: true, status: true },
    });
    expect(rows.find((row) => row.id === halfWon.id)?.status).toBe("HALF_WON");
    expect(rows.find((row) => row.id === halfLost.id)?.status).toBe("HALF_LOST");
  });

  it("SET-001: recusa HALF_WON ou HALF_LOST em mercados binários como Moneyline, contada à parte das falhas", async () => {
    const bet = await seedBet(); // Mercado "Moneyline"
    const r = await settleBetsAction(await request(bet.id), "half_won");
    expect(r).toMatchObject({ failures: 0, halfRefused: 1, mutadas: [] });
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  });

  it("isola por aposta: UUID inexistente não aborta o lote (failures=1, válida liquida)", async () => {
    const bet = await seedBet();
    const r = await settleBetsAction(await request(bet.id, "00000000-0000-4000-8000-000000000001"), "won");
    expect(r.failures).toBe(1);
    expect(r.mutadas).toEqual([bet.id]);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("WON");
  });

  it("aposta já liquidada é ignorada com segurança pelo lote (ignoradas=1, failures=0)", async () => {
    const bet1 = await seedBet();
    const bet2 = await seedBet();
    // bet2 já está liquidada
    await db.prisma.bet.update({
      where: { id: bet2.id },
      data: { status: "LOST", settledAt: new Date() },
    });

    const r = await settleBetsAction(await request(bet1.id, bet2.id), "won");
    expect(r.failures).toBe(0);
    expect(r.ignoradas).toBe(1);
    expect(r.mutadas).toEqual([bet1.id]);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet1.id } })).status).toBe("WON");
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet2.id } })).status).toBe("LOST");
  });

  it("sem sessão é BARRADO", async () => {
    const bet = await seedBet();
    h.user = "";
    await expect(settleBetsAction(await request(bet.id), "won")).rejects.toThrow(/Sessão inválida/);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  });

  it("result inválido é rejeitado em runtime (input hostil)", async () => {
    const bet = await seedBet();
    const raw = settleBetsAction as unknown as (items: unknown[], r: string) => Promise<unknown>;
    await expect(raw(await request(bet.id), "WON")).rejects.toThrow(/inválido/i);
  });

  it("betIds vazio é rejeitado", async () => {
    await expect(settleBetsAction([], "won")).rejects.toThrow(/betIds/i);
  });

  it("rejeita UUID malformado antes de liquidar qualquer item", async () => {
    const bet = await seedBet();
    await expect(settleBetsAction([...await request(bet.id), { betId: "nao-existe", expectedVersion: 1, requestId: randomUUID() }], "won")).rejects.toThrow(/UUIDs/i);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("PENDING");
  });

  it("rejeita mais de 50 itens antes de iniciar o lote", async () => {
    const ids = Array.from(
      { length: 51 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    await expect(settleBetsAction(await request(...ids), "won")).rejects.toThrow(/1–50 UUIDs/i);
  });
});

describe("resolveMatchAction reprocessa a aposta", () => {
  it("ao resolver o caso, re-enfileira sharp.enrich do betId (não descarta o trabalho)", async () => {
    const bet = await seedBet();
    const tcase = await db.prisma.trainingCase.create({
      data: {
        betId: bet.id,
        evento: "Santos vs Grêmio",
        esporte: "Soccer",
        status: "OPEN",
        autoScore: 80,
        candidatesJson: [
          {
            matchId: 123,
            home: "Santos",
            away: "Gremio FBPA",
            league: "Brazil - Serie A",
            matchDate: "2026-08-02T19:00:00Z",
            score: 80,
            swapped: false,
          },
        ],
      },
    });
    sendSpy.mockClear();

    await resolveMatchAction(tcase.id, 0, canonicalSha256((tcase.candidatesJson as unknown[])[0] ?? null));

    expect(sendSpy).toHaveBeenCalledWith(
      QUEUES.sharpEnrich,
      expect.objectContaining({
        betId: bet.id,
        firstQueuedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        _observability: { correlationId: expect.stringMatching(/^action_/) },
      }),
      { singletonKey: `bet:${bet.id}`, priority: 10 },
    );
    const updated = await db.prisma.trainingCase.findUniqueOrThrow({ where: { id: tcase.id } });
    expect(updated.status).toBe("RESOLVED_MANUAL");
    expect(await db.prisma.auditEvent.count({
      where: { action: "training_case.resolve", actor: "tester", resourceId: tcase.id },
    })).toBe(1);
  });

  it("o nome que o Vincular não pôde ensinar volta como aviso ao dono", async () => {
    const bet = await seedBet();
    const tcase = await db.prisma.trainingCase.create({
      data: {
        betId: bet.id, evento: "Peixe vs Imortal", esporte: "Soccer", status: "OPEN", autoScore: 80,
        candidatesJson: [{
          matchId: 124, home: "Santos", away: "Gremio FBPA", league: "Brazil - Serie A",
          matchDate: "2026-08-02T19:00:00Z", score: 80, swapped: false,
        }],
      },
    });

    await expect(resolveMatchAction(tcase.id, 0, canonicalSha256((tcase.candidatesJson as unknown[])[0] ?? null))).resolves.toEqual({
      ok: true,
      notice: '"Peixe": sem ficha para ensinar · "Imortal": sem ficha para ensinar',
    });
  });

  it("caso já fechado volta como recusa com o motivo (a do serviço de treino)", async () => {
    const bet = await seedBet();
    const tcase = await db.prisma.trainingCase.create({
      data: {
        betId: bet.id, evento: "Santos vs Grêmio", esporte: "Soccer", status: "RESOLVED_MANUAL", autoScore: 80,
        candidatesJson: [],
      },
    });
    await expect(resolveMatchAction(tcase.id, 0, canonicalSha256((tcase.candidatesJson as unknown[])[0] ?? null))).resolves.toEqual({
      ok: false, erro: `Caso ${tcase.id} não está aberto (status RESOLVED_MANUAL).`,
    });
    await expect(ignoreMatchAction(tcase.id)).resolves.toEqual({
      ok: false, erro: `Caso ${tcase.id} não está aberto (status RESOLVED_MANUAL).`,
    });
  });

  it("adiar o caso grava com o operador da sessão", async () => {
    const bet = await seedBet();
    const tcase = await db.prisma.trainingCase.create({
      data: { betId: bet.id, evento: "Santos vs Grêmio", esporte: "Soccer", status: "OPEN", autoScore: 80, candidatesJson: [] },
    });
    await expect(ignoreMatchAction(tcase.id)).resolves.toEqual({ ok: true });
    expect(await db.prisma.auditEvent.findMany({
      where: { action: "training_case.defer", resourceId: tcase.id },
      select: { actor: true },
    })).toEqual([{ actor: "tester" }]);
  });

  it("sem sessão é barrado (não resolve nem reprocessa)", async () => {
    h.user = "";
    sendSpy.mockClear();
    await expect(resolveMatchAction("qualquer", 0, "a".repeat(64))).rejects.toThrow(/Sessão inválida/);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("approveIaJudgeAction", () => {
  it("liquida pela sugestão e revalida as telas financeiras, não só /operacoes", async () => {
    const bet = await seedBet();
    const suggestion = await db.prisma.iaJudgeSuggestion.create({ data: {
      betId: bet.id, suggestedStatus: "WON", evidenceKind: "GROUNDED_WEB", valueFound: "2-0",
      confidence: 0.9, reason: "Ganhou", provider: "gemini", status: "PENDING", betUpdatedAt: bet.updatedAt,
    } });
    h.revalidate.mockClear();
    await approveIaJudgeAction(suggestion.id);
    expect((await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } })).status).toBe("WON");
    const paths = h.revalidate.mock.calls.map(([path]) => path);
    expect(paths).toEqual(expect.arrayContaining(["/", "/contas", "/aposta", "/operacoes"]));
  });
});

describe("IDs opacos das ações de Operações", () => {
  it("rejeita UUIDs malformados antes de consultar domínio ou SQL cru", async () => {
    const calls = [
      () => resolveMatchAction("malformado", 0, "a".repeat(64)),
      () => ignoreMatchAction("malformado"),
      () => retrySharpAction("malformado"),
      () => replayJobAction(["malformado"]),
      () => approveIaJudgeAction("malformado"),
      () => rejectIaJudgeAction("malformado"),
      () => acknowledgeOperationalActionAction("malformado"),
      () => resolveOperationalActionAction("malformado"),
      () => retryChannelTransientAction("malformado"),
    ];
    // Id malformado é defeito do cliente: segue como erro e conta na taxa de
    // erro da action, em vez de virar recusa com mensagem.
    for (const call of calls) {
      await expect(call()).rejects.toThrow(/inválid/i);
    }
  });

  it("rejeita índice de candidato fora do domínio", async () => {
    await expect(
      resolveMatchAction("00000000-0000-4000-8000-000000000001", -1, "a".repeat(64)),
    ).rejects.toThrow(/Candidato inválido/);
  });
});
