import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedMercados } from "@/prisma/seed-mercados";
import { createTestDb, type TestDb } from "../helpers/db";

const PLAYER_MARKETS = [
  "Player Assists",
  "Player Cards",
  "Player Fouls",
  "Player Fouls Suffered",
  "Player Interceptions",
  "Player Key Passes",
  "Player Offsides",
  "Player Saves",
  "Player Shots",
  "Player Shots on Target",
  "Player Tackles",
] as const;

let db: TestDb;

beforeAll(() => {
  db = createTestDb();
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await db.reset();
});

describe("catálogo Pinnacle estrito no deploy canônico (PostgreSQL real)", () => {
  it("o seed desativa Player* legado sem apagar apostas históricas e é idempotente", async () => {
    await db.prisma.mercadoPadrao.createMany({
      data: PLAYER_MARKETS.map((nome) => ({ nome, ativo: true })),
    });
    const primeira = await seedMercados(db.prisma);
    const segunda = await seedMercados(db.prisma);

    expect(segunda).toEqual(primeira);
    const mercados = await db.prisma.mercadoPadrao.findMany({
      where: { nome: { in: [...PLAYER_MARKETS] } },
      orderBy: { nome: "asc" },
    });
    expect(mercados.map((mercado) => mercado.nome)).toEqual(
      [...PLAYER_MARKETS].sort(),
    );
    expect(mercados.every((mercado) => !mercado.ativo)).toBe(true);
    expect(await db.prisma.mercadoAlias.count({
      where: { mercadoPadraoId: { in: mercados.map((mercado) => mercado.id) } },
    })).toBe(0);

    const ativos = await db.prisma.mercadoPadrao.count({ where: { ativo: true } });
    expect(ativos).toBe(primeira.mercados);
  });

  it("desativa qualquer padrão legado fora do seed sem apagar alias nem aposta histórica", async () => {
    const legacyName = "Mercado Legado Arbitrário";
    const legacy = await db.prisma.mercadoPadrao.create({
      data: {
        nome: legacyName,
        ativo: true,
        aliases: {
          create: {
            alias: "Linha velha",
            aliasNormalizado: "linha velha",
          },
        },
      },
    });
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Histórico", slug: "historico-mercado-legado" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date("2026-08-01T18:00:00Z"),
        evento: "Casa vs Fora",
        esporte: "Soccer",
        mercado: legacyName,
        selecao: "Casa",
        odds: 1.9,
        stake: 1,
      },
    });

    await seedMercados(db.prisma);

    await expect(db.prisma.mercadoPadrao.findUniqueOrThrow({ where: { id: legacy.id } }))
      .resolves.toMatchObject({ nome: legacyName, ativo: false });
    await expect(db.prisma.mercadoAlias.count({ where: { mercadoPadraoId: legacy.id } }))
      .resolves.toBe(1);
    await expect(db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .resolves.toMatchObject({ mercado: legacyName });
  });

  it("reverte a desativação se qualquer upsert do seed falhar", async () => {
    const legacy = await db.prisma.mercadoPadrao.create({
      data: { nome: "Mercado que deve continuar ativo", ativo: true },
    });
    await db.prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_market_seed() RETURNS trigger LANGUAGE plpgsql AS $BODY$
      BEGIN
        IF NEW.nome = 'Anytime Goalscorer' THEN
          RAISE EXCEPTION 'falha injetada depois da desativação';
        END IF;
        RETURN NEW;
      END;
      $BODY$;
      CREATE TRIGGER fail_market_seed
      BEFORE INSERT OR UPDATE ON mercados_padrao
      FOR EACH ROW EXECUTE FUNCTION fail_market_seed();
    `);
    try {
      await expect(seedMercados(db.prisma)).rejects.toThrow(/falha injetada/);
    } finally {
      await db.prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_market_seed ON mercados_padrao;
        DROP FUNCTION IF EXISTS fail_market_seed();
      `);
    }
    await expect(db.prisma.mercadoPadrao.findUniqueOrThrow({ where: { id: legacy.id } }))
      .resolves.toMatchObject({ ativo: true });
  });
});
