import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedMercados } from "@/prisma/seed-mercados";
import { normalizeMercadoKey } from "@/src/domain/mercados/catalog";
import { MERCADO_CATALOG } from "@/src/domain/mercados/catalog-data";
import { removerMercadoAlias } from "@/src/services/mercados/aliases";
import { syncMarketCatalog } from "@/src/services/mercados/catalog-sync";

/**
 * Em produção o catálogo de mercados do código chega ao banco por esta
 * sincronização: simula, insere só o que falta com auditoria do executor, não
 * duplica e não recoloca o que o dono tirou.
 */

let db: TestDb;
const EXECUTOR = "agent:claude:por:fabricio";
const NEW_MARKET = "To Score 3+ Goals";

beforeAll(() => { db = createTestDb(); });
afterAll(async () => { await db.dispose(); });
beforeEach(async () => { await db.reset(); });

/** Grafias do catálogo com a mesma chave normalizada viram uma linha só. */
const catalogRowsOf = (mercado: keyof typeof MERCADO_CATALOG) =>
  new Set(MERCADO_CATALOG[mercado].map((entry) => normalizeMercadoKey(entry.alias))).size;

/** O banco de produção antes da sincronização: o mercado novo ainda não existe. */
async function databaseWithoutNewMarket() {
  await seedMercados(db.prisma);
  await db.prisma.mercadoPadrao.delete({ where: { nome: NEW_MARKET } });
}

const counts = async () => ({
  mercados: await db.prisma.mercadoPadrao.count(),
  aliases: await db.prisma.mercadoAlias.count(),
});

