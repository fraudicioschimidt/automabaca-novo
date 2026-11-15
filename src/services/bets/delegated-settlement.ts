import type { Prisma } from "@/src/generated/prisma/client";
import { isMultiFixtureTicket } from "@/src/domain/bet-legs";
import { ticketForScore } from "@/src/domain/settlement/ticket-resolution";
import { approveIaJudgeSuggestion } from "@/src/services/settlement/ia-judge/suggestions";
import { allowsSettlementWithoutConfirmedSport, assertSettlementKickoff } from "@/src/services/bets/settle";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";
import {
  delegatedSettlementActor,
  delegatedSettlementInputSchema,
  delegatedSettlementPlanHash,
  delegatedSettlementPlanSchema,
  delegatedSettlementRequestId,
  type DelegatedSettlementPlan,
  type DelegatedSettlementPlanItem,
} from "@/src/domain/delegated-settlement";
import { computeLucroFromStatus } from "@/src/domain/lucro";
import { prisma } from "@/src/infra/prisma";
import { settleManualFromView } from "@/src/services/bets/manual-settlement";
import { RecusaDeNegocioError, recusaMessageOrThrow } from "@/src/services/shared/recusa";

import type { TransactionWriteGuard } from "@/src/services/shared/transaction";

export const DELEGATED_SETTLEMENT_AUDIT_ACTION = "bet.settle_delegated";

/** Sem sugestão do IA-Judge aberta, só depois disto do início: o jogo em andamento não se liquida. */
const SETTLE_AFTER_KICKOFF_MS = 3 * 3_600_000;

type DelegatedSettlementGate = {
  data: Date;
  kickoffInferido: boolean;
  multiFixture: boolean;
  openSuggestion: { id: string; suggestedStatus: string } | null;
};

const settlementGateSelect = {
  id: true, data: true, kickoffInferido: true, updatedAt: true, evento: true, mercado: true, selecao: true, legsJson: true,
  judgeSuggestions: {
    where: { status: "PENDING" as const }, orderBy: { createdAt: "desc" as const }, take: 1,
    select: { id: true, suggestedStatus: true, betUpdatedAt: true },
  },
} as const;

function settlementGateOf(bet: Prisma.BetGetPayload<{ select: typeof settlementGateSelect }>): DelegatedSettlementGate {
  const suggestion = bet.judgeSuggestions[0];
  const ticket = ticketForScore(bet);
  const fresh = suggestion?.betUpdatedAt?.getTime() === bet.updatedAt.getTime();
  return {
    data: bet.data, kickoffInferido: bet.kickoffInferido,
    multiFixture: ticket !== null && isMultiFixtureTicket(ticket),
    openSuggestion: suggestion && fresh ? { id: suggestion.id, suggestedStatus: suggestion.suggestedStatus } : null,
  };
}

/** A mesma leitura no ops-settle e no funcionário, inclusive dentro do commit financeiro. */
export async function readDelegatedSettlementGates(
  betIds: readonly string[], db: Pick<Prisma.TransactionClient, "bet"> = prisma,
): Promise<Map<string, DelegatedSettlementGate>> {
  const bets = await db.bet.findMany({ where: { id: { in: [...betIds] } }, select: settlementGateSelect });
  return new Map(bets.map((bet) => [bet.id, settlementGateOf(bet)]));
}

/** Múltipla só com sugestão atual do mesmo resultado; simples sem ela exige 3 h de kickoff confirmado. */
export function delegatedSettlementRefusal(gate: DelegatedSettlementGate | undefined, newStatus: string, now: Date): string | null {
  if (!gate) return null;
  if (gate.openSuggestion?.suggestedStatus === newStatus) return null;
  const without = "sem sugestão aberta do IA-Judge com esse resultado";
  if (gate.multiFixture) return `múltipla (as pernas não têm horário): ${without}, fica para o dono`;
  if (gate.kickoffInferido) return `horário do jogo provisório: ${without}, fica para o dono`;
  if (gate.data.getTime() > now.getTime() - SETTLE_AFTER_KICKOFF_MS) {
    return `jogo em andamento ou começou há menos de 3 h: ${without}, espere o jogo terminar`;
  }
  return null;
}

export type DelegatedPlanRefusal = { betId: string; reason: string };
export type DelegatedPlanResult =
  | { ok: true; plan: DelegatedSettlementPlan }
  | { ok: false; refusals: DelegatedPlanRefusal[] };

export type DelegatedApplyItemResult = (
  | { betId: string; kind: "saved"; lucro: number; duplicate: boolean }
  | { betId: string; kind: "conflict"; currentStatus: string; currentVersion: number }
  | { betId: string; kind: "unavailable" | "refused"; message: string }
) & { via?: "ia-judge" | "recibo" | null };

