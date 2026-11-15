import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { findBetsParaReviver } from "@/src/services/sharp/revive";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { createBoss } from "@/src/infra/boss";
import { enrichSingletonKey, QUEUES } from "@/src/infra/queue-contract";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { TRAINING_REVIEW_COOLDOWN_KEY } from "@/src/services/sharp/training-resolve";
import {
  CADENCIA_HISTORICAL_MS,
  CADENCIA_LONGE_MS,
  CADENCIA_PERTO_MS,
} from "@/src/domain/enrich-cadence";

/**
 * Seleção do revival contra Postgres real: quem merece nova tentativa de
 * enrich, quem não, e a cadência adaptativa (≤8h 1h / longe 2h). Aposta
 * MATCHED só volta enquanto espera a referência de fechamento da Pinnacle17.
 */

let db: TestDb;
const AGORA = new Date("2026-06-12T12:00:00Z");
const horas = (n: number) => new Date(AGORA.getTime() + n * 3_600_000);

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

async function seedBankroll(
  sharpMode: "CLV_ONLY" | "IDENTITY_ONLY" | "OFF",
  suffix = "",
) {
  const id = `${sharpMode.toLowerCase()}${suffix}`;
  return db.prisma.bankroll.create({
    data: { nome: `B-${id}`, slug: `b-${id}`, sharpMode },
  });
}

async function seedBet(params: {
  bankrollId: string;
  kickoff: Date;
  status?: "PENDING" | "WON" | "LOST";
  deleted?: boolean;
  kickoffInferido?: boolean;
  registradoEm?: Date;
  esporte?: string;
  mercado?: string;
  selecao?: string;
  sharp?: { identityStatus: string; noOddsReason?: string | null; provider?: string };
}) {
  return db.prisma.bet.create({
    data: {
      sportResolutionStatus: "CONFIRMED",
      sportResolvedAt: new Date(),
      settledAt: (params.status ?? "PENDING") === "PENDING" ? null : params.kickoff,
      bankrollId: params.bankrollId,
      data: params.kickoff,
      evento: "Time A vs Time B",
      esporte: params.esporte ?? "Soccer",
      mercado: params.mercado ?? "Total",
      selecao: params.selecao ?? "Under 2.5",
      odds: 1.9,
      stake: 1,
      status: params.status ?? "PENDING",
      kickoffInferido: params.kickoffInferido ?? false,
      registradoEm: params.registradoEm,
      deletedAt: params.deleted ? new Date() : null,
      sharp: params.sharp
        ? {
            create: {
              identityStatus: params.sharp.identityStatus as never,
              confidence: 50,
              noOddsReason: params.sharp.noOddsReason ?? null,
              provider: params.sharp.provider,
            },
          }
        : undefined,
    },
    select: { id: true },
  });
}

/** Minuto logo ANTES de a cadência liberar a próxima tentativa. */
const antesDaVez = (cadenciaMs: number) => cadenciaMs / 60_000 - 1;
/** Minuto logo DEPOIS de a cadência liberar. */
const naVez = (cadenciaMs: number) => cadenciaMs / 60_000 + 1;

/** Envelhece a "última tentativa" (sharp.updatedAt) em N minutos antes de AGORA. */
async function tentativaHaMinutos(betId: string, minutos: number) {
  const quando = new Date(AGORA.getTime() - minutos * 60_000);
  await db.prisma.$executeRaw`
    UPDATE bet_sharp SET "updatedAt" = ${quando} WHERE "betId" = ${betId}
  `;
}

