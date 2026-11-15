import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { normalizeMercado } from "@/src/services/mercados/normalize";
import { adicionarMercadoAlias } from "@/src/services/mercados/aliases";
import { seedMercados } from "@/prisma/seed-mercados";

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

describe("normalizeMercado com aliases do banco", () => {
  it("após o seed, remoção e reatribuição no banco prevalecem sobre tradução estática", async () => {
    await seedMercados(db.prisma);
    const options = { client: db.prisma, esporte: "Soccer" } as const;
    await expect(normalizeMercado("Resultado Final", options)).resolves.toEqual({
      mercado: "Money Line – Match",
      matched: true,
    });

    await db.prisma.mercadoAlias.deleteMany({
      where: { aliasNormalizado: "resultado final", casaDeAposta: "" },
    });
    await expect(normalizeMercado("Resultado Final", options)).resolves.toEqual({
      mercado: "Resultado Final",
      matched: false,
    });

    const doubleChance = await db.prisma.mercadoPadrao.findUniqueOrThrow({
      where: { nome: "Double Chance" },
    });
    await adicionarMercadoAlias({
      mercadoPadraoId: doubleChance.id,
      alias: "Resultado Final",
      actor: "operador",
    }, { client: db.prisma });
    await expect(normalizeMercado("Resultado Final", options)).resolves.toEqual({
      mercado: "Double Chance",
      matched: true,
    });
  });

  it("mercado novo do código que o banco ainda não tem não devolve a curadoria ao catálogo estático", async () => {
    await seedMercados(db.prisma);
    // Produção antes do próximo seed: o mercado de 3+ gols só existe no código.
    const novo = await db.prisma.mercadoPadrao.findUniqueOrThrow({ where: { nome: "To Score 3+ Goals" } });
    await db.prisma.mercadoAlias.deleteMany({ where: { mercadoPadraoId: novo.id } });
    await db.prisma.mercadoPadrao.delete({ where: { id: novo.id } });
    await db.prisma.mercadoAlias.deleteMany({
      where: { aliasNormalizado: "resultado final", casaDeAposta: "" },
    });
    const options = { client: db.prisma, esporte: "Soccer" } as const;

    await expect(normalizeMercado("Resultado Final", options)).resolves.toEqual({
      mercado: "Resultado Final",
      matched: false,
    });
    await expect(normalizeMercado("To Score 3+ Goals", options)).resolves.toEqual({
      mercado: "To Score 3+ Goals",
      matched: true,
    });
  });

  it("alias do banco resolve, e o alias novo vale na leitura seguinte", async () => {
    const mercado = await db.prisma.mercadoPadrao.create({
      data: { nome: "Moneyline" },
    });

    // Sem alias ainda: cai no contrato canônico de produto.
    const builtin = await normalizeMercado("Resultado Final", {
      client: db.prisma,
      esporte: "Soccer",
    });
    expect(builtin).toEqual({ mercado: "Money Line – Match", matched: true });

    // …e um formato exótico só resolve depois do alias.
    const before = await normalizeMercado("Vencedor do Confronto", {
      client: db.prisma,
      esporte: "Soccer",
    });
    expect(before.matched).toBe(false);

    await db.prisma.mercadoAlias.create({
      data: {
        alias: "Vencedor do Confronto",
        aliasNormalizado: "vencedor do confronto",
        mercadoPadraoId: mercado.id,
      },
    });

    const after = await normalizeMercado("Vencedor do Confronto", {
      client: db.prisma,
      esporte: "Soccer",
    });
    expect(after).toEqual({ mercado: "Money Line – Match", matched: true });
  });

  it("alias específico de casa tem precedência sobre o genérico", async () => {
    const moneyline = await db.prisma.mercadoPadrao.create({ data: { nome: "Moneyline" } });
    const dnb = await db.prisma.mercadoPadrao.create({ data: { nome: "Draw No Bet" } });

    await db.prisma.mercadoAlias.createMany({
      data: [
        {
          alias: "Vencedor",
          aliasNormalizado: "vencedor",
          casaDeAposta: "",
          mercadoPadraoId: moneyline.id,
        },
        {
          alias: "Vencedor",
          aliasNormalizado: "vencedor",
          casaDeAposta: "betano",
          mercadoPadraoId: dnb.id,
        },
      ],
    });

    const generic = await normalizeMercado("Vencedor", { client: db.prisma });
    expect(generic.mercado).toBe("Moneyline");

    const casaEspecifica = await normalizeMercado("Vencedor", {
      casaDeAposta: "Betano",
      client: db.prisma,
    });
    expect(casaEspecifica.mercado).toBe("Draw No Bet");
  });

  it("a captura no worker vê na leitura seguinte o alias que outro processo removeu", async () => {
    await seedMercados(db.prisma);
    // Sem `client`: o caminho do registro, com o cliente padrão do processo.
    await expect(normalizeMercado("Resultado Final", { esporte: "Soccer" })).resolves.toEqual({
      mercado: "Money Line – Match",
      matched: true,
    });
    // A curadoria roda na web (ou no ops-sincronizar-mercados): a mudança chega
    // ao banco e nada avisa este processo.
    await db.prisma.mercadoAlias.deleteMany({
      where: { aliasNormalizado: "resultado final", casaDeAposta: "" },
    });
    await expect(normalizeMercado("Resultado Final", { esporte: "Soccer" })).resolves.toEqual({
      mercado: "Resultado Final",
      matched: false,
    });
  });
});
