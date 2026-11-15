import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../helpers/db";
import { CADENCIA_PERTO_MS } from "@/src/domain/enrich-cadence";
import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { enrichBets } from "@/src/jobs/sharp-jobs";
import { applyBetEdit } from "@/src/services/bets/edit";
import { findBetsParaReviver } from "@/src/services/sharp/revive";

/**
 * `sharp.enrich` que termina no breaker da Bridge, contra Postgres real: a
 * tentativa gravada decide quando o revival volta a buscar a aposta.
 */
const enrich = vi.hoisted(() => vi.fn());
vi.mock("@/src/services/sharp/enrich/enrich-bet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/services/sharp/enrich/enrich-bet")>()),
  enrichBetSharp: enrich,
}));

let db: TestDb;
const boss = {} as PgBoss;
const job = (betId: string) => [{ id: `job-${betId}`, data: { betId, origem: "revive" } }] as never;
const minutosDepois = (minutos: number) => new Date(Date.now() + minutos * 60_000);

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  enrich.mockReset();
});

async function seedBet(sharp?: { identityStatus: "PENDING"; confidence: number; updatedAt: Date }) {
  const bankroll = await db.prisma.bankroll.create({ data: { nome: "Breaker", slug: "breaker", sharpMode: "CLV_ONLY" } });
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED", sportResolvedAt: new Date(), bankrollId: bankroll.id,
      // Duas horas até o jogo: a cadência do revival é a de perto do kickoff.
      data: minutosDepois(120), evento: "Time A vs Time B", esporte: "Soccer", competicao: "Liga", pais: "BR",
      mercado: "Moneyline", selecao: "Time A", odds: 1.9, stake: 1, status: "PENDING",
      ...(sharp ? { sharp: { create: sharp } } : {}),
    },
  });
}

describe("enrichBets com o breaker da Bridge aberto", () => {
  it("a aposta volta ao revival na cadência, não no cron seguinte", async () => {
    const bet = await seedBet();
    expect(await findBetsParaReviver(new Date())).toContain(bet.id);
    enrich.mockRejectedValueOnce(new CircuitOpenError("bridgeodds"));

    await expect(enrichBets(job(bet.id), boss)).resolves.toBeUndefined();

    expect(await findBetsParaReviver(minutosDepois(5))).not.toContain(bet.id);
    expect(await findBetsParaReviver(minutosDepois(CADENCIA_PERTO_MS / 60_000 + 1))).toContain(bet.id);
  });

  it("a aposta editada no meio do enrich não ganha a marca e volta ao revival logo", async () => {
    // A tentativa anterior já passou da cadência: o revival mandou este job.
    const bet = await seedBet({ identityStatus: "PENDING", confidence: 0, updatedAt: minutosDepois(-90) });
    enrich.mockImplementationOnce(async () => {
      // A edição troca os termos e apaga a identidade que o enrich buscava.
      await applyBetEdit({
        betId: bet.id,
        actor: "test",
        fields: {
          data: bet.data, evento: bet.evento, esporte: bet.esporte, competicao: bet.competicao, pais: bet.pais,
          mercado: bet.mercado, selecao: "Time B", odds: 2.1, stake: 1,
        },
      });
      throw new CircuitOpenError("bridgeodds");
    });

    await expect(enrichBets(job(bet.id), boss)).resolves.toBeUndefined();

    expect(await db.prisma.betSharp.count({ where: { betId: bet.id } })).toBe(0);
    expect(await findBetsParaReviver(minutosDepois(5))).toContain(bet.id);
  });

  it("a aposta removida no meio do enrich conclui o job sem marca", async () => {
    const bet = await seedBet();
    enrich.mockImplementationOnce(async () => {
      await db.prisma.bet.update({ where: { id: bet.id }, data: { deletedAt: new Date() } });
      throw new CircuitOpenError("bridgeodds");
    });

    await expect(enrichBets(job(bet.id), boss)).resolves.toBeUndefined();

    expect(await db.prisma.betSharp.count({ where: { betId: bet.id } })).toBe(0);
  });
});
