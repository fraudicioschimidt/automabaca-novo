import type { TransactionWriteGuard } from "@/src/services/shared/transaction";
import { z } from "zod";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { DELEGATED_ACTOR } from "@/src/domain/production-write-actors";
import { getSharedBoss } from "@/src/infra/boss";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import {
  delegatedSettlementActor,
  type DelegatedSettlementPlan,
  type DelegatedSettlementPlanItem,
} from "@/src/domain/delegated-settlement";
import { Prisma } from "@/src/generated/prisma/client";
import {
  applyDelegatedSettlementItem,
  assertPanelUser,
  buildDelegatedSettlementPlan,
  DELEGATED_SETTLEMENT_AUDIT_ACTION,
  readDelegatedSettlementGates as settleGates,
  delegatedSettlementRefusal as settleRefusal,
  verifyDelegatedSettlementPlan,
  type DelegatedApplyItemResult,
  type DelegatedPlanResult,
} from "@/src/services/bets/delegated-settlement";
import {
  applySportResolutionPlan,
  buildAgentSportPlan,
  type AgentSportPlanResult,
  type SportResolutionApplyResult,
} from "@/src/services/bets/sport-resolution/operator";
import { enqueueSharpEnrich } from "@/src/services/scheduling/enqueue-enrich";
import { recusaMessageOrThrow, RecusaDeNegocioError } from "@/src/services/shared/recusa";
import {
  ignorarTrainingCase,
  previewTrainingCaseResolution,
  resolverTrainingCase,
  TrainingCaseConflictError,
} from "@/src/services/sharp/training-resolve";
import { approveIaJudgeSuggestion } from "@/src/services/settlement/ia-judge/suggestions";
import type { ChosenGameTeaching } from "@/src/services/teams/tipster-names";

/**
 * O que o funcionário de IA grava (`ops-funcionario`), sempre pelas mesmas
 * funções do painel e dos outros `ops-*`: o Vincular, o adiamento do caso e o
 * esporte escolhido. Quem grava é o executor delegado (`agent:<nome>:por:<dono>`,
 * com o dono usuário do painel), com evidência.
 *
 * O Vincular, o esporte e a liquidação passam por plano com hash: `plan` não
 * grava e mostra o que vai mudar; `apply` grava só o plano daquele hash, e
 * recusa se o caso ou a aposta mudou depois. Toda escrita conta no teto do
 * dono (50 em 24 h, 10 por minuto, somando os agentes dele), lido das
 * auditorias e conferido na mesma transação da decisão: chamadas concorrentes
 * não furam o teto.
 */

const log = createLogger("ops-funcionario");

export const FUNCIONARIO_WRITE_LIMITS = { perDay: 50, perMinute: 10 } as const;

const DEFER_ACTION = "training_case.defer";

/** Uma auditoria por decisão: é por elas que o teto conta. */
export const FUNCIONARIO_WRITE_ACTIONS = [
  "training_case.resolve",
  DEFER_ACTION,
  "bet.sport_resolve.operator",
  DELEGATED_SETTLEMENT_AUDIT_ACTION,
] as const;

/**
 * A decisão de agente com prova, em `audit_events`: uma das ações acima com a
 * evidência (ou o motivo do adiamento) nos detalhes. É o que o funcionário e
 * o `ops-settle` gravam; o lote do `ops-resolve-sport`, sem evidência, fica
 * de fora. O teto e a revisão diária de escritas usam a mesma condição.
 */
export const DELEGATED_DECISION_SQL = Prisma.sql`(
  (action = ${DEFER_ACTION} AND details->>'reason' IS NOT NULL)
  OR (action IN (${Prisma.join(FUNCIONARIO_WRITE_ACTIONS.filter((action) => action !== DEFER_ACTION))})
    AND details->>'evidence' IS NOT NULL)
)`;

/** Os agentes de um dono: `agent:<qualquer>:por:<dono>`. */
const actorOfOwnerSql = (owner: string) => Prisma.sql`(
  split_part(actor, ':', 1) = 'agent' AND split_part(actor, ':', 3) = 'por'
  AND split_part(actor, ':', 4) = ${owner} AND split_part(actor, ':', 5) = ''
)`;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type WriteBudget = {
  usadasEm24h: number;
  usadasNoMinuto: number;
  restamEm24h: number;
  restamNoMinuto: number;
};

