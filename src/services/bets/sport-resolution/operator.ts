import { runSerializableTransaction, reuseSerializableTransaction, type TransactionWriteGuard } from "@/src/services/shared/transaction";
import { z } from "zod";
import { SportResolutionSource, SportResolutionStatus } from "@/src/generated/prisma/enums";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { DELEGATED_ACTOR } from "@/src/domain/production-write-actors";
import { WEB_SPORT_MEMORY_PROVIDER } from "@/src/domain/sport-resolution-retry";
import { CANONICAL_SPORTS, canonicalSport, type CanonicalSport } from "@/src/domain/sports/registry";
import { getSharedBoss } from "@/src/infra/boss";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { deleteProviderCache } from "@/src/providers/provider-cache";
import { StaleSportResolutionError } from "@/src/services/bets/edit";
import { assertPanelUser } from "@/src/services/bets/delegated-settlement";
import { BetRemovedError } from "@/src/services/bets/settle";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import { bornInSportConflict, SPORT_RESOLUTION_HISTORY_WINDOW_MS } from "./decision";
import { confirmBetSport, resolvePendingBetSport } from "./resolve";
import type { SportCandidate, SportResolutionRun } from "./types";

/**
 * Resolução de esporte pedida por um agente em nome do dono (`ops-resolve-sport`).
 *
 * A aposta nomeada é o dono pedindo aquela: a simulação é forçada (janela
 * histórica, web e conflito da captura) e vira um plano com hash. A aplicação
 * grava exatamente o plano aprovado, sem consultar fornecedor nem web de novo,
 * e recusa se a aposta mudou depois dele: o resolvedor refeito poderia achar
 * outro jogo, e o dono aprovou aquele. O lote de `--all` não força e passa
 * pelas guardas do resolvedor: aplicado, faz o que o ciclo automático faria.
 */

const log = createLogger("sport-resolution-operator");

const OPERATOR_AUDIT_ACTION = "bet.sport_resolve.operator";

function assertExecutor(executor: string): void {
  if (!DELEGATED_ACTOR.test(executor)) throw new Error("executor precisa ser agent:<nome>:por:<dono>");
}

/** Quem grava: o executor no formato delegado, com o dono usuário do painel. */
async function assertWritingExecutor(executor: string): Promise<void> {
  assertExecutor(executor);
  await assertPanelUser(DELEGATED_ACTOR.exec(executor)?.[1] ?? "");
}

/**
 * Como a fila do resolvedor: sem o enrich a aposta confirmada não ganha
 * identidade nem CLV. Se a fila falhar, o revive do sharp a acha depois.
 */
async function enqueueEnrichAfterOperator(betId: string): Promise<void> {
  await enqueueSharpEnrich(await getSharedBoss(), betId, { origem: "sport-resolved-operator" }).catch((err: unknown) => {
    log.warn({ err, betId }, "esporte confirmado pelo operador, mas o enrich não foi enfileirado");
  });
}

/** Teto do lote de `--all`, das apostas mais recentes para as mais antigas. */
const OPERATOR_BATCH_LIMIT = 100;

/**
 * O lote de `--all`: PENDING dentro da janela em que o resolvedor ainda roda
 * (`sportResolutionWindowOpen`), das mais recentes para as mais antigas, sem
 * as que nasceram em conflito na captura, que são do dono.
 */
async function operatorBatch(now: Date): Promise<string[]> {
  const rows = await prisma.bet.findMany({
    where: {
      deletedAt: null,
      sportResolutionStatus: SportResolutionStatus.PENDING,
      OR: [{ kickoffInferido: true }, { data: { gte: new Date(now.getTime() - SPORT_RESOLUTION_HISTORY_WINDOW_MS) } }],
    },
    orderBy: [{ registradoEm: "desc" }, { id: "asc" }],
    take: OPERATOR_BATCH_LIMIT,
    select: { id: true, sportEvidence: true, sportResolutionStatus: true },
  });
  return rows.filter((row) => !bornInSportConflict(row)).map((row) => row.id);
}

/**
 * `--all`: simula por padrão, sem gravar nem medir; aplicado, grava pelo
 * caminho do resolvedor, registra em `audit_events` quem pediu e o que saiu,
 * e manda a aposta confirmada para o enrich.
 */
export async function resolvePendingSportsForOperator(params: {
  executor: string;
  aplicar: boolean;
  now?: Date;
}): Promise<SportResolutionRun[]> {
  if (params.aplicar) await assertWritingExecutor(params.executor);
  else assertExecutor(params.executor);
  const now = params.now ?? new Date();
  const runs: SportResolutionRun[] = [];
  for (const betId of await operatorBatch(now)) {
    const run = await resolvePendingBetSport(betId, { evaluateOnly: !params.aplicar, now });
    runs.push(run);
    if (!params.aplicar || run.status === "ignored") continue;
    await prisma.auditEvent.create({ data: {
      actor: params.executor, action: OPERATOR_AUDIT_ACTION, resource: "bet", resourceId: betId,
      details: { status: run.status, reason: run.reason, forced: false, sport: run.candidate?.sport ?? null,
        confidence: run.candidate?.confidence ?? null, source: run.candidate?.source ?? null },
    } });
    if (run.status === "resolved") await enqueueEnrichAfterOperator(betId);
  }
  return runs;
}

