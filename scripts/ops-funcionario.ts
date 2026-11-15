/**
 * O funcionário de IA: o que o agente do dono lê e grava em produção, dentro
 * do worker, sempre com o executor delegado e saída JSON. O servidor MCP do PC
 * do dono (`scripts/mcp-funcionario.ts`) chama estes comandos por ssh.
 *
 *   node dist/ops-funcionario.mjs pendencias --executor agent:gemini:por:fabricio
 *   node dist/ops-funcionario.mjs ficha <betId> --executor …
 *   node dist/ops-funcionario.mjs resumo --executor …
 *   node dist/ops-funcionario.mjs vincular plan <caseId> <índice> <hash do candidato> --executor … --evidencia "<o que conferiu>" > plano.json
 *   node dist/ops-funcionario.mjs vincular apply <planHash> --executor … < plano.json
 *   node dist/ops-funcionario.mjs ignorar <caseId> --executor … --motivo "<por quê>"
 *   node dist/ops-funcionario.mjs esporte plan <betId> <esporte> --executor … --evidencia "<fonte>" > plano.json
 *   node dist/ops-funcionario.mjs esporte apply <planHash> --executor … < plano.json
 *   node dist/ops-funcionario.mjs liquidar plan --executor … < pedido.json > plano.json
 *   node dist/ops-funcionario.mjs liquidar apply <planHash> --executor … < plano.json
 *
 * A liquidação usa o plano e a aplicação do `ops-settle` (pedido:
 * `{"items":[{"betId","newStatus","evidence","evidenceUrl"?}]}`), dentro da
 * trava e do teto do dono; a aposta com sugestão do IA-Judge aberta e o
 * mesmo resultado é homologada como no painel. Texto livre vai sempre como
 * `--evidencia=<texto>`: o texto pode começar com "-".
 *
 * Saída: 0 feito; 2 recusa (plano recusado, teto, caso ou aposta que não
 * serve); 3 aplicação que não gravou tudo (mudou depois do plano); 64 uso
 * errado. O que foi gravado sai sempre como gravado: a falha de um efeito
 * posterior vira `aviso` no JSON, não erro.
 * Regras: `src/services/ops/funcionario/`.
 */
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { DELEGATED_ACTOR } from "@/src/domain/production-write-actors";
import { disconnectPrisma } from "@/src/infra/prisma";
import { createLogger } from "@/src/infra/logger";
import {
  applyAgentSportPlan,
  applyFuncionarioSettlementPlan,
  applyVincularPlan,
  assertFuncionarioExecutor,
  buildAgentSportPlanForFuncionario,
  buildFuncionarioSettlementPlan,
  buildVincularPlan,
  deferTrainingCaseForAgent,
} from "@/src/services/ops/funcionario/escrita";
import { listPendencias, readBetFicha, readDaySummary } from "@/src/services/ops/funcionario/leitura";
import { resolveOperationalActionBySourceKey } from "@/src/services/ops/operational-actions";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

const USAGE = [
  "uso (sempre com --executor agent:<nome>:por:<dono>):",
  "  pendencias | ficha <betId> | resumo",
  "  vincular plan <caseId> <índice> <hash do candidato> --evidencia \"…\" | vincular apply <planHash> < plano.json",
  "  ignorar <caseId> --motivo \"…\"",
  "  esporte plan <betId> <esporte> --evidencia \"…\" | esporte apply <planHash> < plano.json",
  "  liquidar plan < pedido.json | liquidar apply <planHash> < plano.json",
].join("\n") + "\n";

/** A ação da caixa de Operações que a escrita resolveu: a fonte e a chave (o id do caso ou da aposta). */
export type ResolvedAction = { source: "training" | "sport-resolution" | "settlement.parado"; key: string };

export type FuncionarioIo = {
  readStdin: () => Promise<unknown>;
  /** Depois de uma escrita: a caixa de Operações fecha só o que o agente resolveu. */
  afterWrite: (resolved: ResolvedAction[], executor: string) => Promise<void>;
  now?: () => Date;
};

export type FuncionarioRun = { code: number; stdout: string; stderr: string };

const ok = (value: unknown, code = 0): FuncionarioRun => ({ code, stdout: JSON.stringify(value, null, 2) + "\n", stderr: "" });
const usage = (): FuncionarioRun => ({ code: 64, stdout: "", stderr: USAGE });

function isInteger(text: string | undefined): text is string {
  return text !== undefined && /^\d+$/.test(text);
}

const log = createLogger("ops-funcionario");

/**
 * A escrita já está gravada: a falha em fechar a ação da caixa vira aviso na
 * saída (a reconciliação do worker fecha depois), nunca erro da ferramenta.
 */
async function closeResolvedActions(io: FuncionarioIo, resolved: ResolvedAction[], executor: string): Promise<{ aviso?: string }> {
  try {
    await io.afterWrite(resolved, executor);
    return {};
  } catch (err) {
    log.warn({ err, resolved }, "escrita do agente gravada, mas a ação da caixa não foi fechada");
    return { aviso: "Gravado. A ação da caixa de Operações não foi fechada agora; o worker a fecha no próximo ciclo." };
  }
}