/** O teto é do dono: conta as decisões de todos os agentes dele, não só as do executor. */
export async function readWriteBudget(
  executor: string,
  now = new Date(),
  db: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma,
): Promise<WriteBudget> {
  const { owner } = executorParts(executor);
  const [counts] = await db.$queryRaw<[{ day: number; minute: number }]>(Prisma.sql`
    SELECT count(*)::int AS day,
      (count(*) FILTER (WHERE "createdAt" > ${new Date(now.getTime() - MINUTE_MS)}))::int AS minute
    FROM audit_events
    WHERE ${actorOfOwnerSql(owner)} AND ${DELEGATED_DECISION_SQL}
      AND "createdAt" > ${new Date(now.getTime() - DAY_MS)}
  `);
  const day = counts.day;
  const minute = counts.minute;
  return {
    usadasEm24h: day,
    usadasNoMinuto: minute,
    restamEm24h: Math.max(0, FUNCIONARIO_WRITE_LIMITS.perDay - day),
    restamNoMinuto: Math.max(0, FUNCIONARIO_WRITE_LIMITS.perMinute - minute),
  };
}

function assertFits(budget: WriteBudget, writes: number): void {
  if (writes > budget.restamEm24h) {
    throw new RecusaDeNegocioError(
      `Teto de escritas: ${budget.usadasEm24h} de ${FUNCIONARIO_WRITE_LIMITS.perDay} nas últimas 24 h, somando os agentes do dono; o pedido tem ${writes}. O resto fica para o dono.`,
    );
  }
  if (writes > budget.restamNoMinuto) {
    throw new RecusaDeNegocioError(
      `Teto de escritas: ${budget.usadasNoMinuto} de ${FUNCIONARIO_WRITE_LIMITS.perMinute} no último minuto, somando os agentes do dono; espere um minuto.`,
    );
  }
}

/** O lote cabe antes de começar; cada decisão confere de novo dentro do seu commit. */
async function withWriteBudget<T>(executor: string, writes: number, now: Date, write: (guard: TransactionWriteGuard) => Promise<T>): Promise<T> {
  const clock = () => new Date(Math.max(now.getTime(), Date.now()));
  assertFits(await readWriteBudget(executor, clock()), writes);
  // SERIALIZABLE protege a leitura do orçamento e o INSERT da auditoria na
  // mesma transação. Um conflito retenta ambos; timeout reverte ambos.
  return write(async (tx) => assertFits(await readWriteBudget(executor, clock(), tx), 1));
}

/** `agent:<nome>:por:<dono>`, e o dono precisa ser usuário do painel. */
export async function assertFuncionarioExecutor(executor: string): Promise<void> {
  await assertPanelUser(executorParts(executor).owner);
}

function executorParts(executor: string): { agent: string; owner: string } {
  const owner = DELEGATED_ACTOR.exec(executor)?.[1];
  const agent = executor.split(":")[1];
  if (!owner || !agent) throw new RecusaDeNegocioError("O executor precisa ser agent:<nome>:por:<dono>.");
  return { agent, owner };
}

/** O que o agente conferiu e onde: obrigatório em toda escrita. */
const evidenceSchema = z.string().trim().min(10, "evidência: diga o que conferiu e onde (10 a 500 caracteres)").max(500);

function parseEvidence(value: string | undefined): string {
  const parsed = evidenceSchema.safeParse(value ?? "");
  if (!parsed.success) throw new RecusaDeNegocioError(parsed.error.issues[0]?.message ?? "evidência inválida");
  return parsed.data;
}

export type FuncionarioApplyResult<Saved extends object> =
  | ({ kind: "saved" } & Saved)
  | { kind: "conflict" | "refused"; message: string };

/**
 * O plano como veio: o hash é recalculado sobre ele (sem o `planHash`), e
 * precisa ser o aprovado e do mesmo executor que aplica.
 */
function verifiedPlan<T extends { planHash: string; executor: string }>(
  schema: z.ZodType<T>,
  raw: unknown,
  approvedHash: string,
  executor: string,
): T {
  const plan = schema.parse(raw);
  const { planHash: _planHash, ...body } = raw as Record<string, unknown>;
  if (canonicalSha256(body) !== plan.planHash) {
    throw new RecusaDeNegocioError("O plano foi alterado depois de gerado; gere um novo plano.");
  }
  if (approvedHash !== plan.planHash) throw new RecusaDeNegocioError("O hash aprovado não corresponde a este plano.");
  if (plan.executor !== executor) throw new RecusaDeNegocioError("O plano é de outro executor.");
  return plan;
}

