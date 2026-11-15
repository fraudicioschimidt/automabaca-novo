import type { PrismaClient } from "../../src/generated/prisma/client";
import { prisma as basePrisma } from "@/src/infra/prisma";
import { clearBridgeCatalogCache } from "@/src/providers/bridgeodds/catalog";

// URL-helper fica em db-url (sem prisma) p/ o global-setup importar sem iniciar o pool.
;

export type TestDb = {
  prisma: PrismaClient;
  dispose: () => Promise<void>;
  /** Limpa todas as tabelas de negócio (mantém schema/migrations). */
  reset: () => Promise<void>;
};

/**
 * Ordem: filhos antes dos pais (FKs sem ON DELETE CASCADE em tudo).
 * IDs são UUID — não precisa RESTART IDENTITY.
 */
const BUSINESS_TABLES = [
  "closing_price_observations",
  "closing_price_watches",
  "closing_price_budgets",
  "price_archive_observations",
  "telegram_reaction_states",
  "team_tipster_names",
  "team_tipster_name_waits",
  "team_card_evidence",
  "team_cards",
  "catalog_game_links",
  "bet_player_props",
  "player_match_appearances",
  "player_provider_aliases",
  "player_identities",
  "operational_actions",
  "auth_device_sessions",
  "auth_session_state",
  "movimentacoes",
  "settlement_events",
  "training_cases",
  "bet_sharp",
  "bet_closing",
  "ia_judge_suggestions",
  "ia_judge_cooldowns",
  "retired_bet_sources",
  "absorbed_bet_sources",
  "creation_receipts",
  "bets",
  "capture_financial_contexts",
  "manual_settlement_receipts",
  "contas_bankrolls",
  "contas",
  "bankrolls",
  "mercados_alias",
  "mercados_padrao",
  "audit_events",
  "operational_metrics",
  "market_segment_policies",
  "provider_budget_reservations",
  "provider_caches",
  "provider_request_gates",
  "provider_budgets",
  "provider_circuits",
  "telegram_dm_drafts",
  "telegram_media_albums",
  "telegram_channel_activity",
  "llm_sticky_preferences",
  "dashboard_visits",
];

async function resetTables(attempts = 3): Promise<void> {
  const sql = BUSINESS_TABLES.map((t) => `DELETE FROM "${t}"`).join("; ");
  for (let i = 1; ; i++) {
    try {
      await basePrisma.$executeRawUnsafe(sql);
      return;
    } catch (err) {
      if (i >= attempts) throw err;
    }
  }
}

/** Completa provas de preço sintéticas, preservando valores e provas explícitos. */
type FixtureRecord = Record<string, unknown>;

const TEST_PRICE_OBSERVED_AT = new Date(0);

function scalar(value: unknown): unknown {
  if (value && typeof value === "object" && "set" in value) {
    return (value as { set?: unknown }).set;
  }
  return value;
}

function positiveOdd(value: unknown, fallback = 2): number {
  const parsed = Number(scalar(value));
  return Number.isFinite(parsed) && parsed > 1 ? parsed : fallback;
}

function fixtureReference(data: FixtureRecord): string {
  const provider = String(scalar(data.provider) ?? "bridgeodds");
  const matchId = String(scalar(data.providerMatchId) ?? "test-fixture");
  if (provider === "pinnacle17") {
    const numericId = /^\d+$/.test(matchId) && Number(matchId) > 0 ? matchId : "1";
    return `pinnacle17:v1:${numericId}:0:moneyline:ml:home`;
  }
  return `bridgeodds:v1:${matchId.replaceAll(":", "-") || "test-fixture"}`;
}

function fixtureSnapshot(rawOdd: number, fairOdd: number): FixtureRecord {
  const exponent = Math.log(1 / fairOdd) / Math.log(1 / rawOdd);
  const otherProbability = Math.pow(1 - 1 / fairOdd, 1 / exponent);
  const otherOdd = 1 / otherProbability;
  return {
    version: 1,
    combination: "single",
    components: [{ lineQ: null, rawOdds: [rawOdd, otherOdd], selectedIndex: 0, devig: "power" }],
  };
}