// O candidato guarda o que o resolvedor achou (jogo, times, horário): só o
// que a gravação usa é conferido, e o resto entra no hash como veio.
const planCandidateSchema = z.looseObject({
  sport: z.enum(CANONICAL_SPORTS as [CanonicalSport, ...CanonicalSport[]]),
  confidence: z.number().min(0).max(100),
  source: z.enum(SportResolutionSource),
});

const sportResolutionPlanSchema = z.strictObject({
  version: z.literal(1),
  executor: z.string().regex(DELEGATED_ACTOR),
  createdAt: z.iso.datetime(),
  item: z.strictObject({
    betId: z.string().min(1),
    /** A revisão da aposta que a simulação leu. */
    expectedVersion: z.number().int().positive(),
    /** Só para revisão humana: não participa da gravação. */
    preview: z.strictObject({ evento: z.string(), mercado: z.string(), selecao: z.string() }),
    candidate: planCandidateSchema,
    candidates: z.array(planCandidateSchema),
    /** O que a confirmação grava além do esporte. */
    identity: z.strictObject({ data: z.iso.datetime(), kickoffInferido: z.boolean(), competicao: z.string(), pais: z.string() }),
    overriddenPostDissent: z.strictObject({
      sport: z.string(), confidence: z.number(), source: z.string(), provider: z.string().optional(), strategy: z.string().optional(),
      fromPost: z.boolean(),
    }).optional(),
  }),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SportResolutionPlan = z.infer<typeof sportResolutionPlanSchema>;

export type SportResolutionPlanResult =
  | { ok: true; plan: SportResolutionPlan }
  /** A simulação não confirmaria (pendente, em conflito, já confirmada): não há o que aplicar. */
  | { ok: false; run: SportResolutionRun };

/** A aposta nomeada: simula forçado, sem gravar nem medir, e devolve o plano. */
export async function buildSportResolutionPlan(params: {
  betId: string;
  executor: string;
  now?: Date;
}): Promise<SportResolutionPlanResult> {
  assertExecutor(params.executor);
  const now = params.now ?? new Date();
  const run = await resolvePendingBetSport(params.betId, { force: true, evaluateOnly: true, now });
  if (run.status !== "evaluated" || !run.candidate || !run.identity || run.expectedVersion === undefined) {
    return { ok: false, run };
  }
  const preview = await prisma.bet.findUniqueOrThrow({
    where: { id: params.betId },
    select: { evento: true, mercado: true, selecao: true },
  });
  // O hash é do JSON que o dono lê, e a aplicação o recalcula sobre o que recebe.
  const body = JSON.parse(JSON.stringify({
    version: 1,
    executor: params.executor,
    createdAt: now.toISOString(),
    item: {
      betId: params.betId,
      expectedVersion: run.expectedVersion,
      preview,
      candidate: run.candidate,
      candidates: run.candidates,
      identity: run.identity,
      ...(run.overriddenPostDissent ? { overriddenPostDissent: run.overriddenPostDissent } : {}),
    },
  })) as Omit<SportResolutionPlan, "planHash">;
  return { ok: true, plan: { ...body, planHash: canonicalSha256(body) } };
}

/** O que o agente conferiu para escolher o esporte: vai no plano, na evidência gravada e na trilha. */
const agentSportEvidenceSchema = z.string().trim().min(10).max(500);

export type AgentSportPlanResult =
  | { ok: true; plan: SportResolutionPlan }
  | { ok: false; betId: string; reason: "missing_or_deleted" | "already_confirmed"; message: string };

/**
 * O esporte escolhido pelo agente, não o do resolvedor: o plano tem o mesmo
 * formato e a mesma aplicação (`applySportResolutionPlan`), com a fonte
 * `MANUAL`, a evidência do agente e o país, a competição e o horário que a
 * aposta já tem. Nenhuma consulta externa.
 */
export async function buildAgentSportPlan(params: {
  betId: string;
  sport: string;
  evidence: string;
  executor: string;
  now?: Date;
}): Promise<AgentSportPlanResult> {
  assertExecutor(params.executor);
  const sport = canonicalSport(params.sport);
  if (!sport) throw new RecusaDeNegocioError(`Esporte desconhecido: ${params.sport}. Use um de: ${CANONICAL_SPORTS.join(", ")}.`);
  const evidence = agentSportEvidenceSchema.parse(params.evidence);
  const now = params.now ?? new Date();
  const bet = await prisma.bet.findUnique({
    where: { id: params.betId },
    select: {
      deletedAt: true, sportResolutionStatus: true, manualSettlementVersion: true, evento: true, mercado: true,
      selecao: true, data: true, kickoffInferido: true, competicao: true, pais: true,
    },
  });
  if (!bet || bet.deletedAt) {
    return { ok: false, betId: params.betId, reason: "missing_or_deleted", message: "A aposta não existe ou foi removida." };
  }
  if (bet.sportResolutionStatus === SportResolutionStatus.CONFIRMED) {
    return { ok: false, betId: params.betId, reason: "already_confirmed", message: "O esporte da aposta já foi confirmado; corrigir é do dono, pelo painel." };
  }
  const candidate = { sport, confidence: 100, source: SportResolutionSource.MANUAL, strategy: "agent_choice", evidence };
  const body = JSON.parse(JSON.stringify({
    version: 1,
    executor: params.executor,
    createdAt: now.toISOString(),
    item: {
      betId: params.betId,
      expectedVersion: bet.manualSettlementVersion,
      preview: { evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao },
      candidate,
      candidates: [candidate],
      identity: { data: bet.data.toISOString(), kickoffInferido: bet.kickoffInferido, competicao: bet.competicao, pais: bet.pais },
    },
  })) as Omit<SportResolutionPlan, "planHash">;
  return { ok: true, plan: { ...body, planHash: canonicalSha256(body) } };
}

export type SportResolutionApplyResult =
  | { betId: string; kind: "saved"; sport: CanonicalSport }
  | { betId: string; kind: "conflict"; message: string }
  | { betId: string; kind: "refused"; reason: "missing_or_deleted" | "already_confirmed"; message: string };

/**
 * Grava exatamente o plano aprovado: `approvedPlanHash` precisa bater com o
 * hash recalculado, e quem aplica é o executor do plano, a pedido de um
 * usuário do painel. Nenhuma consulta externa; a aposta que mudou depois do
 * plano (edição, confirmação pelo painel ou pelo ciclo automático) é recusada
 * sem gravar.
 */
export async function applySportResolutionPlan(
  raw: unknown,
  approvedPlanHash: string,
  executor: string,
  options?: { beforeWrite?: TransactionWriteGuard },
): Promise<SportResolutionApplyResult> {
  const plan = sportResolutionPlanSchema.parse(raw);
  const { planHash: _planHash, ...body } = raw as Record<string, unknown>;
  if (canonicalSha256(body) !== plan.planHash) {
    throw new RecusaDeNegocioError("O plano foi alterado depois de gerado; gere um novo plano.");
  }
  if (approvedPlanHash !== plan.planHash) throw new RecusaDeNegocioError("O hash aprovado não corresponde a este plano.");
  if (plan.executor !== executor) throw new RecusaDeNegocioError("O plano é de outro executor.");
  await assertWritingExecutor(executor);
  const { item } = plan;
  const betId = item.betId;
  const removed = { betId, kind: "refused", reason: "missing_or_deleted", message: "A aposta não existe ou foi removida." } as const;
  const changed = { betId, kind: "conflict", message: "A aposta mudou depois do plano; gere um novo plano." } as const;
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: {
      id: true, manualSettlementVersion: true, deletedAt: true, sportResolutionStatus: true,
      evento: true, mercado: true, selecao: true, odds: true, stake: true, casaDeAposta: true,
    },
  });
  if (!bet || bet.deletedAt) return removed;
  if (bet.sportResolutionStatus === SportResolutionStatus.CONFIRMED) {
    return { betId, kind: "refused", reason: "already_confirmed", message: "O esporte da aposta já foi confirmado." };
  }
  if (bet.manualSettlementVersion !== item.expectedVersion) return changed;
  try {
    await runSerializableTransaction("applySportResolutionPlan", async (tx) => {
      await confirmBetSport({
        // A revisão do plano: a porta de edição recusa se a aposta mudou depois da leitura acima.
        bet: { ...bet, manualSettlementVersion: item.expectedVersion },
        candidate: item.candidate as SportCandidate,
        candidates: item.candidates as SportCandidate[],
        now: new Date(plan.createdAt),
        identity: { ...item.identity, data: new Date(item.identity.data) },
        evidence: { planHash: plan.planHash },
      }, { client: reuseSerializableTransaction(tx) });
      await tx.auditEvent.create({ data: {
        actor: plan.executor, action: OPERATOR_AUDIT_ACTION, resource: "bet", resourceId: betId,
        details: {
          status: "resolved", reason: "operator_plan", forced: true, planHash: plan.planHash,
          sport: item.candidate.sport, confidence: item.candidate.confidence, source: item.candidate.source,
          ...(typeof item.candidate.evidence === "string" ? { evidence: item.candidate.evidence } : {}),
          ...(item.overriddenPostDissent ? { overriddenPostDissent: item.overriddenPostDissent } : {}),
        },
      } });
    }, options);
  } catch (err) {
    if (err instanceof StaleSportResolutionError) return changed;
    if (err instanceof BetRemovedError) return removed;
    throw err;
  }
  // O esporte já está gravado: a memória da busca na web que sobrar só deixa lixo, e o enrich segue.
  await deleteProviderCache({ provider: WEB_SPORT_MEMORY_PROVIDER, keyPrefix: betId }).catch((err: unknown) => {
    log.warn({ err, betId }, "esporte confirmado pelo operador, mas a memória da busca na web não foi apagada");
  });
  await enqueueEnrichAfterOperator(betId);
  return { betId, kind: "saved", sport: item.candidate.sport };
}
