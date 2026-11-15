import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { applyBetEdit } from "@/src/services/bets/edit";
import { registerBet } from "@/src/services/bets/register";
import { adicionarMercadoAlias } from "@/src/services/mercados/aliases";
import { normalizeMercado } from "@/src/services/mercados/normalize";

let db: TestDb;
const RAW_ALIAS = "Linha Especial Ambígua";
const NORMALIZED_ALIAS = "linha especial ambigua";

beforeAll(() => {
  db = createTestDb();
});

beforeEach(async () => {
  await db.reset();
});

afterAll(async () => {
  await db.dispose();
});

async function seedConflict(casaDeAposta = "") {
  const [football, americanFootball] = await Promise.all([
    db.prisma.mercadoPadrao.create({ data: { nome: "Handicap – Match" } }),
    db.prisma.mercadoPadrao.create({ data: { nome: "Point Spread" } }),
  ]);
  await db.prisma.mercadoAlias.createMany({
    data: [football.id, americanFootball.id].map((mercadoPadraoId) => ({
      alias: RAW_ALIAS,
      aliasNormalizado: NORMALIZED_ALIAS,
      casaDeAposta,
      mercadoPadraoId,
    })),
  });
  return { football, americanFootball };
}

describe("alias de mercado com destinos incompatíveis", () => {
  it("não escolhe pela ordem física nem cai do conflito específico no genérico", async () => {
    const moneyline = await db.prisma.mercadoPadrao.create({ data: { nome: "Moneyline" } });
    await db.prisma.mercadoAlias.create({
      data: {
        alias: RAW_ALIAS,
        aliasNormalizado: NORMALIZED_ALIAS,
        mercadoPadraoId: moneyline.id,
      },
    });
    const conflict = await seedConflict("betano");

    const options = {
      casaDeAposta: "Betano",
      esporte: "Soccer",
      client: db.prisma,
    } as const;
    const expected = {
      mercado: RAW_ALIAS,
      matched: false,
      aliasConflict: {
        aliasNormalizado: NORMALIZED_ALIAS,
        casaDeAposta: "betano",
        destinos: ["Handicap – Match", "Point Spread"],
      },
    };
    await expect(normalizeMercado(RAW_ALIAS, options)).resolves.toEqual(expected);

    await db.prisma.mercadoAlias.deleteMany({ where: { casaDeAposta: "betano" } });
    await db.prisma.mercadoAlias.createMany({
      data: [conflict.americanFootball.id, conflict.football.id].map((mercadoPadraoId) => ({
        alias: RAW_ALIAS,
        aliasNormalizado: NORMALIZED_ALIAS,
        casaDeAposta: "betano",
        mercadoPadraoId,
      })),
    });
    await expect(normalizeMercado(RAW_ALIAS, options)).resolves.toEqual(expected);
  });

  it("registra PENDING com ação operacional em vez de inferir o lado financeiro", async () => {
    await seedConflict();
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Alias", slug: "alias-conflict", sharpMode: "OFF" },
    });

    const result = await registerBet({
      bankrollId: bankroll.id,
      data: new Date("2026-09-15T18:00:00Z"),
      evento: "Casa vs Fora",
      esporte: "Soccer",
      mercado: RAW_ALIAS,
      selecao: "Casa -1.5",
      odds: 1.9,
      stake: 1,
      source: "test",
      sourceExternalId: "alias-conflict",
      actor: "test",
    }, { client: db.prisma });

    expect(result.mercadoMatched).toBe(false);
    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: result.betId } }))
      .toMatchObject({ mercado: RAW_ALIAS, status: "PENDING" });
    expect(await db.prisma.operationalAction.findFirst({
      where: { actionType: "mercado.alias_conflict", resourceId: result.betId },
    })).not.toBeNull();
  });

  it("edição ambígua reabre resultado final e exige revisão", async () => {
    await seedConflict();
    const bankroll = await db.prisma.bankroll.create({
      data: { nome: "Edit Alias", slug: "edit-alias", sharpMode: "OFF" },
    });
    const bet = await db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        bankrollId: bankroll.id,
        data: new Date("2026-09-15T18:00:00Z"),
        evento: "Casa vs Fora",
        esporte: "Soccer",
        mercado: "Moneyline",
        selecao: "Casa",
        odds: 1.9,
        stake: 1,
        status: "WON",
        lucro: 0.9,
        settledAt: new Date("2026-08-13T16:00:00Z"),
      },
    });

    await applyBetEdit({
      betId: bet.id,
      fields: {
        data: bet.data,
        evento: bet.evento,
        esporte: bet.esporte,
        competicao: "",
        pais: "",
        mercado: RAW_ALIAS,
        selecao: "Casa -1.5",
        odds: 1.9,
        stake: 1,
      },
      actor: "test",
    }, { client: db.prisma });

    expect(await db.prisma.bet.findUniqueOrThrow({ where: { id: bet.id } }))
      .toMatchObject({ mercado: RAW_ALIAS, status: "PENDING", settledAt: null });
    expect(await db.prisma.operationalAction.findFirst({
      where: { actionType: "mercado.alias_conflict", resourceId: bet.id },
    })).not.toBeNull();
  });

  it("curadoria recusa criar um segundo destino para a mesma chave", async () => {
    const [moneyline, dnb] = await Promise.all([
      db.prisma.mercadoPadrao.create({ data: { nome: "Moneyline" } }),
      db.prisma.mercadoPadrao.create({ data: { nome: "Draw No Bet" } }),
    ]);
    await adicionarMercadoAlias({
      mercadoPadraoId: moneyline.id,
      alias: "Vencedor especial",
      actor: "operador",
    }, { client: db.prisma });

    await expect(adicionarMercadoAlias({
      mercadoPadraoId: dnb.id,
      alias: "Vencedor especial",
      actor: "operador",
    }, { client: db.prisma })).rejects.toThrow(/já aponta para "Moneyline"/);
    await expect(db.prisma.mercadoAlias.count({
      where: { aliasNormalizado: "vencedor especial" },
    })).resolves.toBe(1);
  });

  it("alias preso a mercado desligado não bloqueia a curadoria", async () => {
    // Produção tem as chaves de total do time também no 'Team Total', desligado,
    // que a normalização não enxerga e a Config não lista.
    const [inactive, active] = await Promise.all([
      db.prisma.mercadoPadrao.create({ data: { nome: "Team Total", ativo: false } }),
      db.prisma.mercadoPadrao.create({ data: { nome: "Team Total – Match" } }),
    ]);
    await db.prisma.mercadoAlias.create({
      data: { alias: "Total do Time", aliasNormalizado: "total do time", mercadoPadraoId: inactive.id },
    });

    await adicionarMercadoAlias({
      mercadoPadraoId: active.id,
      alias: "Total do Time",
      actor: "operador",
    }, { client: db.prisma });

    await expect(normalizeMercado("Total do Time", { client: db.prisma, esporte: "Soccer" }))
      .resolves.toEqual({ mercado: "Team Total – Match", matched: true });
  });

  it("serializa duas atribuições concorrentes sem gravar duas verdades", async () => {
    const [moneyline, dnb] = await Promise.all([
      db.prisma.mercadoPadrao.create({ data: { nome: "Moneyline" } }),
      db.prisma.mercadoPadrao.create({ data: { nome: "Draw No Bet" } }),
    ]);
    const outcomes = await Promise.allSettled([moneyline.id, dnb.id].map((mercadoPadraoId) =>
      adicionarMercadoAlias({ mercadoPadraoId, alias: "Vencedor concorrente", actor: "operador" }, {
        client: db.prisma,
      })
    ));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await expect(db.prisma.mercadoAlias.count({
      where: { aliasNormalizado: "vencedor concorrente" },
    })).resolves.toBe(1);
  });
});