function withHash<T extends object>(body: T): T & { planHash: string } {
  // O hash é do JSON que o dono (ou o agente) lê; a aplicação o recalcula sobre o que recebe.
  const json = JSON.parse(JSON.stringify(body)) as T;
  return { ...json, planHash: canonicalSha256(json) };
}

// ───────────── Vincular ─────────────

const vincularPlanSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("vincular"),
  executor: z.string().regex(DELEGATED_ACTOR),
  createdAt: z.iso.datetime(),
  caseId: z.string().min(1),
  candidateIndex: z.number().int().min(0),
  /** O candidato como estava no caso: a aplicação recusa se ele mudou. */
  candidate: z.record(z.string(), z.unknown()),
  evidence: evidenceSchema,
  /** Só para revisão: não participa da gravação. */
  preview: z.strictObject({
    betId: z.string().nullable(),
    eventoDepois: z.string(),
    pais: z.string(),
    competicao: z.string(),
    inicio: z.string().nullable(),
    nomes: z.array(z.record(z.string(), z.unknown())),
  }),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type VincularPlan = z.infer<typeof vincularPlanSchema>;

/**
 * O plano do Vincular: o jogo que a aposta recebe e os nomes que as fichas
 * aprendem. Não grava, e recusa se o candidato do índice já não é o que o
 * agente leu.
 */
export async function buildVincularPlan(params: {
  caseId: string;
  candidateIndex: number;
  /** O hash do candidato que o agente leu em `pendencias`/`ficha`: o índice sozinho não prova qual jogo ele viu. */
  candidateHash: string;
  evidence: string;
  executor: string;
  now?: Date;
}): Promise<VincularPlan> {
  await assertFuncionarioExecutor(params.executor);
  const evidence = parseEvidence(params.evidence);
  const preview = await previewTrainingCaseResolution({
    caseId: params.caseId, candidateIndex: params.candidateIndex, actor: params.executor,
  });
  if (canonicalSha256(preview.candidate) !== params.candidateHash) {
    throw new RecusaDeNegocioError("Os candidatos do caso mudaram desde a leitura (o hash não é o do candidato deste índice); leia a ficha de novo.");
  }
  return withHash({
    version: 1 as const,
    kind: "vincular" as const,
    executor: params.executor,
    createdAt: (params.now ?? new Date()).toISOString(),
    caseId: params.caseId,
    candidateIndex: params.candidateIndex,
    candidate: preview.candidate as unknown as Record<string, unknown>,
    evidence,
    preview: {
      betId: preview.betId,
      eventoDepois: preview.eventoDepois,
      pais: preview.plano.pais,
      competicao: preview.plano.competicao,
      inicio: preview.plano.kickoff?.toISOString() ?? null,
      nomes: preview.nomes.map((n) => ({ ...n })),
    },
  });
}

export async function applyVincularPlan(
  raw: unknown,
  approvedHash: string,
  executor: string,
  now = new Date(),
): Promise<FuncionarioApplyResult<{ caseId: string; betId: string | null; nomes: ChosenGameTeaching[] }>> {
  const plan = verifiedPlan(vincularPlanSchema, raw, approvedHash, executor);
  await assertFuncionarioExecutor(plan.executor);
  const result = await withWriteBudget(plan.executor, 1, now, async (beforeWrite): Promise<FuncionarioApplyResult<{
    caseId: string; betId: string | null; nomes: ChosenGameTeaching[];
  }>> => {
    const current = await prisma.trainingCase.findUnique({
      where: { id: plan.caseId },
      select: { status: true, candidatesJson: true },
    });
    if (!current) return { kind: "refused", message: "O caso não existe mais." };
    if (current.status !== "OPEN") return { kind: "conflict", message: `O caso já não está aberto (${current.status}).` };
    const candidate = Array.isArray(current.candidatesJson) ? current.candidatesJson[plan.candidateIndex] : undefined;
    if (candidate === undefined || canonicalSha256(candidate) !== canonicalSha256(plan.candidate)) {
      return { kind: "conflict", message: "Os candidatos do caso mudaram depois do plano; gere um novo plano." };
    }
    try {
      const resolved = await resolverTrainingCase({
        caseId: plan.caseId, candidateIndex: plan.candidateIndex, actor: plan.executor, evidence: plan.evidence,
        expectedCandidateHash: canonicalSha256(plan.candidate),
      }, { beforeWrite });
      return { kind: "saved", caseId: plan.caseId, ...resolved };
    } catch (error) {
      if (error instanceof TrainingCaseConflictError) return { kind: "conflict", message: error.message };
      return { kind: "refused", message: recusaMessageOrThrow(error) };
    }
  });
  if (result.kind === "saved" && result.betId) await enqueueEnrich(result.betId);
  return result;
}

