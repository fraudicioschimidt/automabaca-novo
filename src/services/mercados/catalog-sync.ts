import { normalizeMercadoKey } from "@/src/domain/mercados/catalog";
import { MERCADO_CATALOG, type MercadoCatalogAlias } from "@/src/domain/mercados/catalog-data";
import { isDelegatedActor } from "@/src/domain/production-write-actors";
import type { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/infra/prisma";
import { runSerializableTransaction } from "@/src/services/shared/transaction";

/**
 * Leva ao banco o que o catálogo de mercados do código tem e o banco ainda não:
 * mercado padrão que falta e alias que falta. Só INSERE. Não reativa mercado,
 * não mexe em alias existente, não apaga nada, e não recoloca o que o dono
 * tirou pela curadoria (`market_alias.delete` na auditoria) nem o alias que o
 * banco leva a outro mercado. O seed (`prisma/seed-mercados.ts`) não roda no
 * deploy e regrava o catálogo sem auditoria: em produção, é por aqui.
 */

export type CatalogSyncAlias = { mercado: string; alias: string; casaDeAposta: string };

export type CatalogSyncPlan = {
  aplicado: boolean;
  /** Mercados do código sem linha no banco: entram ativos. */
  mercadosFaltando: string[];
  /** Aliases do código que faltam no banco e entram. */
  aliasesFaltando: CatalogSyncAlias[];
  /** O que o banco decidiu diferente do código e fica como está. */
  pulados: {
    /** O dono removeu este alias na curadoria. */
    removidosPeloDono: Array<CatalogSyncAlias & { removidoEm: string; por: string }>;
    /** O banco usa este texto para outro mercado. */
    apontamParaOutroMercado: Array<CatalogSyncAlias & { mercadoNoBanco: string }>;
    /** O mercado existe no banco, desligado: nem ele nem os aliases dele voltam. */
    mercadoInativo: CatalogSyncAlias[];
  };
};

/** Ações de auditoria desta sincronização: a revisão diária as lista por executor. */
const CATALOG_SYNC_ACTIONS = {
  market: "market.create",
  alias: "market_alias.create",
} as const;

type CatalogReader = Pick<Prisma.TransactionClient, "mercadoPadrao" | "mercadoAlias" | "auditEvent">;

type Removal = { removidoEm: string; por: string };

/** `market_alias.delete` guarda texto normalizado e mercado; a casa não entra. */
async function ownerRemovals(db: CatalogReader, marketNameById: ReadonlyMap<string, string>): Promise<Map<string, Removal>> {
  const events = await db.auditEvent.findMany({
    where: { action: "market_alias.delete" },
    select: { actor: true, createdAt: true, details: true },
    orderBy: { createdAt: "desc" },
  });
  const removals = new Map<string, Removal>();
  for (const event of events) {
    const details = event.details as { aliasNormalizado?: unknown; mercadoPadraoId?: unknown } | null;
    const key = typeof details?.aliasNormalizado === "string" ? details.aliasNormalizado : null;
    const market = typeof details?.mercadoPadraoId === "string" ? marketNameById.get(details.mercadoPadraoId) : undefined;
    if (!key || !market) continue;
    const removalKey = `${market}|${key}`;
    if (!removals.has(removalKey)) {
      removals.set(removalKey, { removidoEm: event.createdAt.toISOString(), por: event.actor });
    }
  }
  return removals;
}

async function buildPlan(db: CatalogReader): Promise<CatalogSyncPlan> {
  const markets = await db.mercadoPadrao.findMany({ select: { id: true, nome: true, ativo: true } });
  const marketByName = new Map(markets.map((market) => [market.nome, market]));
  const marketNameById = new Map(markets.map((market) => [market.id, market.nome]));
  const aliases = await db.mercadoAlias.findMany({
    select: { aliasNormalizado: true, casaDeAposta: true, mercadoPadraoId: true },
  });
  // Alias de mercado desligado não é destino (a normalização o ignora): a
  // chave que só ele tem ainda falta no mercado ativo.
  const activeMarketIds = new Set(markets.filter((market) => market.ativo).map((market) => market.id));
  const destinationsByKey = new Map<string, Set<string>>();
  for (const row of aliases) {
    if (!activeMarketIds.has(row.mercadoPadraoId)) continue;
    const key = `${row.aliasNormalizado}|${row.casaDeAposta}`;
    const destinations = destinationsByKey.get(key) ?? new Set<string>();
    destinations.add(marketNameById.get(row.mercadoPadraoId) ?? row.mercadoPadraoId);
    destinationsByKey.set(key, destinations);
  }
  const removals = await ownerRemovals(db, marketNameById);

  const plan: CatalogSyncPlan = {
    aplicado: false,
    mercadosFaltando: [],
    aliasesFaltando: [],
    pulados: { removidosPeloDono: [], apontamParaOutroMercado: [], mercadoInativo: [] },
  };
  const seen = new Set<string>();
  for (const [mercado, entries] of Object.entries(MERCADO_CATALOG)) {
    const existing = marketByName.get(mercado);
    if (!existing) plan.mercadosFaltando.push(mercado);
    for (const entry of entries as readonly MercadoCatalogAlias[]) {
      const aliasNormalizado = normalizeMercadoKey(entry.alias);
      if (!aliasNormalizado) continue;
      const casaDeAposta = entry.casaDeAposta ?? "";
      const item: CatalogSyncAlias = { mercado, alias: entry.alias, casaDeAposta };
      const key = `${aliasNormalizado}|${casaDeAposta}`;
      // Duas grafias do catálogo com a mesma chave viram uma linha só, como no seed.
      if (seen.has(`${mercado}|${key}`)) continue;
      seen.add(`${mercado}|${key}`);
      const destinations = destinationsByKey.get(key);
      if (destinations?.has(mercado)) continue;
      if (existing && !existing.ativo) {
        plan.pulados.mercadoInativo.push(item);
        continue;
      }
      if (destinations && destinations.size > 0) {
        plan.pulados.apontamParaOutroMercado.push({ ...item, mercadoNoBanco: [...destinations].sort().join(", ") });
        continue;
      }
      const removal = removals.get(`${mercado}|${aliasNormalizado}`);
      if (removal) {
        plan.pulados.removidosPeloDono.push({ ...item, ...removal });
        continue;
      }
      plan.aliasesFaltando.push(item);
    }
  }
  return plan;
}

/**
 * Simula por padrão. Com `apply`, refaz o plano dentro de uma transação
 * serializável e insere só o que continua faltando, com uma auditoria por
 * linha no nome do executor. Rodar de novo não insere nada.
 */
export async function syncMarketCatalog(params: { executor: string; apply: boolean }): Promise<CatalogSyncPlan> {
  if (!isDelegatedActor(params.executor)) {
    throw new Error("executor precisa ser agent:<nome>:por:<operador>, o ator de escrita delegada.");
  }
  if (!params.apply) return buildPlan(prisma);
  const plan = await runSerializableTransaction("syncMarketCatalog", async (tx) => {
    const current = await buildPlan(tx);
    for (const mercado of current.mercadosFaltando) {
      const created = await tx.mercadoPadrao.create({ data: { nome: mercado, ativo: true }, select: { id: true } });
      await tx.auditEvent.create({
        data: {
          actor: params.executor,
          action: CATALOG_SYNC_ACTIONS.market,
          resource: "market",
          resourceId: created.id,
          details: { nome: mercado, origem: "catalogo-do-codigo" },
        },
      });
    }
    const marketIds = new Map(
      (await tx.mercadoPadrao.findMany({
        where: { nome: { in: [...new Set(current.aliasesFaltando.map((item) => item.mercado))] } },
        select: { id: true, nome: true },
      })).map((market) => [market.nome, market.id]),
    );
    for (const item of current.aliasesFaltando) {
      const mercadoPadraoId = marketIds.get(item.mercado);
      if (!mercadoPadraoId) throw new Error(`Mercado ${item.mercado} sumiu durante a sincronização.`);
      const aliasNormalizado = normalizeMercadoKey(item.alias);
      const created = await tx.mercadoAlias.create({
        data: { alias: item.alias, aliasNormalizado, casaDeAposta: item.casaDeAposta, mercadoPadraoId },
        select: { id: true },
      });
      await tx.auditEvent.create({
        data: {
          actor: params.executor,
          action: CATALOG_SYNC_ACTIONS.alias,
          resource: "market_alias",
          resourceId: created.id,
          details: {
            alias: item.alias, aliasNormalizado, casaDeAposta: item.casaDeAposta, mercadoPadraoId,
            origem: "catalogo-do-codigo",
          },
        },
      });
    }
    return { ...current, aplicado: current.mercadosFaltando.length + current.aliasesFaltando.length > 0 };
  }, { timeoutMs: 60_000 });
  return plan;
}
