import type { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { normalizeMercadoKey } from "../src/domain/mercados/catalog";
import {
  MERCADO_CATALOG,
  type MercadoCatalogAlias,
} from "../src/domain/mercados/catalog-data";

type MercadoSeedClient = Pick<Prisma.TransactionClient, "mercadoPadrao" | "mercadoAlias">;
type MercadoSeedRootClient = Pick<PrismaClient, "$transaction">;
export type MercadoSeedResult = { mercados: number; aliases: number };

/**
 * Materializa a taxonomia versionada. Reexecutável: as duas tabelas usam suas
 * chaves naturais, portanto retry/deploy repetido atualiza e nunca duplica.
 */
export async function seedMercados(
  prisma: MercadoSeedRootClient,
): Promise<MercadoSeedResult> {
  return prisma.$transaction(
    (tx) => materializeMercadoSeed(tx),
    { maxWait: 10_000, timeout: 60_000 },
  );
}

async function materializeMercadoSeed(
  prisma: MercadoSeedClient,
): Promise<MercadoSeedResult> {
  const currentMarketNames = Object.keys(MERCADO_CATALOG);

  await prisma.mercadoPadrao.updateMany({
    // Catálogo estrito: qualquer padrão antigo/customizado fora do conjunto
    // versionado deixa de ser selecionável. A linha não é apagada, portanto
    // apostas históricas e sua trilha continuam intactas.
    where: { ativo: true, nome: { notIn: currentMarketNames } },
    data: { ativo: false },
  });

  let mercados = 0;
  let aliases = 0;
  for (const [nome, catalogAliases] of Object.entries(MERCADO_CATALOG)) {
    const aliasList: readonly MercadoCatalogAlias[] = catalogAliases;
    const mercado = await prisma.mercadoPadrao.upsert({
      where: { nome },
      update: { ativo: true },
      create: { nome, ativo: true },
    });
    mercados += 1;

    for (const entry of aliasList) {
      const aliasNormalizado = normalizeMercadoKey(entry.alias);
      if (!aliasNormalizado) continue;
      const casaDeAposta = entry.casaDeAposta ?? "";
      await prisma.mercadoAlias.upsert({
        where: {
          aliasNormalizado_casaDeAposta_mercadoPadraoId: {
            aliasNormalizado,
            casaDeAposta,
            mercadoPadraoId: mercado.id,
          },
        },
        update: { alias: entry.alias },
        create: {
          alias: entry.alias,
          aliasNormalizado,
          casaDeAposta,
          mercadoPadraoId: mercado.id,
        },
      });
      aliases += 1;
    }
  }
  return { mercados, aliases };
}