/** Como o Vincular do painel: sem o enrich a aposta vinculada não ganha fechamento nem CLV. */
async function enqueueEnrich(betId: string): Promise<void> {
  try {
    await enqueueSharpEnrich(await getSharedBoss(), betId, { origem: "funcionario-vincular" });
  } catch (err) {
    log.warn({ err, betId }, "aposta vinculada pelo agente, mas o enrich não foi enfileirado; o revive a acha depois");
  }
}

// ───────────── Adiar o caso ─────────────

/** O "Ignorar" do Vincular: fecha o caso por 2 h, com o motivo na trilha. Sem plano: não mexe na aposta. */
export async function deferTrainingCaseForAgent(params: {
  caseId: string;
  reason: string;
  executor: string;
  now?: Date;
}): Promise<FuncionarioApplyResult<{ caseId: string }>> {
  await assertFuncionarioExecutor(params.executor);
  const reason = parseEvidence(params.reason);
  return withWriteBudget(params.executor, 1, params.now ?? new Date(), async (beforeWrite) => {
    try {
      await ignorarTrainingCase(params.caseId, params.executor, reason, { beforeWrite });
      return { kind: "saved" as const, caseId: params.caseId };
    } catch (error) {
      return { kind: "refused" as const, message: recusaMessageOrThrow(error) };
    }
  });
}

// ───────────── Esporte ─────────────

export async function buildAgentSportPlanForFuncionario(params: {
  betId: string;
  sport: string;
  evidence: string;
  executor: string;
  now?: Date;
}): Promise<AgentSportPlanResult> {
  await assertFuncionarioExecutor(params.executor);
  return buildAgentSportPlan({ ...params, evidence: parseEvidence(params.evidence) });
}

/** Aplica o plano de esporte pelo caminho do `ops-resolve-sport`, depois do teto. */
export async function applyAgentSportPlan(
  raw: unknown,
  approvedHash: string,
  executor: string,
  now = new Date(),
): Promise<SportResolutionApplyResult> {
  await assertFuncionarioExecutor(executor);
  return withWriteBudget(executor, 1, now, (beforeWrite) => applySportResolutionPlan(raw, approvedHash, executor, { beforeWrite }));
}

// ───────────── Liquidação ─────────────

const settleRequestSchema = z.strictObject({
  items: z.array(z.strictObject({
    betId: z.string(),
    newStatus: z.string(),
    evidence: z.string(),
    evidenceUrl: z.string().optional(),
  })).min(1),
});

/**
 * O plano da liquidação do agente: o mesmo do `ops-settle`, com o agente e o
 * dono tirados do executor, e só com aposta que o agente pode liquidar. Não grava.
 */
export async function buildFuncionarioSettlementPlan(params: {
  request: unknown;
  executor: string;
  now?: Date;
}): Promise<DelegatedPlanResult> {
  await assertFuncionarioExecutor(params.executor);
  const now = params.now ?? new Date();
  const { agent, owner } = executorParts(params.executor);
  const request = settleRequestSchema.parse(params.request);
  const gates = await settleGates(request.items.map((item) => item.betId));
  const refusals = request.items.flatMap((item) => {
    const reason = settleRefusal(gates.get(item.betId), item.newStatus, now);
    return reason ? [{ betId: item.betId, reason }] : [];
  });
  if (refusals.length > 0) return { ok: false, refusals };
  return buildDelegatedSettlementPlan({ agent, approvedBy: owner, items: request.items }, now);
}

export type FuncionarioSettleItemResult =
  | (DelegatedApplyItemResult & { via: "ia-judge" | "recibo" | null; aviso?: string })
  | { betId: string; kind: "unknown"; message: string; via: null };

/**
 * Aplica o plano aprovado, item a item, com o teto em cada commit. A aposta
 * com sugestão do IA-Judge aberta e o mesmo resultado é homologada pelo
 * caminho do painel (`approveIaJudgeSuggestion`, com o ator do agente): a
 * sugestão fica aprovada e a liquidação continua sendo do IA-Judge. As outras
 * vão pelo caminho com recibo do `ops-settle`. Todo item sai com resultado:
 * a falha técnica de um não esconde o que os outros gravaram.
 */
