/**
 * Apaga do pg-boss as filas que saíram do código, com as dead-letters e os
 * jobs delas. Simula por padrão; `--aplicar` apaga tudo numa transação, com
 * auditoria. Sai com 2 quando alguma fila é recusada (nada é apagado).
 *
 *   node dist/ops-apagar-filas-aposentadas.mjs --fila telegram.webhook --fila telegram.retry \
 *     --motivo "<por que as falhas guardadas podem ir junto>" --executor agent:claude:por:fabricio [--aplicar]
 *
 * Regras: `src/services/ops/retired-queues.ts`.
 */
import { parseArgs } from "node:util";
import { isDelegatedActor } from "@/src/domain/production-write-actors";
import { disconnectPrisma } from "@/src/infra/prisma";
import { deleteRetiredQueues } from "@/src/services/ops/retired-queues";

const { values } = parseArgs({
  options: {
    fila: { type: "string", multiple: true },
    motivo: { type: "string" },
    executor: { type: "string" },
    aplicar: { type: "boolean", default: false },
  },
});

async function main(): Promise<number> {
  if (!values.fila?.length || !values.motivo || !values.executor
    || !isDelegatedActor(values.executor)) {
    process.stderr.write("uso: --fila <nome> [--fila <nome>…] --motivo <texto> --executor agent:<nome>:por:<operador> [--aplicar]\n");
    return 64;
  }
  const result = await deleteRetiredQueues({
    filas: values.fila,
    motivo: values.motivo,
    executor: values.executor,
    aplicar: values.aplicar ?? false,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.filas.some((fila) => fila.estado === "recusada") ? 2 : 0;
}

main()
  .then(async (code) => { await disconnectPrisma(); process.exit(code); })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await disconnectPrisma();
    process.exit(1);
  });