describe("sincronização do catálogo de mercados", () => {
  it("simula sem gravar, aplica com auditoria e não duplica ao rodar de novo", async () => {
    await databaseWithoutNewMarket();
    const before = await counts();

    const simulation = await syncMarketCatalog({ executor: EXECUTOR, apply: false });
    expect(simulation.aplicado).toBe(false);
    expect(simulation.mercadosFaltando).toEqual([NEW_MARKET]);
    expect(simulation.aliasesFaltando).toHaveLength(catalogRowsOf(NEW_MARKET));
    expect(new Set(simulation.aliasesFaltando.map((item) => item.mercado))).toEqual(new Set([NEW_MARKET]));
    expect(await counts()).toEqual(before);
    expect(await db.prisma.auditEvent.count()).toBe(0);

    const applied = await syncMarketCatalog({ executor: EXECUTOR, apply: true });
    expect(applied.aplicado).toBe(true);
    const market = await db.prisma.mercadoPadrao.findUniqueOrThrow({
      where: { nome: NEW_MARKET }, include: { aliases: true },
    });
    expect(market.ativo).toBe(true);
    expect(market.aliases.map((row) => row.aliasNormalizado).sort())
      .toEqual([...new Set(MERCADO_CATALOG[NEW_MARKET].map((entry) => normalizeMercadoKey(entry.alias)))].sort());
    const audits = await db.prisma.auditEvent.findMany({ select: { actor: true, action: true, resourceId: true } });
    expect(audits.every((audit) => audit.actor === EXECUTOR)).toBe(true);
    expect(audits.filter((audit) => audit.action === "market.create")).toEqual([
      expect.objectContaining({ resourceId: market.id }),
    ]);
    expect(audits.filter((audit) => audit.action === "market_alias.create").map((audit) => audit.resourceId).sort())
      .toEqual(market.aliases.map((row) => row.id).sort());

    const afterApply = await counts();
    const again = await syncMarketCatalog({ executor: EXECUTOR, apply: true });
    expect(again).toMatchObject({ aplicado: false, mercadosFaltando: [], aliasesFaltando: [] });
    expect(await counts()).toEqual(afterApply);
    expect(await db.prisma.auditEvent.count()).toBe(audits.length);
  });

  it("não recoloca o alias que o dono tirou na curadoria", async () => {
    await seedMercados(db.prisma);
    const removed = await db.prisma.mercadoAlias.findFirstOrThrow({ where: { aliasNormalizado: "resultado final" } });
    await removerMercadoAlias(removed.id, "fabricio");
    const before = await counts();

    const plan = await syncMarketCatalog({ executor: EXECUTOR, apply: true });

    expect(plan).toMatchObject({ aplicado: false, aliasesFaltando: [] });
    expect(plan.pulados.removidosPeloDono).toEqual([
      expect.objectContaining({ mercado: "Money Line – Match", alias: "Resultado Final", por: "fabricio" }),
    ]);
    expect(await counts()).toEqual(before);
    expect(await db.prisma.mercadoAlias.count({ where: { aliasNormalizado: "resultado final" } })).toBe(0);
  });

  it("não reativa mercado desligado nem mexe no alias que o banco leva a outro mercado", async () => {
    await seedMercados(db.prisma);
    await db.prisma.mercadoPadrao.update({ where: { nome: "Correct Score" }, data: { ativo: false } });
    await db.prisma.mercadoAlias.deleteMany({ where: { mercadoPadrao: { nome: "Correct Score" } } });
    const brace = await db.prisma.mercadoAlias.findFirstOrThrow({ where: { aliasNormalizado: "brace" } });
    const anytime = await db.prisma.mercadoPadrao.findUniqueOrThrow({ where: { nome: "Anytime Goalscorer" } });
    await db.prisma.mercadoAlias.update({ where: { id: brace.id }, data: { mercadoPadraoId: anytime.id } });
    const before = await counts();

    const plan = await syncMarketCatalog({ executor: EXECUTOR, apply: true });

    expect(plan).toMatchObject({ aplicado: false, mercadosFaltando: [], aliasesFaltando: [] });
    expect(plan.pulados.mercadoInativo).toHaveLength(catalogRowsOf("Correct Score"));
    expect(plan.pulados.apontamParaOutroMercado).toEqual([
      expect.objectContaining({ mercado: "To Score 2+ Goals", alias: "Brace", mercadoNoBanco: "Anytime Goalscorer" }),
    ]);
    expect(await counts()).toEqual(before);
    expect(await db.prisma.mercadoPadrao.findUniqueOrThrow({ where: { nome: "Correct Score" } }))
      .toMatchObject({ ativo: false });
    expect(await db.prisma.mercadoAlias.findUniqueOrThrow({ where: { id: brace.id } }))
      .toMatchObject({ mercadoPadraoId: anytime.id });
  });

  it("mercado desligado não segura o alias do código: a chave que só ele tem entra no mercado ativo", async () => {
    await seedMercados(db.prisma);
    const inactive = await db.prisma.mercadoPadrao.create({ data: { nome: "Team Total", ativo: false } });
    await db.prisma.mercadoAlias.updateMany({
      where: { aliasNormalizado: "total do time", mercadoPadrao: { nome: "Team Total – Match" } },
      data: { mercadoPadraoId: inactive.id },
    });

    const plan = await syncMarketCatalog({ executor: EXECUTOR, apply: true });

    expect(plan.aliasesFaltando).toEqual([
      expect.objectContaining({ mercado: "Team Total – Match", alias: "Total do Time" }),
    ]);
    expect(plan.pulados.apontamParaOutroMercado).toEqual([]);
  });

  it("alias que o dono tirou do mercado ativo conta como removido, mesmo com a cópia no desligado", async () => {
    await seedMercados(db.prisma);
    const inactive = await db.prisma.mercadoPadrao.create({ data: { nome: "Team Total", ativo: false } });
    await db.prisma.mercadoAlias.create({
      data: { alias: "Total do Time", aliasNormalizado: "total do time", mercadoPadraoId: inactive.id },
    });
    const removed = await db.prisma.mercadoAlias.findFirstOrThrow({
      where: { aliasNormalizado: "total do time", mercadoPadrao: { nome: "Team Total – Match" } },
    });
    await removerMercadoAlias(removed.id, "fabricio");

    const plan = await syncMarketCatalog({ executor: EXECUTOR, apply: false });

    expect(plan.pulados.removidosPeloDono).toEqual([
      expect.objectContaining({ mercado: "Team Total – Match", alias: "Total do Time", por: "fabricio" }),
    ]);
    expect(plan.pulados.apontamParaOutroMercado).toEqual([]);
  });

  it("recusa executor que não seja o ator de escrita delegada", async () => {
    await expect(syncMarketCatalog({ executor: "fabricio", apply: true })).rejects.toThrow(/agent:/);
    expect(await db.prisma.auditEvent.count()).toBe(0);
  });
});
