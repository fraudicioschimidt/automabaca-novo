/**
 * Fecha circuitos de LLM com cooldown vencido que ficaram `OPEN` no banco —
 * lápides de modelo retirado, que o runtime não revisita mais.
 * Simula por padrão; `--aplicar` grava tudo numa transação, com auditoria.
 *
 *   node dist/ops-limpar-circuitos.mjs --executor agent:command-code:por:fabricio [--aplicar]
 *
 * Regras: `src/services/ops/limpar-circuitos.ts`.
 */
import { parseArgs } from "node:util";
import { isDelegatedActor } from "@/src/domain/production-write-actors";
import { disconnectPrisma } from "@/src/infra/prisma";
import { limparCircuitosLlm } from "@/src/services/ops/limpar-circuitos";

const { values } = parseArgs({
  options: { executor: { type: "string" }, aplicar: { type: "boolean", default: false } },
});

async function main(): Promise<number> {
  if (!values.executor || !isDelegatedActor(values.executor)) {
    process.stderr.write("uso: --executor agent:<nome>:por:<operador> [--aplicar]\n");
    return 64;
  }
  const result = await limparCircuitosLlm({
    executor: values.executor,
    aplicar: values.aplicar ?? false,
  });
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
