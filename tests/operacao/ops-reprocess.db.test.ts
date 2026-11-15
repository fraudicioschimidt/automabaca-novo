import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../helpers/db";
import { getSharedBoss } from "@/src/infra/boss";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { QUEUES } from "@/src/infra/queue-contract";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import {
  countTransientBetsByChannel,
  reprocessarBetSharp,
  reprocessarTransitoriosDoCanal,
  transientChannelWhere,
} from "@/src/services/ops/reprocess";
import { enrichBetSharp, PrePinnacleRetryError } from "@/src/services/sharp/enrich/enrich-bet";
import { markEnrichDeadLettered } from "@/src/services/sharp/enrich/upsert-sharp";

let db: TestDb;
let boss: PgBoss;

beforeAll(async () => {
  db = createTestDb();
  boss = await getSharedBoss();
  await ensureQueueWithDeadLetter(boss, QUEUES.sharpEnrich);
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.dispose();
});

async function limparJobsDoArquivo(): Promise<void> {
  await db.prisma.$executeRaw`
    DELETE FROM pgboss.job
    WHERE name IN (${QUEUES.sharpEnrich}, ${`${QUEUES.sharpEnrich}.dlq`})
  `;
}

beforeEach(async () => {
  await db.reset();
  await limparJobsDoArquivo();
});
afterEach(limparJobsDoArquivo);

