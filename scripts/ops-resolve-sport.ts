/**
 * Resolução de esporte assistida por agente, via worker.
 *
 * Aposta nomeada: `plan` simula o resolvedor forçado (sem gravar nem medir) e
 * devolve o plano com o esporte, o jogo e o que a confirmação gravaria, com o
 * hash. `apply` grava exatamente o plano aprovado, sem consultar fornecedor
 * nem web de novo, registra o executor e manda a aposta para o enrich; recusa
 * se a aposta mudou depois do plano, se o executor não é o do plano ou se o
 * dono dele não é usuário do painel. Simulação que não confirmaria (pendente,
 * em conflito, já confirmada) sai sem plano.
 *
 * `--all` pega as PENDING da janela do resolvedor, das mais recentes para as
 * mais antigas, sem as que nasceram em conflito na captura, e passa pelas
 * guardas do resolvedor, sem forçar: simula por padrão; `--aplicar` grava pelo
 * resolvedor, como o ciclo automático faria.
 *
 *   node dist/ops-resolve-sport.mjs --executor agent:claude:por:fabricio                       # lista as pendentes
 *   node dist/ops-resolve-sport.mjs --executor agent:claude:por:fabricio plan <betId> > plano.json
 *   node dist/ops-resolve-sport.mjs --executor agent:claude:por:fabricio apply <planHash> < plano.json
 *   node dist/ops-resolve-sport.mjs --executor agent:claude:por:fabricio --all [--aplicar]
 *
 * Regras: `src/services/bets/sport-resolution/operator.ts`.
 */
import { parseArgs } from "node:util";
import { DELEGATED_ACTOR } from "@/src/domain/production-write-actors";
import {
  applySportResolutionPlan,
  buildSportResolutionPlan,
  resolvePendingSportsForOperator,
} from "@/src/services/bets/sport-resolution/operator";
import { resolveOperationalActionBySourceKey } from "@/src/services/ops/operational-actions";
import { disconnectPrisma, prisma } from "@/src/infra/prisma";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

const USAGE = "uso: --executor agent:<nome>:por:<operador> [plan <betId> | --all [--aplicar] | apply <planHash> < plano.json]\n";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { executor: { type: "string" }, all: { type: "boolean", default: false }, aplicar: { type: "boolean", default: false } },
});

function unresolvedBets(take: number) {
  return prisma.bet.findMany({
    where: { deletedAt: null, sportResolutionStatus: { in: ["PENDING", "CONFLICT"] } },
    select: { id: true, evento: true, mercado: true, selecao: true, competicao: true, esporte: true, sportConfidence: true, sportResolutionStatus: true },
    orderBy: [{ data: "asc" }, { id: "asc" }],
    take,
  });
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/**
 * Fecha na caixa de Operações só as apostas que este comando confirmou. O
 * esporte já está gravado: a falha aqui é aviso, e o worker fecha no ciclo dele.
 */
async function closeSportActions(betIds: string[], executor: string): Promise<void> {
  try {
    for (const betId of betIds) {
      await resolveOperationalActionBySourceKey("sport-resolution", betId, `Esporte confirmado pelo agente do dono (${executor}).`);
    }
  } catch (error) {
    process.stderr.write(`aviso: esporte gravado, mas a ação da caixa não foi fechada: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function main(): Promise<number> {
  const [command, argument, ...extra] = positionals;
  if (!values.executor || !DELEGATED_ACTOR.test(values.executor)) {
    process.stderr.write(USAGE);
    return 64;
  }
  if (command === "apply") {
    if (!argument || extra.length > 0 || values.all || values.aplicar) {
      process.stderr.write(USAGE);
      return 64;
    }
    const result = await applySportResolutionPlan(await readStdin(), argument, values.executor);
    print(result);
    if (result.kind === "saved") await closeSportActions([result.betId], values.executor);
    return result.kind === "saved" ? 0 : 3;
  }
  if (command === "plan" && argument && extra.length === 0 && !values.all && !values.aplicar) {
    const result = await buildSportResolutionPlan({ betId: argument, executor: values.executor });
    print(result.ok ? result.plan : result);
    return result.ok ? 0 : 2;
  }
  if (values.all && !command) {
    const aplicar = values.aplicar ?? false;
    const runs = await resolvePendingSportsForOperator({ executor: values.executor, aplicar });
    print({ aplicado: aplicar, runs });
    if (aplicar) await closeSportActions(runs.flatMap((run) => run.status === "resolved" ? [run.betId] : []), values.executor);
    return 0;
  }
  if (!command && !values.aplicar) {
    const pending = await unresolvedBets(20);
    print({ pendingCount: pending.length, pending });
    return 0;
  }
  // Inclusive o antigo `<betId> --aplicar`: a aposta nomeada só grava por plano aprovado.
  process.stderr.write(USAGE);
  return 64;
}

main()
  .then(async (code) => { await disconnectPrisma(); process.exit(code); })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await disconnectPrisma();
    // 2 é a recusa (plano de outro executor, dono que não é do painel); o resto é falha.
    process.exit(error instanceof RecusaDeNegocioError ? 2 : 1);
  });