async function completeClosingPriceFixture(data: FixtureRecord, odds?: unknown, betId?: unknown): Promise<void> {
  const hasPrice = [
    "closingOdd", "closingRawOdd", "closingPriceSnapshot", "clv", "closingMaxBet",
    "closingMaxBetCurrency",
  ].some((key) => scalar(data[key]) != null) || scalar(data.clvReliable) === true;
  if (!hasPrice) return;

  data.provider ??= "bridgeodds";
  if (odds === undefined) {
    const id = scalar(data.betId) ?? betId ?? (data.bet as { connect?: { id?: string } } | undefined)?.connect?.id;
    if (typeof id === "string") odds = (await basePrisma.bet.findUnique({ where: { id }, select: { odds: true } }))?.odds;
  }
  const bookOdd = positiveOdd(odds);
  const clv = Number(scalar(data.clv));
  const impliedFair = scalar(data.clv) != null && Number.isFinite(clv) && clv > -100
    ? bookOdd / (1 + clv / 100) : 2;
  const fairOdd = positiveOdd(data.closingOdd, impliedFair > 1 ? impliedFair : 2);
  const rawOdd = positiveOdd(data.closingRawOdd, fairOdd);
  data.closingRawOdd ??= rawOdd;
  data.closingOdd ??= fairOdd;
  data.closingPriceSnapshot ??= fixtureSnapshot(rawOdd, fairOdd);
  data.closingPriceReference ??= fixtureReference(data);
  data.closingPriceObservedAt ??= scalar(data.fetchedAt) ?? TEST_PRICE_OBSERVED_AT;
  if (scalar(data.clvReliable) === true && data.clv === undefined) data.clv = (bookOdd / fairOdd - 1) * 100;
}

async function completeNestedPriceFixtures(data: FixtureRecord, betId?: unknown): Promise<void> {
  for (const [field, complete] of [
    ["closing", completeClosingPriceFixture],
  ] as const) {
    const relation = data[field];
    if (!relation || typeof relation !== "object") continue;
    const nested = relation as FixtureRecord;
    for (const operation of ["create", "update", "upsert"] as const) {
      const payload = nested[operation];
      if (!payload || typeof payload !== "object") continue;
      if (operation === "upsert") {
        const upsert = payload as FixtureRecord;
        if (upsert.create && typeof upsert.create === "object") await complete(upsert.create as FixtureRecord, data.odds, betId);
        if (upsert.update && typeof upsert.update === "object") await complete(upsert.update as FixtureRecord, data.odds, betId);
      } else {
        await complete(payload as FixtureRecord, data.odds, betId);
      }
    }
  }
}