async function jobsNaFila(name: string): Promise<number> {
  const rows = await db.prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${name}
  `;
  return rows[0]?.n ?? 0;
}

describe("reprocessarTransitoriosDoCanal (pg-boss real)", () => {
  it("recupera identidade recente passada; aposta MATCHED não é mais falha transitória", async () => {
    const now = new Date("2026-07-12T12:00:00Z");
    const channelId = "-10099887766";
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Canal", slug: "canal-transitorio", telegramChannelId: BigInt(channelId) },
    });
    const seed = async (
      id: string,
      status: "PENDING" | "WON",
      sharp?: {
        identityStatus: "PENDING" | "MATCHED" | "UNMATCHED";
        noOddsReason?: string;
      },
      kickoff = new Date("2026-07-12T15:00:00Z"),
    ) => {
      const bet = await db.prisma.bet.create({
        data: {
          sportResolutionStatus: "CONFIRMED",
          sportResolvedAt: new Date(),
          bankrollId: bankroll.id,
          data: kickoff,
          evento: `${id} A vs B`,
          esporte: "Soccer",
          mercado: "Total",
          selecao: "Over 2.5",
          odds: 1.9,
          stake: 1,
          status,
          settledAt: status === "PENDING" ? null : kickoff,
          source: `telegram-channel:${channelId}`,
          sourceExternalId: id,
        },
      });
      if (sharp) {
        await db.prisma.betSharp.create({
          data: {
            betId: bet.id,
            identityStatus: sharp.identityStatus,
            confidence: 0,
            noOddsReason: sharp.noOddsReason,
          },
        });
      }
      return bet;
    };

    const pending = await seed("pending", "PENDING", { identityStatus: "PENDING" });
    await seed("line", "PENDING", { identityStatus: "MATCHED", noOddsReason: "sem_linha_atual" });
    await seed("historical-future", "PENDING", {
      identityStatus: "MATCHED",
      noOddsReason: "clv_only",
    });
    await seed("past-identity", "PENDING", { identityStatus: "PENDING" }, new Date("2026-07-12T11:00:00Z"));
    await seed("past-no-price", "PENDING", {
      identityStatus: "MATCHED",
      noOddsReason: "sem_linha_atual",
    }, new Date("2026-07-12T11:00:00Z"));
    await seed("permanent", "PENDING", { identityStatus: "MATCHED", noOddsReason: "unsupported_market" });
    await seed("unmatched", "PENDING", { identityStatus: "UNMATCHED" });
    await seed("settled", "WON", { identityStatus: "PENDING" });
    await enqueueSharpEnrich(boss, pending.id);

    expect(await db.prisma.bet.count({
      where: transientChannelWhere(
        channelId,
        now,
        new Date("2026-07-13T12:00:00Z"),
        false,
      ),
    })).toBe(1);
    // Identidade casada não tem preço de entrada a buscar: `line`,
    // `historical-future` e `past-no-price` ficam fora da conta.
    await expect(countTransientBetsByChannel([channelId], now)).resolves.toEqual([{
      resource: channelId,
      transientFailures: 2,
      preKickoffFailures: 1,
    }]);

    const result = await reprocessarTransitoriosDoCanal(channelId, "fabricio", now);
    expect(result).toEqual({ totalElegiveis: 2, elegiveis: 2, enfileiradas: 1, puladas: 1 });
    expect(await jobsNaFila(QUEUES.sharpEnrich)).toBe(2);
    const audit = await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "channel.reprocess_transient", resourceId: channelId },
    });
    expect(audit).toMatchObject({ actor: "fabricio" });
    expect(audit.details).toMatchObject({
      totalElegiveis: 2,
      elegiveis: 2,
      limite: 100,
      enfileiradas: 1,
      puladas: 1,
    });
  });

  it("declara o backlog completo e limita a ação aos 100 primeiros", async () => {
    const now = new Date("2026-07-12T12:00:00Z");
    const channelId = "-10011223344";
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Canal lote", slug: "canal-lote", telegramChannelId: BigInt(channelId) },
    });
    await db.prisma.bet.createMany({
      data: Array.from({ length: 101 }, (_, index) => ({
        id: `transient-batch-${index}`,
        bankrollId: bankroll.id,
        data: new Date(`2026-07-12T${String(13 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`),
        evento: `Evento ${index} A vs B`,
        esporte: "Soccer",
        mercado: "Total",
        selecao: "Over 2.5",
        odds: 1.9,
        stake: 1,
        status: "PENDING" as const,
        sportResolutionStatus: "CONFIRMED" as const,
        sportResolvedAt: new Date(),
        settledAt: null,
        source: `telegram-channel:${channelId}`,
        sourceExternalId: `batch-${index}`,
      })),
    });

    await expect(reprocessarTransitoriosDoCanal(channelId, "fabricio", now)).resolves.toEqual({
      totalElegiveis: 101,
      elegiveis: 100,
      enfileiradas: 100,
      puladas: 0,
    });
    expect(await jobsNaFila(QUEUES.sharpEnrich)).toBe(100);
  });
});

describe("reprocessarBetSharp (pg-boss real)", () => {
  const SHARP_ENCERRADA = {
    UNSUPPORTED: { identityStatus: "UNSUPPORTED", confidence: 0, noOddsReason: "unsupported_market" },
    UNMATCHED: { identityStatus: "UNMATCHED", confidence: 0, noOddsReason: "identidade_nao_casada", identityResolvedAt: new Date() },
  } as const;

  async function seedBet(slug: string, opts: {
    sharp?: keyof typeof SHARP_ENCERRADA; sharpMode?: "OFF"; status?: "WON";
  } = {}) {
    const bankroll = await db.prisma.bankroll.create({ data: { nome: slug, slug, sharpMode: opts.sharpMode } });
    return db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date("2026-07-12T17:00:00Z"),
        bankrollId: bankroll.id,
        registradoEm: new Date("2026-07-12T17:00:00Z"),
        data: new Date("2026-07-12T19:00:00Z"),
        evento: "Home FC vs Away FC",
        esporte: "Soccer",
        mercado: "Total",
        selecao: "Over 2.5",
        odds: 1.9,
        stake: 1,
        status: opts.status ?? "PENDING",
        settledAt: opts.status ? new Date("2026-07-12T21:00:00Z") : null,
        ...(opts.sharp ? { sharp: { create: SHARP_ENCERRADA[opts.sharp] } } : {}),
      },
    });
  }

  it("reabre a identidade que a dead-letter encerrou, e o enrich volta a consultar o fornecedor", async () => {
    // Capturada às 17h para o jogo das 19h; as 12 tentativas acabam perto das 21h.
    const bet = await seedBet("dlq-reprocesso");
    await markEnrichDeadLettered(bet.id, new Date("2026-07-12T21:05:00Z"));
    expect((await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } })).identityStatus).toBe("UNMATCHED");

    await reprocessarBetSharp(bet.id, "fabricio");

    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ identityStatus: "PENDING", identityResolvedAt: null });
    expect(await jobsNaFila(QUEUES.sharpEnrich)).toBe(1);
    expect(await db.prisma.auditEvent.findFirstOrThrow({
      where: { action: "bet_sharp.reopen_unmatched", resourceId: bet.id },
    })).toMatchObject({ actor: "fabricio", details: { de: "UNMATCHED", para: "PENDING", origem: "ops-reprocess" } });

    // O fornecedor não achou o jogo desta vez: o enrich espera a próxima rodada, mas consultou.
    const query = vi.fn(async () => []);
    await expect(enrichBetSharp({ betId: bet.id }, { query: query as never, now: new Date("2026-07-12T21:10:00Z") }))
      .rejects.toBeInstanceOf(PrePinnacleRetryError);
    expect(query).toHaveBeenCalled();
  });

  it("tira o motivo terminal da identidade reaberta", async () => {
    // Sem isso a tela diria "nenhum provider casou" enquanto o enrich tenta de novo.
    const bet = await seedBet("dlq-motivo", { sharp: "UNMATCHED" });
    await reprocessarBetSharp(bet.id, "fabricio");
    expect(await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } }))
      .toMatchObject({ identityStatus: "PENDING", noOddsReason: null });
  });

  it.each([
    ["identidade sem cobertura", { sharp: "UNSUPPORTED" }, "UNSUPPORTED"],
    // O enrich sairia sem buscar (banca OFF; liquidada há mais de 30 dias) e a identidade ficaria PENDING para sempre.
    ["banca desligada", { sharp: "UNMATCHED", sharpMode: "OFF" }, "UNMATCHED"],
    ["liquidada fora da recuperação de 30 dias", { sharp: "UNMATCHED", status: "WON" }, "UNMATCHED"],
  ] as const)("%s continua encerrada", async (_caso, opts, status) => {
    const bet = await seedBet("dlq-encerrada", opts);
    await reprocessarBetSharp(bet.id, "fabricio");
    expect((await db.prisma.betSharp.findUniqueOrThrow({ where: { betId: bet.id } })).identityStatus).toBe(status);
    expect(await db.prisma.auditEvent.count({ where: { action: "bet_sharp.reopen_unmatched" } })).toBe(0);
  });
});
