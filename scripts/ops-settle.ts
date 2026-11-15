/**
 * Liquidação delegada a um agente, com plano revisável e aplicação idempotente.
 *
 * Produção (dentro do worker, que já tem o ambiente):
 *   docker exec -i automabaca-novo-worker node dist/ops-settle.mjs plan  < pedido.json > plano.json
 *   docker exec -i automabaca-novo-worker node dist/ops-settle.mjs apply <planHash> < plano.json
 *
 * `plan` não grava nada e recusa o lote inteiro se alguma aposta não puder ser
 * liquidada. `apply` só aceita o plano cujo hash foi aprovado e usa o mesmo
 * caminho com recibo do painel. Contrato: `src/domain/delegated-settlement.ts`.
 */
import { applyDelegatedSettlementPlan, buildDelegatedSettlementPlan } from "@/src/services/bets/delegated-settlement";
import { disconnectPrisma } from "@/src/infra/prisma";

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main(): Promise<number> {
  const [command, approvedHash] = process.argv.slice(2);
  if (command === "plan") {
    const result = await buildDelegatedSettlementPlan(await readStdin());
    process.stdout.write(JSON.stringify(result.ok ? result.plan : result, null, 2) + "\n");
    return result.ok ? 0 : 2;
  }
  if (command === "apply" && approvedHash) {
    const results = await applyDelegatedSettlementPlan(await readStdin(), approvedHash);
    process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
    return results.every((r) => r.kind === "saved") ? 0 : 3;
  }
  process.stderr.write("uso: ops-settle plan < pedido.json | ops-settle apply <planHash> < plano.json\n");
  return 64;
}

main()
  .then(async (code) => { await disconnectPrisma(); process.exit(code); })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await disconnectPrisma();
    process.exit(1);
  });
