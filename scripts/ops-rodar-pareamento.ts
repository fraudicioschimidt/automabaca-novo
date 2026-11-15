/**
 * Roda uma rodada do pareamento dos catálogos (Pinnacle17 × FlashScore) fora
 * do horário, a pedido do dono: a mesma rodada da fila `teams.catalog_pairing`,
 * com as mesmas travas (cota, disjuntor, trava contra rodada simultânea). Só
 * grava as tabelas do pareamento; não mexe em aposta. Não tem simulação: a
 * rodada é a do horário, e fica em `audit_events` (`ops.rodar_pareamento`)
 * com o executor e o resumo do que saiu.
 *
 *   node dist/ops-rodar-pareamento.mjs --executor agent:claude:por:fabricio
 */
import { parseArgs } from "node:util";
import { DELEGATED_ACTOR } from "@/src/domain/production-write-actors";
import { disconnectPrisma, prisma } from "@/src/infra/prisma";
import { runCatalogPairingRound } from "@/src/services/teams/catalog-pairing-round";

const { values } = parseArgs({ options: { executor: { type: "string" } } });

async function main(): Promise<number> {
  if (!values.executor || !DELEGATED_ACTOR.test(values.executor)) {
    process.stderr.write("uso: --executor agent:<nome>:por:<operador>\n");
    return 64;
  }
  const round = await runCatalogPairingRound();
  // A rodada já gravou: o resumo sai antes da trilha, e a falha da trilha aparece no stderr.
  await new Promise<void>((resolve) => process.stdout.write(JSON.stringify(round, null, 2) + "\n", () => resolve()));
  await prisma.auditEvent.create({ data: {
    actor: values.executor, action: "ops.rodar_pareamento", resource: "catalog_pairing", resourceId: round.day, details: round,
  } });
  return 0;
}

main()
  .then(async (code) => { await disconnectPrisma(); process.exitCode = code; })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await disconnectPrisma();
    process.exitCode = 1;
  });