/** Quem aprova precisa ser um usuário real do painel (tem época de sessão). */
export async function assertPanelUser(username: string): Promise<void> {
  const known = await prisma.authSessionState.findUnique({ where: { username }, select: { username: true } });
  if (!known) throw new RecusaDeNegocioError(`"${username}" não é usuário do painel; a aprovação precisa ser de um operador real.`);
}

/**
 * Monta o plano sem gravar nada. Recusa o lote inteiro se QUALQUER item não puder
 * ser liquidado agora: plano parcial esconderia do dono o que ficou de fora.
 */
export async function buildDelegatedSettlementPlan(raw: unknown, now = new Date()): Promise<DelegatedPlanResult> {
  const input = delegatedSettlementInputSchema.parse(raw);
  await assertPanelUser(input.approvedBy);
  const bets = await prisma.bet.findMany({
    where: { id: { in: input.items.map((item) => item.betId) } },
    select: {
      ...settlementGateSelect,
      status: true, deletedAt: true, manualSettlementVersion: true, odds: true, stake: true, sportResolutionStatus: true,
      bankroll: { select: { slug: true } },
    },
  });
  const byId = new Map(bets.map((bet) => [bet.id, bet]));
  const refusals: DelegatedPlanRefusal[] = [];
  const items: DelegatedSettlementPlanItem[] = [];
  for (const item of input.items) {
    const bet = byId.get(item.betId);
    if (!bet) { refusals.push({ betId: item.betId, reason: "aposta não encontrada" }); continue; }
    if (bet.deletedAt) { refusals.push({ betId: item.betId, reason: "aposta removida" }); continue; }
    // Só para frente: trocar resultado já liquidado é re-liquidação, decisão do painel.
    if (bet.status !== "PENDING") { refusals.push({ betId: item.betId, reason: `aposta não está pendente (${bet.status})` }); continue; }
    // Mesmas recusas do settlement, antecipadas para o plano não prometer o que o apply recusaria.
    if (bet.sportResolutionStatus !== "CONFIRMED" && !allowsSettlementWithoutConfirmedSport(item.newStatus, `manual:${input.approvedBy}`)) {
      refusals.push({ betId: item.betId, reason: "esporte da aposta não confirmado" }); continue;
    }
    if ((item.newStatus === "HALF_WON" || item.newStatus === "HALF_LOST") && !admitsAsianFractionalSettlement(bet.mercado, bet.selecao)) {
      refusals.push({ betId: item.betId, reason: `mercado não admite ${item.newStatus}` }); continue;
    }
    try {
      assertSettlementKickoff(bet, item.newStatus, now);
    } catch (error) {
      refusals.push({ betId: item.betId, reason: error instanceof Error ? error.message : "kickoff inválido" });
      continue;
    }
    const unfinished = delegatedSettlementRefusal(settlementGateOf(bet), item.newStatus, now);
    if (unfinished) { refusals.push({ betId: item.betId, reason: unfinished }); continue; }
    const odds = Number(bet.odds);
    const stake = Number(bet.stake);
    items.push({
      betId: bet.id,
      bankrollSlug: bet.bankroll.slug,
      newStatus: item.newStatus,
      expectedVersion: bet.manualSettlementVersion,
      evidence: item.evidence,
      ...(item.evidenceUrl ? { evidenceUrl: item.evidenceUrl } : {}),
      preview: {
        evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao, data: bet.data.toISOString(),
        odds, stake, lucroPrevisto: computeLucroFromStatus({ status: item.newStatus, stake, odds }),
      },
    });
  }
  if (refusals.length > 0) return { ok: false, refusals };
  const body = { version: 1 as const, agent: input.agent, approvedBy: input.approvedBy, createdAt: now.toISOString(), items };
  return { ok: true, plan: { ...body, planHash: delegatedSettlementPlanHash(body) } };
}

/**
 * O plano como veio, conferido: o hash recalculado precisa ser o aprovado, e
 * quem aprova, usuário do painel. Plano editado depois da revisão não passa.
 */
export async function verifyDelegatedSettlementPlan(raw: unknown, approvedPlanHash: string): Promise<DelegatedSettlementPlan> {
  const plan = delegatedSettlementPlanSchema.parse(raw);
  const { planHash, ...body } = plan;
  if (delegatedSettlementPlanHash(body) !== planHash) {
    throw new RecusaDeNegocioError("O plano foi alterado depois de gerado; gere um novo plano.");
  }
  if (approvedPlanHash !== planHash) {
    throw new RecusaDeNegocioError("O hash aprovado não corresponde a este plano.");
  }
  await assertPanelUser(plan.approvedBy);
  return plan;
}