describe("findBetsParaReviver", () => {
  it.each(["queue", "review"] as const)("avança depois de uma página inteira em %s", async (blockedBy) => {
    const full = await seedBankroll("CLV_ONLY");
    const boss = createBoss();
    await boss.start();
    await ensureQueueWithDeadLetter(boss, QUEUES.sharpEnrich, { policy: "exclusive" });
    try {
      for (let i = 0; i < 75; i++) {
        const first = await seedBet({ bankrollId: full.id, kickoff: horas(1) });
        if (blockedBy === "queue") await boss.send(QUEUES.sharpEnrich, { betId: first.id }, { singletonKey: enrichSingletonKey(first.id) });
        else await db.prisma.iaJudgeCooldown.create({ data: { key: TRAINING_REVIEW_COOLDOWN_KEY(first.id), expiresAt: horas(1) } });
      }
      const eligible = [];
      for (let i = 0; i < 26; i++) eligible.push(await seedBet({ bankrollId: full.id, kickoff: horas(2) }));
      expect(await findBetsParaReviver(AGORA)).toEqual(eligible.map((bet) => bet.id).sort());
    } finally { await boss.stop({ graceful: false }); }
  });

  it("preenche o lote com apostas elegíveis depois de uma página em cadência", async () => {
    const full = await seedBankroll("CLV_ONLY");
    for (let i = 0; i < 75; i++) {
      const first = await seedBet({ bankrollId: full.id, kickoff: horas(1), sharp: { identityStatus: "PENDING" } });
      await tentativaHaMinutos(first.id, 1);
    }
    const untouched = [];
    for (let i = 0; i < 26; i++) {
      untouched.push(await seedBet({ bankrollId: full.id, kickoff: horas(2) }));
    }
    // Há 101 candidatas: adaptiveBatchSize retorna 75. As 75 primeiras
    // ainda esperam a cadência; o lote precisa avançar até as outras 26.
    expect(await findBetsParaReviver(AGORA)).toEqual(untouched.map((bet) => bet.id).sort());
  });

  it("não revive aposta apagada junto com a bankroll", async () => {
    const full = await seedBankroll("CLV_ONLY");
    const bet = await seedBet({ bankrollId: full.id, kickoff: horas(2) });
    await db.prisma.bankroll.delete({ where: { id: full.id } });

    expect(await findBetsParaReviver(AGORA)).not.toContain(bet.id);
  });

  it("breaker Bridge aberto pausa só contratos Bridge; lacunas continuam", async () => {
    const full = await seedBankroll("CLV_ONLY");
    const bridge = await seedBet({ bankrollId: full.id, kickoff: horas(2) });
    const fallback = await seedBet({
      bankrollId: full.id,
      kickoff: horas(3),
      esporte: "Tennis",
      mercado: "Money Line – Match",
      selecao: "Time A",
    });
    await db.prisma.providerCircuit.create({
      data: {
        provider: "bridgeodds",
        state: "OPEN",
        failures: 5,
        openedAt: new Date(),
      },
    });

    const ids = await findBetsParaReviver(AGORA);
    expect(ids).not.toContain(bridge.id);
    expect(ids).toContain(fallback.id);
  });

  describe("com a Pinnacle17 ligada", () => {
    beforeEach(() => {
      vi.stubEnv("PINNACLE17_MODE", "on");
      vi.stubEnv("PINNACLE17_RAPIDAPI_KEY", "chave-de-teste");
      resetEnvCacheForTests();
    });
    afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });

    it("breaker Bridge aberto não pausa a aposta que o enrich busca antes na Pinnacle17", async () => {
      const full = await seedBankroll("CLV_ONLY");
      // Futebol Total é da matriz da Bridge, mas a Pinnacle17 também dá a identidade.
      const soccer = await seedBet({ bankrollId: full.id, kickoff: horas(2) });
      await db.prisma.providerCircuit.create({
        data: { provider: "bridgeodds", state: "OPEN", failures: 5, openedAt: new Date() },
      });

      expect(await findBetsParaReviver(AGORA)).toContain(soccer.id);
    });
  });

  it("acorda: sem sharp; UNMATCHED terminal e MATCHED NÃO revivem", async () => {
    const full = await seedBankroll("CLV_ONLY");
    const semSharp = await seedBet({ bankrollId: full.id, kickoff: horas(2) });
    const unmatched = await seedBet({
      bankrollId: full.id,
      kickoff: horas(3),
      sharp: { identityStatus: "UNMATCHED" },
    });
    const matched = await seedBet({
      bankrollId: full.id,
      kickoff: horas(4),
      sharp: { identityStatus: "MATCHED" },
    });
    await tentativaHaMinutos(unmatched.id, 15);
    await tentativaHaMinutos(matched.id, naVez(CADENCIA_PERTO_MS));

    const ids = await findBetsParaReviver(AGORA);
    expect(ids).toEqual([semSharp.id]);
    expect(ids).not.toContain(unmatched.id);
  });

  it("deixa dormir: fora da janela, identidade resolvida, OFF, finalizada, removida", async () => {
    const full = await seedBankroll("CLV_ONLY");
    const idOnly = await seedBankroll("IDENTITY_ONLY");
    const off = await seedBankroll("OFF");
    const foraDaJanela = await seedBet({
      bankrollId: full.id,
      kickoff: horas(-31 * 24), // além dos 30 dias de recuperação
      sharp: { identityStatus: "PENDING" },
    });
    const casada = await seedBet({
      bankrollId: full.id,
      kickoff: horas(2),
      sharp: { identityStatus: "MATCHED" },
    });
    const casadaAposKickoff = await seedBet({
      bankrollId: full.id,
      kickoff: horas(-1),
      sharp: { identityStatus: "MATCHED" },
    });
    const idOnlyCasada = await seedBet({
      bankrollId: idOnly.id,
      kickoff: horas(2),
      sharp: { identityStatus: "MATCHED" },
    });
    for (const b of [foraDaJanela, casada, casadaAposKickoff, idOnlyCasada]) {
      await tentativaHaMinutos(b.id, 60);
    }
    await seedBet({
      bankrollId: full.id,
      kickoff: horas(2),
      status: "WON",
      sharp: { identityStatus: "MATCHED" },
    });
    await seedBet({ bankrollId: full.id, kickoff: horas(2), deleted: true });
    await seedBet({ bankrollId: off.id, kickoff: horas(2) }); // OFF nunca revive

    expect(await findBetsParaReviver(AGORA)).toEqual([]);
  });

  it("recupera identidade de liquidadas recentes, sem reabrir resolvidas ou antigas", async () => {
    const full = await seedBankroll("CLV_ONLY");
    const semSharp = await seedBet({
      bankrollId: full.id,
      kickoff: horas(-6),
      status: "WON",
    });
    const pending = await seedBet({
      bankrollId: full.id,
      kickoff: horas(-12),
      status: "LOST",
      sharp: { identityStatus: "PENDING" },
    });
    const resolvida = await seedBet({
      bankrollId: full.id,
      kickoff: horas(-18),
      status: "WON",
      sharp: { identityStatus: "MATCHED" },
    });
    const recuperavel = await seedBet({
      bankrollId: full.id,
      kickoff: horas(-20 * 24),
      status: "LOST",
    });
    const antiga = await seedBet({
      bankrollId: full.id,
      kickoff: horas(-31 * 24),
      status: "LOST",
    });
    await tentativaHaMinutos(pending.id, naVez(CADENCIA_HISTORICAL_MS));

    expect(await findBetsParaReviver(AGORA)).toEqual([recuperavel.id, pending.id, semSharp.id]);
    expect(await findBetsParaReviver(AGORA)).not.toContain(resolvida.id);
    expect(await findBetsParaReviver(AGORA)).not.toContain(antiga.id);
  });

  it("prioriza PENDING quente quando liquidadas antigas excedem o lote", async () => {
    const full = await seedBankroll("CLV_ONLY");
    await db.prisma.bet.createMany({
      data: Array.from({ length: 160 }, (_, index) => ({
        sportResolutionStatus: "CONFIRMED" as const,
        sportResolvedAt: new Date(),
        settledAt: horas(-24),
        id: `settled-backlog-${index}`,
        bankrollId: full.id,
        data: horas(-24),
        evento: `Settled ${index} A vs B`,
        esporte: "Soccer",
        mercado: "Total",
        selecao: "Under 2.5",
        odds: 1.9,
        stake: 1,
        status: "WON" as const,
      })),
    });
    const pending = await seedBet({
      bankrollId: full.id,
      kickoff: horas(2),
    });

    expect(await findBetsParaReviver(AGORA)).toContain(pending.id);
  });

  it("cadência adaptativa: perto 1h; longe 2h", async () => {
    const clvOnly = await seedBankroll("CLV_ONLY", "-clv");
    const idOnly = await seedBankroll("IDENTITY_ONLY", "-id");
    const pertoRecente = await seedBet({
      bankrollId: clvOnly.id,
      kickoff: horas(2),
      sharp: { identityStatus: "PENDING" },
    });
    const pertoAntiga = await seedBet({
      bankrollId: clvOnly.id,
      kickoff: horas(3),
      sharp: { identityStatus: "PENDING" },
    });
    const longeRecente = await seedBet({
      bankrollId: clvOnly.id,
      kickoff: horas(20),
      sharp: { identityStatus: "PENDING" },
    });
    const longeAntiga = await seedBet({
      bankrollId: clvOnly.id,
      kickoff: horas(21),
      sharp: { identityStatus: "PENDING" },
    });
    const idPertoAntiga = await seedBet({
      bankrollId: idOnly.id,
      kickoff: horas(4),
      sharp: { identityStatus: "PENDING" },
    });
    await tentativaHaMinutos(pertoRecente.id, antesDaVez(CADENCIA_PERTO_MS));
    await tentativaHaMinutos(pertoAntiga.id, naVez(CADENCIA_PERTO_MS));
    await tentativaHaMinutos(longeRecente.id, antesDaVez(CADENCIA_LONGE_MS));
    await tentativaHaMinutos(longeAntiga.id, naVez(CADENCIA_LONGE_MS));
    await tentativaHaMinutos(idPertoAntiga.id, naVez(CADENCIA_PERTO_MS));

    expect(await findBetsParaReviver(AGORA)).toEqual([
      pertoAntiga.id,
      idPertoAntiga.id,
      longeAntiga.id,
    ]);
  });

  it("MATCHED sem a Bridge como fornecedor não revive por motivo nenhum", async () => {
    const full = await seedBankroll("CLV_ONLY");
    const bets = [];
    for (const [i, noOddsReason] of ["sem_linha_atual", "line_mismatch", "clv_only", "unsupported_market"].entries()) {
      bets.push(await seedBet({
        bankrollId: full.id,
        kickoff: horas(4 + i),
        sharp: { identityStatus: "MATCHED", noOddsReason },
      }));
    }
    for (const b of bets) await tentativaHaMinutos(b.id, naVez(CADENCIA_PERTO_MS));

    expect(await findBetsParaReviver(AGORA)).toEqual([]);
  });

  it("casada pela Bridge à espera da referência de fechamento da Pinnacle17 revive até o kickoff", async () => {
    const full = await seedBankroll("CLV_ONLY");
    const identityOnly = await seedBankroll("IDENTITY_ONLY");
    const bridge = (noOddsReason: string | null, kickoff = horas(4), bankrollId = full.id, identityStatus = "MATCHED") =>
      seedBet({ bankrollId, kickoff, sharp: { identityStatus, noOddsReason, provider: "bridgeodds" } });
    const esperando = await bridge("market_not_listed");
    const vinculada = await bridge(null, horas(5), full.id, "MANUAL");
    const dormem = [
      await bridge("clv_only"),
      await bridge("unsupported_market"),
      await bridge("market_not_listed", horas(-1)),
      await bridge("market_not_listed", horas(4), identityOnly.id),
      await seedBet({ bankrollId: full.id, kickoff: horas(4), sharp: { identityStatus: "MATCHED", noOddsReason: "no_prices", provider: "pinnacle17" } }),
    ];
    for (const b of [esperando, vinculada, ...dormem]) await tentativaHaMinutos(b.id, naVez(CADENCIA_PERTO_MS));

    expect(await findBetsParaReviver(AGORA)).toEqual([esperando.id, vinculada.id]);

    await tentativaHaMinutos(esperando.id, antesDaVez(CADENCIA_PERTO_MS));
    expect(await findBetsParaReviver(AGORA)).toEqual([vinculada.id]);
  });

  it("PENDING com kickoff 'no passado' recente ainda acorda (post sem hora vira meia-noite)", async () => {
    const full = await seedBankroll("CLV_ONLY");
    const bet = await seedBet({
      bankrollId: full.id,
      kickoff: horas(-12),
      sharp: { identityStatus: "PENDING" },
    });
    await tentativaHaMinutos(bet.id, naVez(CADENCIA_PERTO_MS));
    expect(await findBetsParaReviver(AGORA)).toEqual([bet.id]);
  });

  it("miss de kickoff volta a tentar e a janela cobre o encerramento do dia", async () => {
    const full = await seedBankroll("CLV_ONLY");
    const future = await seedBet({
      bankrollId: full.id,
      kickoff: horas(2),
      kickoffInferido: true,
      registradoEm: horas(-4),
      sharp: { identityStatus: "PENDING" },
    });
    const past = await seedBet({
      bankrollId: full.id,
      kickoff: horas(-25),
      kickoffInferido: true,
      registradoEm: horas(-4),
      sharp: { identityStatus: "PENDING" },
    });
    for (const bet of [future, past]) {
      await tentativaHaMinutos(bet.id, naVez(CADENCIA_PERTO_MS));
    }

    expect(await findBetsParaReviver(AGORA)).toEqual([past.id, future.id]);
  });
});