export async function applyFuncionarioSettlementPlan(
  raw: unknown,
  approvedHash: string,
  executor: string,
  now = new Date(),
): Promise<FuncionarioSettleItemResult[]> {
  const plan = await verifyDelegatedSettlementPlan(raw, approvedHash);
  if (delegatedSettlementActor(plan.agent, plan.approvedBy) !== executor) {
    throw new RecusaDeNegocioError("O plano é de outro executor.");
  }
  await assertFuncionarioExecutor(executor);
  return withWriteBudget(executor, plan.items.length, now, async (beforeWrite) => {
    const gates = await settleGates(plan.items.map((item) => item.betId));
    const results: FuncionarioSettleItemResult[] = [];
    for (const item of plan.items) {
      const gate = gates.get(item.betId);
      const refusal = settleRefusal(gate, item.newStatus, now);
      if (refusal) {
        results.push({ betId: item.betId, kind: "refused", message: refusal, via: null });
        continue;
      }
      const suggestion = gate?.openSuggestion?.suggestedStatus === item.newStatus ? gate.openSuggestion : null;
      try {
        if (suggestion) results.push(await approveSuggestionForAgent(plan, item, suggestion.id, executor, beforeWrite));
        else {
          const result = await applyDelegatedSettlementItem(plan, item, { beforeWrite, now });
          results.push({ ...result, via: result.via ?? "recibo" });
        }
      } catch (error) {
        results.push(await settlementAfterFailure(plan, item, error));
      }
    }
    return results;
  });
}

/**
 * A falha técnica pode ter vindo depois do commit (o aviso da liquidação, a
 * leitura do lucro): a auditoria deste plano diz se a aposta foi gravada.
 */
async function settlementAfterFailure(
  plan: DelegatedSettlementPlan,
  item: DelegatedSettlementPlanItem,
  error: unknown,
): Promise<FuncionarioSettleItemResult> {
  log.error({ err: error, betId: item.betId, planHash: plan.planHash }, "liquidação do agente: falha técnica no item");
  const cause = error instanceof Error ? error.message : String(error);
  try {
    const audit = await prisma.auditEvent.findFirst({
      where: {
        action: DELEGATED_SETTLEMENT_AUDIT_ACTION, resource: "bet", resourceId: item.betId,
        details: { path: ["planHash"], equals: plan.planHash },
      },
      select: { details: true },
    });
    if (!audit) return { betId: item.betId, kind: "unavailable", message: `Falha técnica, nada foi gravado: ${cause}`, via: null };
    const bet = await prisma.bet.findUniqueOrThrow({ where: { id: item.betId }, select: { lucro: true } });
    const via = (audit.details as { via?: unknown } | null)?.via === "ia-judge" ? "ia-judge" : "recibo";
    return {
      betId: item.betId, kind: "saved", lucro: Number(bet.lucro), duplicate: false, via,
      aviso: `A liquidação foi gravada, mas um efeito posterior falhou: ${cause}`,
    };
  } catch (readError) {
    log.error({ err: readError, betId: item.betId }, "liquidação do agente: não deu para conferir se o item foi gravado");
    return { betId: item.betId, kind: "unknown", message: `Resultado desconhecido (${cause}): confira a ficha da aposta antes de tentar de novo.`, via: null };
  }
}

async function approveSuggestionForAgent(
  plan: DelegatedSettlementPlan,
  item: DelegatedSettlementPlanItem,
  suggestionId: string,
  executor: string,
  beforeWrite: TransactionWriteGuard,
): Promise<FuncionarioSettleItemResult> {
  try {
    await approveIaJudgeSuggestion({
      suggestionId,
      actor: executor,
      delegated: {
        betId: item.betId,
        expectedVersion: item.expectedVersion,
        audit: {
          action: DELEGATED_SETTLEMENT_AUDIT_ACTION,
          details: {
            agent: plan.agent, approvedBy: plan.approvedBy, planHash: plan.planHash, via: "ia-judge",
            evidence: item.evidence, ...(item.evidenceUrl ? { evidenceUrl: item.evidenceUrl } : {}),
          },
        },
      },
    }, { beforeWrite });
    const bet = await prisma.bet.findUniqueOrThrow({ where: { id: item.betId }, select: { lucro: true } });
    return { betId: item.betId, kind: "saved", lucro: Number(bet.lucro), duplicate: false, via: "ia-judge" };
  } catch (error) {
    return { betId: item.betId, kind: "refused", message: recusaMessageOrThrow(error), via: "ia-judge" };
  }
}