/** Um item do plano conferido: homologa a sugestão atual ou grava pelo recibo do painel. */
export async function applyDelegatedSettlementItem(
  plan: DelegatedSettlementPlan,
  item: DelegatedSettlementPlanItem,
  options?: { beforeWrite?: TransactionWriteGuard; now?: Date },
): Promise<DelegatedApplyItemResult> {
  try {
    const actor = delegatedSettlementActor(plan.agent, plan.approvedBy);
    const details = {
      agent: plan.agent, approvedBy: plan.approvedBy, planHash: plan.planHash,
      evidence: item.evidence, ...(item.evidenceUrl ? { evidenceUrl: item.evidenceUrl } : {}),
    };
    // Homologação não usa recibo manual: a auditoria do plano é sua prova idempotente.
    const approved = await prisma.auditEvent.findFirst({
      where: { actor, action: DELEGATED_SETTLEMENT_AUDIT_ACTION, resourceId: item.betId,
        AND: [{ details: { path: ["planHash"], equals: plan.planHash } }, { details: { path: ["via"], equals: "ia-judge" } }] },
      select: { details: true },
    });
    if (approved) {
      const saved = approved.details as { lucro: number };
      return { betId: item.betId, kind: "saved", lucro: saved.lucro, duplicate: true, via: "ia-judge" };
    }
    const gates = await readDelegatedSettlementGates([item.betId]);
    const suggestion = gates.get(item.betId)?.openSuggestion;
    if (suggestion?.suggestedStatus === item.newStatus) {
      await approveIaJudgeSuggestion({
        suggestionId: suggestion.id, actor,
        delegated: { betId: item.betId, expectedVersion: item.expectedVersion,
          audit: { action: DELEGATED_SETTLEMENT_AUDIT_ACTION, details: { ...details, via: "ia-judge" } } },
      }, options);
      const saved = await prisma.bet.findUniqueOrThrow({ where: { id: item.betId }, select: { lucro: true } });
      return { betId: item.betId, kind: "saved", lucro: Number(saved.lucro), duplicate: false, via: "ia-judge" };
    }
    const reply = await settleManualFromView({
      betId: item.betId,
      bankrollSlug: item.bankrollSlug,
      newStatus: item.newStatus,
      requirePending: true,
      // Mesmo significado do painel: decisão manual do dono, que delegou.
      source: `manual:${plan.approvedBy}`,
      confirmation: {
        expectedVersion: item.expectedVersion,
        requestId: delegatedSettlementRequestId(plan.planHash, item.betId),
      },
      audit: {
        actor, action: DELEGATED_SETTLEMENT_AUDIT_ACTION, details,
      },
    }, {
      beforeWrite: options?.beforeWrite,
      beforeSettlement: async (tx) => {
        const current = (await readDelegatedSettlementGates([item.betId], tx)).get(item.betId);
        const refusal = delegatedSettlementRefusal(current, item.newStatus, options?.now ?? new Date());
        if (refusal) throw new RecusaDeNegocioError(refusal);
        // Uma sugestão criada entre a leitura e o commit precisa ser homologada.
        if (current?.openSuggestion?.suggestedStatus === item.newStatus) {
          throw new RecusaDeNegocioError("Surgiu uma sugestão do IA-Judge com esse resultado; gere um novo plano para homologá-la.");
        }
      },
    });
    if (reply.kind === "saved") return { betId: item.betId, kind: "saved", lucro: reply.lucro, duplicate: reply.duplicate };
    if (reply.kind === "conflict") return { betId: item.betId, kind: "conflict", currentStatus: reply.current.status, currentVersion: reply.current.version };
    return { betId: item.betId, kind: "unavailable", message: reply.message };
  } catch (error) {
    // Recusa de negócio (kickoff, esporte não confirmado…) não derruba o resto do lote.
    return { betId: item.betId, kind: "refused", message: recusaMessageOrThrow(error) };
  }
}

/** Aplica exatamente o plano aprovado (`ops-settle apply`). */
export async function applyDelegatedSettlementPlan(
  raw: unknown,
  approvedPlanHash: string,
): Promise<DelegatedApplyItemResult[]> {
  const plan = await verifyDelegatedSettlementPlan(raw, approvedPlanHash);
  const results: DelegatedApplyItemResult[] = [];
  for (const item of plan.items) results.push(await applyDelegatedSettlementItem(plan, item));
  return results;
}
