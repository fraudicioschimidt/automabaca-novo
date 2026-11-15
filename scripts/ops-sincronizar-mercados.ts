/**
 * Leva ao banco os mercados e aliases do catálogo do código que faltam nele.
 * Simula por padrão; `--aplicar` insere numa transação, com auditoria. Nunca
 * apaga, reativa ou altera, e não recoloca alias que o dono tirou. Rodar de
 * novo não muda nada. Em produção é por aqui: o seed regrava o catálogo sem
 * simular nem auditar.
 *
 *   node dist/ops-sincronizar-mercados.mjs --executor agent:<nome>:por:<operador> [--aplicar]
 *
 * Regras: `src/services/mercados/catalog-sync.ts`.
 */
import { parseArgs } from "node:util";
import { isDelegatedActor } from "@/src/domain/production-write-actors";
import { disconnectPrisma } from "@/src/infra/prisma";
import { syncMarketCatalog } from "@/src/services/mercados/catalog-sync";

const { values } = parseArgs({
  options: { executor: { type: "string" }, aplicar: { type: "boolean", default: false } },
});

async function main(): Promise<number> {
  if (!values.executor || !isDelegatedActor(values.executor)) {
    process.stderr.write("uso: --executor agent:<nome>:por:<operador> [--aplicar]\n");
    return 64;
  }
  const result = await syncMarketCatalog({ executor: values.executor, apply: values.aplicar ?? false });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

main()
  .then(async (code) => { await disconnectPrisma(); process.exit(code); })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await disconnectPrisma();
    process.exit(1);
  });
