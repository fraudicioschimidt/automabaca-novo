import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { applyManualBetStatusChange as applyBetStatusChange } from "../helpers/settle";
import { loteAlcancaAposta } from "@/src/domain/settlement/manual-batch";
import { FINAL_BET_STATUSES } from "@/src/domain/bet-status";

/**
 * A liquidação manual de Operações não pode sobrescrever, a partir da fila de
 * PENDÊNCIAS, um resultado que já estava liquidado. É alcançável: a maior parte
 * das liquidações vem de fonte AUTOMÁTICA, e entre o clique e o commit o
 * liquidador ainda corre. O operador sobrescreveria o automático, carimbado
 * `manual:<quem>`; por isso a BORDA não confia no cliente.
 */

describe("a regra do lote é direcional", () => {
  it("para frente não alcança aposta já terminal", () => {
    for (const terminal of FINAL_BET_STATUSES) {
      for (const destino of ["WON", "HALF_WON", "LOST", "HALF_LOST", "VOID"]) {
        expect(loteAlcancaAposta(terminal, destino), `${terminal} → ${destino}`).toBe(false);
      }
    }
  });

  it("para frente alcança pendente", () => {
    for (const destino of ["WON", "HALF_WON", "LOST", "HALF_LOST", "VOID"]) {
      expect(loteAlcancaAposta("PENDING", destino), destino).toBe(true);
    }
  });

  /** Recusar aqui mataria o desfazer do toast, que age na recém-terminal. */
  it("o DESFAZER alcança justamente a aposta que acabou de virar terminal", () => {
    for (const terminal of [...FINAL_BET_STATUSES, "PENDING"]) {
      expect(loteAlcancaAposta(terminal, "PENDING"), terminal).toBe(true);
    }
  });
});

describe("a proteção precisa viver ACIMA do serviço (Postgres real)", () => {
  let db: TestDb;
  beforeAll(() => { db = createTestDb(); });
  afterAll(async () => { await db.dispose(); });
  beforeEach(async () => { await db.reset(); });

  async function apostaPendente() {
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Banca", slug: "banca", valorUnidade: 50 },
    });
    return db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        data: new Date("2026-08-17T19:00:00Z"),
        evento: "Santos vs Grêmio",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Santos",
        odds: 1.8,
        stake: 2,
        valorUnidade: 50,
        status: "PENDING",
      },
    });
  }

  /**
   * A prova de que a guarda é NECESSÁRIA: `applyBetStatusChange` é o único
   * caminho de settlement e ele aplica sem perguntar o estado atual — de
   * propósito, porque a re-liquidação legítima passa por ele. Logo, quem tem de
   * recusar é a BORDA do lote. Se um dia o serviço passar a recusar sozinho,
   * este teste falha e a decisão volta à mesa em vez de virar redundância muda.
   */
  it("applyBetStatusChange SOBRESCREVE resultado terminal — por isso a borda filtra", async () => {
    const bet = await apostaPendente();
    const opts = { client: db.prisma };
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "flashscore" }, opts);
    const automatico = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(automatico.status).toBe("WON");

    // O que o lote faria sem guarda: trocar um resultado automático correto.
    await applyBetStatusChange({ betId: bet.id, newStatus: "LOST", source: "manual:fabricio" }, opts);
    const sobrescrito = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(sobrescrito.status).toBe("LOST");
    expect(Number(sobrescrito.lucro)).toBeLessThan(0);

    // E o que a borda decide sobre esse mesmo par de estados.
    expect(loteAlcancaAposta("WON", "LOST")).toBe(false);
  });

  it("o desfazer continua alcançando a aposta liquidada — ida e volta no ledger", async () => {
    const bet = await apostaPendente();
    const opts = { client: db.prisma };
    await applyBetStatusChange({ betId: bet.id, newStatus: "WON", source: "manual:fabricio" }, opts);
    expect(loteAlcancaAposta("WON", "PENDING")).toBe(true);

    await applyBetStatusChange({ betId: bet.id, newStatus: "PENDING", source: "manual:fabricio" }, opts);
    const voltou = await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    expect(voltou.status).toBe("PENDING");
    expect(Number(voltou.lucro)).toBe(0);
  });
});