function withTestFixtures(client: PrismaClient, strictPriceProvenance: boolean): PrismaClient {
  return client.$extends({
    query: {
      bet: {
        async create({ args, query }) {
          const data = args.data as FixtureRecord & {
            valorUnidade?: unknown;
            bankrollId?: string;
            bankroll?: { connect?: { id?: string } };
            sportResolutionStatus?: unknown;
            sportResolvedAt?: unknown;
          };
          if (data.valorUnidade === undefined) {
            const bankrollId =
              data.bankrollId ?? data.bankroll?.connect?.id ?? undefined;
            if (bankrollId) {
              const br = await basePrisma.bankroll.findUnique({
                where: { id: bankrollId },
                select: { valorUnidade: true },
              });
              if (br) data.valorUnidade = br.valorUnidade;
            }
          }
          if (!strictPriceProvenance) await completeNestedPriceFixtures(data);
          return query(args);
        },
        async update({ args, query }) {
          if (!strictPriceProvenance) await completeNestedPriceFixtures(args.data as FixtureRecord, args.where.id);
          return query(args);
        },
        async upsert({ args, query }) {
          if (!strictPriceProvenance) {
            await completeNestedPriceFixtures(args.create as FixtureRecord, args.where.id);
            await completeNestedPriceFixtures(args.update as FixtureRecord, args.where.id);
          }
          return query(args);
        },
      },
      betClosing: {
        async create({ args, query }) {
          if (!strictPriceProvenance) await completeClosingPriceFixture(args.data as FixtureRecord);
          return query(args);
        },
        async update({ args, query }) {
          if (!strictPriceProvenance) await completeClosingPriceFixture(args.data as FixtureRecord, undefined, args.where.betId);
          return query(args);
        },
        async upsert({ args, query }) {
          if (!strictPriceProvenance) {
            await completeClosingPriceFixture(args.create as FixtureRecord, undefined, args.where.betId);
            await completeClosingPriceFixture(args.update as FixtureRecord, undefined, args.where.betId);
          }
          return query(args);
        },
        async createMany({ args, query }) {
          if (!strictPriceProvenance) {
            const rows = Array.isArray(args.data) ? args.data : [args.data];
            const bets = await basePrisma.bet.findMany({ where: { id: { in: rows.map((row) => row.betId) } }, select: { id: true, odds: true } });
            const oddsById = new Map(bets.map((bet) => [bet.id, bet.odds]));
            for (const row of rows) await completeClosingPriceFixture(row as FixtureRecord, oddsById.get(row.betId));
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

export function createTestDb(options: { strictPriceProvenance?: boolean } = {}): TestDb {
  // MESMO client dos serviços (pool único por worker), com extensão de snapshot
  // só nos creates de teste. O afterAll precisa desconectá-lo explicitamente:
  // o Vitest pode liberar o pool id para o próximo fork antes de o processo
  // anterior terminar, sobretudo enquanto coleta cobertura. Deixar a conexão
  // ao mesmo banco viva transforma o reset do próximo arquivo em lock cruzado.
  const prisma = withTestFixtures(basePrisma, options.strictPriceProvenance === true);
  return {
    prisma,
    dispose: async () => {
      await basePrisma.$disconnect();
    },
    reset: async () => {
      // O catálogo BridgeOdds é cache de PROCESSO: sem limpar junto do banco, um
      // caso que injetou fixtures deixa o dia em memória e o caso seguinte (que
      // injeta mock vazio ou conta GETs) mede o lixo do anterior.
      clearBridgeCatalogCache();
      await resetTables();
    },
  };
}

/**
 * A liquidação trava a aposta e depois a conta. Aqui outra transação faz o
 * mesmo em dois tempos: trava `betId`, deixa `run` começar e esperar por ela,
 * e só então pede a conta. Se `run` já segurava a conta (estorno antes de
 * travar a aposta), o pedido esbarra no `lock_timeout` e a promessa rejeita:
 * em produção seria o ciclo que o PostgreSQL desfaz como deadlock. A
 * transação de fora desfaz tudo o que fez, e `run` termina sozinha.
 */
export async function settleRaceAgainst<T>(
  locked: { betId: string; contaId: string },
  run: () => Promise<T>,
): Promise<T> {
  const rollback = new Error("liquidação simulada desfeita");
  let running: Promise<T> | undefined;
  try {
    await basePrisma.$transaction(async (settlement) => {
      await settlement.$queryRaw`SELECT id FROM bets WHERE id = ${locked.betId} FOR NO KEY UPDATE`;
      running = run();
      running.catch(() => undefined);
      await waitForLockWait();
      await settlement.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
      await settlement.$executeRaw`UPDATE contas SET "saldoAtual" = "saldoAtual" WHERE id = ${locked.contaId}`;
      throw rollback;
    }, { timeout: 15_000 });
  } catch (error) {
    if (error !== rollback) {
      await running?.catch(() => undefined);
      throw error;
    }
  }
  return running!;
}

async function waitForLockWait(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await basePrisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error("a transação concorrente não chegou a esperar pela aposta travada");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
