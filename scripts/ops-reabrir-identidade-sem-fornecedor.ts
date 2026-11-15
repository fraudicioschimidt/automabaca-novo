/**
 * Devolve a PENDING as identidades MATCHED sem fornecedor e reenfileira o
 * enrich de cada aposta. Simula por padrão; `--aplicar` grava numa transação,
 * com auditoria.
 *
 *   node dist/ops-reabrir-identidade-sem-fornecedor.mjs --executor agent:claude:por:fabricio [--aplicar]
 *
 * Regras: `src/services/sharp/reopen-providerless-identity.ts`.
 */
import { parseArgs } from "node:util";
import type { PgBoss } from "pg-boss";
import { isDelegatedActor } from "@/src/domain/production-write-actors";
import { createBoss } from "@/src/infra/boss";
import { disconnectPrisma } from "@/src/infra/prisma";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { reopenProviderlessIdentities } from "@/src/services/sharp/reopen-providerless-identity";

const { values } = parseArgs({
  options: { executor: { type: "string" }, aplicar: { type: "boolean", default: false } },
});

async function main(): Promise<number> {
  if (!values.executor || !isDelegatedActor(values.executor)) {
    process.stderr.write("uso: --executor agent:<nome>:por:<operador> [--aplicar]\n");
    return 64;
  }
  const apply = values.aplicar ?? false;
  let boss: PgBoss | null = null;
  try {
    if (apply) {
      boss = createBoss({ producerOnly: true });
      await boss.start();
    }
    const started = boss;
    const result = await reopenProviderlessIdentities({
      executor: values.executor,
      apply,
      ...(started ? { enqueueEnrich: (betId: string) => enqueueSharpEnrich(started, betId, { origem: "ops-reabrir-identidade" }) } : {}),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } finally {
    await boss?.stop({ graceful: true });
  }
}

main()
  .then(async (code) => { await disconnectPrisma(); process.exit(code); })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await disconnectPrisma();
    process.exit(1);
  });