export async function runFuncionario(argv: readonly string[], io: FuncionarioIo): Promise<FuncionarioRun> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        executor: { type: "string" },
        evidencia: { type: "string" },
        motivo: { type: "string" },
      },
    });
  } catch {
    return usage();
  }
  const { values, positionals } = parsed;
  const executor = values.executor;
  if (!executor || !DELEGATED_ACTOR.test(executor)) return usage();
  const now = io.now?.() ?? new Date();
  const [command, sub, a, b, c, ...extra] = positionals;
  if (extra.length > 0 || (c !== undefined && !(command === "vincular" && sub === "plan"))) return usage();
  const saved = async (result: object, resolved: ResolvedAction[]) =>
    ok({ ...result, ...await closeResolvedActions(io, resolved, executor) });

  try {
    if (command === "pendencias" && !sub) {
      await assertFuncionarioExecutor(executor);
      return ok(await listPendencias(now));
    }
    if (command === "ficha" && sub && !a) {
      await assertFuncionarioExecutor(executor);
      const ficha = await readBetFicha(sub);
      return ficha ? ok(ficha) : ok({ erro: "Aposta não encontrada." }, 2);
    }
    if (command === "resumo" && !sub) {
      await assertFuncionarioExecutor(executor);
      return ok(await readDaySummary(executor, now));
    }
    if (command === "vincular" && sub === "plan" && a && isInteger(b) && c && /^[0-9a-f]{64}$/.test(c)) {
      if (values.evidencia === undefined) return usage();
      return ok(await buildVincularPlan({ caseId: a, candidateIndex: Number(b), candidateHash: c, evidence: values.evidencia, executor, now }));
    }
    if (command === "vincular" && sub === "apply" && a && !b) {
      const result = await applyVincularPlan(await io.readStdin(), a, executor, now);
      return result.kind === "saved" ? saved(result, [{ source: "training", key: result.caseId }]) : ok(result, 3);
    }
    if (command === "ignorar" && sub && !a) {
      if (values.motivo === undefined) return usage();
      const result = await deferTrainingCaseForAgent({ caseId: sub, reason: values.motivo, executor, now });
      return result.kind === "saved" ? saved(result, [{ source: "training", key: result.caseId }]) : ok(result, 3);
    }
    if (command === "esporte" && sub === "plan" && a && b) {
      if (values.evidencia === undefined) return usage();
      const result = await buildAgentSportPlanForFuncionario({ betId: a, sport: b, evidence: values.evidencia, executor, now });
      return result.ok ? ok(result.plan) : ok(result, 2);
    }
    if (command === "liquidar" && sub === "plan" && !a) {
      const result = await buildFuncionarioSettlementPlan({ request: await io.readStdin(), executor, now });
      return result.ok ? ok(result.plan) : ok(result, 2);
    }
    if (command === "liquidar" && sub === "apply" && a && !b) {
      const results = await applyFuncionarioSettlementPlan(await io.readStdin(), a, executor, now);
      const settled = results.flatMap((r) => r.kind === "saved" ? [{ source: "settlement.parado" as const, key: r.betId }] : []);
      const closing = settled.length > 0 ? await closeResolvedActions(io, settled, executor) : {};
      return ok({ results, ...closing }, results.every((r) => r.kind === "saved") ? 0 : 3);
    }
    if (command === "esporte" && sub === "apply" && a && !b) {
      const result = await applyAgentSportPlan(await io.readStdin(), a, executor, now);
      return result.kind === "saved" ? saved(result, [{ source: "sport-resolution", key: result.betId }]) : ok(result, 3);
    }
  } catch (error) {
    if (error instanceof RecusaDeNegocioError) return ok({ erro: error.message }, 2);
    if (error instanceof ZodError) return ok({ erro: "Entrada inválida.", detalhes: error.issues.map((i) => i.message) }, 2);
    throw error;
  }
  return usage();
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main(): Promise<number> {
  const run = await runFuncionario(process.argv.slice(2), {
    readStdin,
    afterWrite: async (resolved, executor) => {
      for (const { source, key } of resolved) {
        await resolveOperationalActionBySourceKey(source, key, `Resolvida pelo agente do dono (${executor}).`);
      }
    },
  });
  if (run.stderr) process.stderr.write(run.stderr);
  // As pendências podem ser grandes: espera a saída terminar (num pipe,
  // `process.exit` descartaria o resto em silêncio).
  await new Promise<void>((resolve) => process.stdout.write(run.stdout, () => resolve()));
  return run.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `exit` depois da saída escrita: o pg-boss do enrich prenderia o processo.
  main()
    .then(async (code) => { await disconnectPrisma(); process.exit(code); })
    .catch(async (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      await disconnectPrisma();
      process.exit(1);
    });
}
