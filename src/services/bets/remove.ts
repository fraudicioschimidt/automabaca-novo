import { recordCaptureFollowupTx } from "@/src/services/scheduling/enqueue-after-capture";
import { computeLucroFromStatus, validateCashoutLucro } from "@/src/domain/lucro";
import { BET_UNIT_MIN_AMOUNT, roundMoney, sumMoneyBy, toNumber, unitsToBrl } from "@/src/domain/money";
import { postExternalIdsWhere, postIdOfExternalId } from "@/src/domain/telegram-source";
import { OperationalRisk, type BetStatus, Prisma } from "@/src/generated/prisma/client";
import { finishSoftDeleteBet, finishNotTakenRestore } from "./remove-effects";
import { clearAutomaticEvidenceOnReopenTx, resolveRestoredBetContaTx } from "./settle";
import { persistirLiquidacaoSemContaTx } from "./settle-effects";
import { readSettlementEvidenceTx } from "@/src/services/settlement/bet-result";
import { processMovimentacaoFromBetTx } from "@/src/services/contas/movements";
import { closeOpenTrainingCaseForDeletedBetTx } from "@/src/services/sharp/enrich/training-cases";
import { reportOperationalActionTx } from "@/src/services/ops/operational-actions";
import { resolverAcoesDoRecursoTx } from "@/src/services/ops/action-resource-gc";
import { prisma } from "@/src/infra/prisma";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import {
  type SerializableTransactionClient,
  reuseSerializableTransaction,
  runSerializableTransaction,
} from "@/src/services/shared/transaction";

/**
 * Quem removeu: o 👎 no canal ou o painel. Tirar o 👎 só desfaz o que o 👎
 * fez; o que o painel removeu só o painel restaura.
 */
export type RemovalOrigin = "reacao" | "painel";

function recordOf(details: unknown): Record<string, unknown> | null {
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : null;
}

/**
 * A origem gravada no AuditEvent da remoção. Registro sem origem é anterior a
 * ela: com a marca de restaurável veio do 👎 (o único caminho que a gravava);
 * sem a marca, da exclusão pelo painel.
 */
function removalOriginOf(details: unknown, restorable: boolean): RemovalOrigin {
  const origin = recordOf(details)?.origin;
  if (origin === "reacao" || origin === "painel") return origin;
  return restorable ? "reacao" : "painel";
}

/**
 * Aposta liquidada há mais de 7 dias não sai pelo 👎 nem pela remoção em lote:
 * o resultado já entrou em saldo e relatórios, e tirá-la exige olhar a ficha.
 * Vira revisão no painel.
 */
export const REMOVAL_REVIEW_AFTER_MS = 7 * 86_400_000;

export function removalNeedsReview(
  bet: { status: string; settledAt: Date | null; deletedAt: Date | null },
  now: Date = new Date(),
): boolean {
  return !bet.deletedAt && bet.status !== "PENDING" && bet.settledAt != null
    && now.getTime() - bet.settledAt.getTime() > REMOVAL_REVIEW_AFTER_MS;
}


const RESTORABLE_STATUSES: ReadonlySet<string> = new Set([
  "PENDING", "WON", "LOST", "HALF_WON", "HALF_LOST", "VOID", "CASHOUT", "CANCELED",
]);

function stateBeforeSoftDelete(
  details: unknown,
  terms: { stake: number; odds: number },
): {
  status: BetStatus;
  lucro: number;
  settledAt: Date | null;
} | null {
  const record = recordOf(details);
  if (
    !record ||
    typeof record.previousStatus !== "string" ||
    !RESTORABLE_STATUSES.has(record.previousStatus) ||
    typeof record.previousLucro !== "number" ||
    !Number.isFinite(record.previousLucro)
  ) return null;
  const status = record.previousStatus as BetStatus;
  const settledAt = typeof record.previousSettledAt === "string"
      && Number.isFinite(Date.parse(record.previousSettledAt))
    ? new Date(record.previousSettledAt)
    : record.previousSettledAt === null
      ? null
      : undefined;
  if (settledAt === undefined || (status === "PENDING") !== (settledAt === null)) {
    return null;
  }
  const lucro = record.previousLucro;
  try {
    const canonical = status === "CASHOUT"
      ? validateCashoutLucro({ lucro, ...terms })
      : computeLucroFromStatus({ status, ...terms });
    if (Math.abs(roundMoney(lucro) - canonical) >= BET_UNIT_MIN_AMOUNT) {
      return null;
    }
  } catch {
    return null;
  }
  return { status, lucro, settledAt };
}

/** A revisão desempata remoções com o mesmo horário; empate sem prova não restaura dinheiro. */
function latestRemovalAuditSql(betId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT CASE WHEN count(*) OVER (PARTITION BY "createdAt", details->'removalVersion') > 1
      THEN NULL ELSE details END AS details
    FROM audit_events
    WHERE resource = 'bet' AND "resourceId" = ${betId} AND action = 'bet.soft_delete'
      AND "createdAt" = (
        SELECT "createdAt" FROM audit_events
        WHERE resource = 'bet' AND "resourceId" = ${betId} AND action = 'bet.soft_delete'
        ORDER BY "createdAt" DESC LIMIT 1
      )
    ORDER BY CASE WHEN jsonb_typeof(details->'removalVersion') = 'number'
        THEN (details->>'removalVersion')::numeric ELSE 0 END DESC
    LIMIT 1
  `;
}

/**
 * Remoção de aposta (👎 no canal, remoção pelo painel) = SOFT-DELETE
 * restaurável: reverte o efeito no ledger (estorno do líquido), marca
 * `deletedAt` e `notTakenAt` e grava no AuditEvent o estado anterior e a
 * origem, que `restoreRemovedBet` lê. A linha permanece — o unique (source,
 * sourceExternalId) impede que um edit do post recapture a aposta removida.
 * Idempotente: a segunda remoção não troca a origem da primeira.
 */
export async function softDeleteBet(
  params: { betId: string; actor: string; motivo: string; origin: RemovalOrigin },
  options?: { client?: SerializableTransactionClient; deferEffects?: boolean },
): Promise<{ alreadyDeleted: boolean }> {
  const result = await runSerializableTransaction(
    "softDeleteBet",
    async (tx) => {
      const bet = await tx.bet.findUniqueOrThrow({
        where: { id: params.betId },
        select: {
          id: true,
          deletedAt: true,
          contaId: true,
          stake: true,
          odds: true,
          valorUnidade: true,
          status: true,
          lucro: true,
          settledAt: true,
        },
      });
      if (bet.deletedAt) return { alreadyDeleted: true };

      const deletedAt = new Date();
      const removed = await tx.bet.update({
        where: { id: bet.id },
        data: {
          deletedAt,
          status: "CANCELED",
          lucro: 0,
          // CANCELED e terminal: preserva o instante da primeira liquidação
          // ou materializa o instante desta decisão quando ainda era PENDING.
          settledAt: bet.settledAt ?? deletedAt,
          notTakenAt: deletedAt,
        },
        select: { manualSettlementVersion: true },
      });

      // PENDING não gera lançamento novo — só o estorno do efeito líquido.
      // Depois do update, como na liquidação: a aposta trava antes da conta.
      await processMovimentacaoFromBetTx(tx, {
        betId: bet.id,
        newStatus: "PENDING",
        lucroUnidades: 0,
        valorUnidade: toNumber(bet.valorUnidade),
        contaId: bet.contaId,
        actor: params.actor,
      });

      // Soft-delete fecha treino OPEN; senão a fila humana fica órfã.
      await closeOpenTrainingCaseForDeletedBetTx(tx, bet.id);

      // A sugestão deixa de ser acionável junto com a aposta. Resolver na mesma
      // transação evita um card órfão até o próximo ciclo de limpeza.
      await tx.iaJudgeSuggestion.updateMany({
        where: { betId: bet.id, status: "PENDING" },
        data: { status: "REJECTED", resolvedAt: new Date(), resolvedBy: params.actor },
      });

      // A aposta deixa de ser acionável neste commit; seus cartões precisam
      // encerrar no mesmo commit. A varredura de 5 min continua como repair,
      // mas o operador não pode receber "Liquidar" para um jogo já excluído.
      await resolverAcoesDoRecursoTx(tx, {
        resource: "bet",
        resourceId: bet.id,
        actor: params.actor,
        now: deletedAt,
        resolutionNote: "Aposta excluída — nada mais a decidir nesta ação.",
      });

      await tx.auditEvent.create({
        data: {
          actor: params.actor,
          action: "bet.soft_delete",
          resource: "bet",
          resourceId: bet.id,
          details: {
            motivo: params.motivo,
            origin: params.origin,
            removalVersion: removed.manualSettlementVersion,
            previousStatus: bet.status,
            previousLucro: toNumber(bet.lucro),
            previousSettledAt: bet.settledAt?.toISOString() ?? null,
          },
        },
      });

      return { alreadyDeleted: false };
    },
    options,
  );

  if (!options?.deferEffects) await finishSoftDeleteBet(params.betId, result);

  return result;
}

export type RestoreResult = {
  changed: boolean;
  restoredStatus?: BetStatus | null;
  captureFollowupId?: string;
  blocked?: "missing_soft_delete_snapshot";
  /** Removida pelo painel: tirar o 👎 não a traz de volta. */
  panelOnly?: true;
};

/**
 * Restaura a aposta removida com o estado financeiro gravado no AuditEvent da
 * remoção. `by` é quem pede: o 👎 retirado só restaura o que o 👎 removeu, e o
 * painel restaura qualquer remoção. Sem snapshot íntegro a restauração é
 * bloqueada para revisão humana: inventar PENDING/lucro zero corromperia o
 * ledger de uma aposta antes liquidada.
 */
export async function restoreRemovedBet(
  params: { betId: string; actor: string; motivo: string; by: RemovalOrigin },
  options?: { client?: SerializableTransactionClient; deferEffects?: boolean },
): Promise<RestoreResult> {
  const result = await runSerializableTransaction(
    "restoreRemovedBet",
    async (tx) => {
      const bet = await tx.bet.findUniqueOrThrow({
        where: { id: params.betId },
        select: {
          id: true,
          notTakenAt: true,
          deletedAt: true,
          contaId: true,
          stake: true,
          odds: true,
          valorUnidade: true,
        },
      });
      if (!bet.notTakenAt) return { changed: false, restoredStatus: null };

      const [deletion] = await tx.$queryRaw<Array<{ details: Prisma.JsonValue | null }>>(
        latestRemovalAuditSql(Prisma.sql`${bet.id}`),
      );
      if (params.by === "reacao" && removalOriginOf(deletion?.details, true) === "painel") {
        return { changed: false, restoredStatus: null, panelOnly: true as const };
      }
      const previous = stateBeforeSoftDelete(deletion?.details, {
        stake: toNumber(bet.stake),
        odds: toNumber(bet.odds),
      });
      if (!previous) {
        await reportOperationalActionTx(tx, {
          source: "bet.not-taken-restore",
          key: bet.id,
          area: "apostas",
          actionType: "bet.restore.review",
          title: "Aposta não restaurada porque falta o estado financeiro anterior",
          description: "A restauração foi pedida, mas o AuditEvent da remoção está ausente ou incompleto. Revise status, lucro e ledger antes de restaurar.",
          priority: 85,
          risk: OperationalRisk.HIGH,
          resource: "bet",
          resourceId: bet.id,
          evidence: { reason: "missing_soft_delete_snapshot" },
          autoResolve: false,
        });
        await tx.auditEvent.create({
          data: {
            actor: params.actor,
            action: "bet.not_taken_undo_blocked",
            resource: "bet",
            resourceId: bet.id,
            details: { motivo: params.motivo, reason: "missing_soft_delete_snapshot" },
          },
        });
        return { changed: false, blocked: "missing_soft_delete_snapshot" as const };
      }

      // A remoção estornou o ledger: a volta lança de novo, na conta que a
      // liquidação escolheria hoje (a conta da aposta pode ter saído depois).
      const conta = bet.deletedAt ? await resolveRestoredBetContaTx(tx, bet.id, previous.status, previous.lucro) : null;
      const previousEvidence = previous.status === "PENDING" ? await readSettlementEvidenceTx(tx, bet.id) : undefined;
      await tx.bet.update({
        where: { id: bet.id },
        data: {
          notTakenAt: null,
          deletedAt: null,
          status: previous.status,
          lucro: previous.lucro,
          settledAt: previous.status === "PENDING"
            ? null
            : (previous.settledAt ?? bet.notTakenAt),
          ...(conta && conta.contaId !== bet.contaId ? { contaId: conta.contaId } : {}),
        },
      });
      if (previous.status === "PENDING") await clearAutomaticEvidenceOnReopenTx(tx, bet.id);
      if (conta) {
        await processMovimentacaoFromBetTx(tx, {
          betId: bet.id,
          newStatus: previous.status,
          lucroUnidades: previous.lucro,
          valorUnidade: toNumber(bet.valorUnidade),
          contaId: conta.contaId,
          actor: params.actor,
        });
        await persistirLiquidacaoSemContaTx(tx, bet.id, {
          status: previous.status,
          lucro: previous.lucro,
          previousStatus: "CANCELED",
          semContaElegivel: conta.semContaElegivel,
        }, { ledgerPosted: conta.ledgerPosted });
      }
      const restoration = await tx.auditEvent.create({
        data: {
          actor: params.actor,
          action: "bet.not_taken_undone",
          resource: "bet",
          resourceId: bet.id,
          details: {
            previousEvidence,
            motivo: params.motivo, restoredStatus: previous.status, restoredLucro: previous.lucro,
            restoredSettledAt: previous.status === "PENDING" ? null : (previous.settledAt ?? bet.notTakenAt).toISOString(),
            contaId: conta ? conta.contaId : bet.contaId, valorUnidade: toNumber(bet.valorUnidade),
          },
        },
      });
      const captureFollowupId = previous.status === "PENDING"
        ? await recordCaptureFollowupTx(tx, bet.id, "not-taken-undone", params.actor, restoration.id)
        : undefined;
      return { changed: true, restoredStatus: previous.status, captureFollowupId };
    },
    options,
  );

  if (!options?.deferEffects) await finishNotTakenRestore(params.betId, result);

  return result;
}

/**
 * Trava, em ordem de id, as apostas que uma transação vai remover em
 * sequência (o 👎 no post, a remoção em lote). A liquidação trava a aposta e
 * depois a conta: o lote que estornasse a conta de uma aposta antes de chegar
 * à irmã que a liquidação já travou fecharia o ciclo. NO KEY não barra os
 * INSERTs que apontam para a aposta (movimentações, eventos de liquidação).
 */
export async function lockBetsForRemovalTx(tx: Prisma.TransactionClient, betIds: readonly string[]): Promise<void> {
  if (betIds.length === 0) return;
  await tx.$queryRaw`SELECT id FROM bets WHERE id = ANY(${[...betIds]}::text[]) ORDER BY id FOR NO KEY UPDATE`;
}

// ───────────── Remoção em lote pelo painel ─────────────

const batchBetSelect = {
  id: true, source: true, sourceExternalId: true, evento: true, selecao: true, status: true,
  stake: true, lucro: true, valorUnidade: true, settledAt: true, deletedAt: true,
} satisfies Prisma.BetSelect;
type BatchBet = Prisma.BetGetPayload<{ select: typeof batchBetSelect }>;

/** Uma aposta do lote como a tela a mostra. */
export type BatchRemovalBet = {
  id: string;
  evento: string;
  selecao: string;
  status: BetStatus;
  stake: number;
  /** Em unidades; o que o estorno desfaz de uma liquidada. */
  lucro: number;
  settledAt: string | null;
};

/** O que a confirmação mostrou de cada aposta que sai. */
export type ConfirmedRemoval = Pick<BatchRemovalBet, "id" | "status" | "lucro">;

export type BatchRemovalPlan = {
  /** O que sai: as marcadas e as outras apostas do mesmo post. */
  remove: BatchRemovalBet[];
  /** Liquidadas há mais de 7 dias: ficam, e viram revisão. */
  review: BatchRemovalBet[];
  /** Quantas entram por serem do mesmo post de uma marcada. */
  fromSamePost: number;
  /** Marcadas que já não estão na banca (removidas por outro caminho). */
  missing: number;
  stakeUnits: number;
  stakeReais: number;
  /** Resultado das liquidadas que o estorno desfaz. */
  resultUnits: number;
  resultReais: number;
};

function viewOf(bet: BatchBet): BatchRemovalBet {
  return {
    id: bet.id,
    evento: bet.evento,
    selecao: bet.selecao,
    status: bet.status,
    stake: toNumber(bet.stake),
    lucro: toNumber(bet.lucro),
    settledAt: bet.settledAt?.toISOString() ?? null,
  };
}

/**
 * As marcadas e, como no 👎, as outras apostas do mesmo post na mesma banca
 * (mesma origem e mesma mensagem). Aposta sem post de origem sai sozinha.
 */
async function batchBetsTx(tx: Prisma.TransactionClient, bankrollId: string, betIds: readonly string[]) {
  const selected = await tx.bet.findMany({
    where: { id: { in: [...betIds] }, bankrollId, deletedAt: null },
    select: batchBetSelect,
  });
  const postsBySource = new Map<string, Set<string>>();
  for (const bet of selected) {
    if (!bet.sourceExternalId) continue;
    const posts = postsBySource.get(bet.source) ?? new Set<string>();
    posts.add(postIdOfExternalId(bet.sourceExternalId));
    postsBySource.set(bet.source, posts);
  }
  const samePost = postsBySource.size === 0 ? [] : await tx.bet.findMany({
    where: {
      bankrollId,
      deletedAt: null,
      OR: [...postsBySource].map(([source, posts]) => ({ source, ...postExternalIdsWhere([...posts]) })),
    },
    select: batchBetSelect,
  });
  const all = new Map([...selected, ...samePost].map((bet) => [bet.id, bet]));
  const bets = [...all.values()].sort((a, b) => a.evento.localeCompare(b.evento) || a.id.localeCompare(b.id));
  return { bets, selectedFound: selected.length };
}

function planOf(
  bets: readonly BatchBet[],
  selectedFound: number,
  requested: number,
  now: Date,
): BatchRemovalPlan & { removeBets: BatchBet[]; reviewBets: BatchBet[] } {
  const reviewBets = bets.filter((bet) => removalNeedsReview(bet, now));
  const removeBets = bets.filter((bet) => !removalNeedsReview(bet, now));
  const settled = removeBets.filter((bet) => bet.status !== "PENDING");
  return {
    remove: removeBets.map(viewOf),
    review: reviewBets.map(viewOf),
    fromSamePost: Math.max(0, bets.length - selectedFound),
    missing: Math.max(0, requested - selectedFound),
    stakeUnits: sumMoneyBy(removeBets, (bet) => toNumber(bet.stake)),
    stakeReais: sumMoneyBy(removeBets, (bet) => unitsToBrl(toNumber(bet.stake), toNumber(bet.valorUnidade)), 2),
    resultUnits: sumMoneyBy(settled, (bet) => toNumber(bet.lucro)),
    resultReais: sumMoneyBy(settled, (bet) => unitsToBrl(toNumber(bet.lucro), toNumber(bet.valorUnidade)), 2),
    removeBets,
    reviewBets,
  };
}

function publicPlan(plan: ReturnType<typeof planOf>): BatchRemovalPlan {
  const { removeBets: _remove, reviewBets: _review, ...rest } = plan;
  return rest;
}

/**
 * A remoção grava o lote que a confirmação mostrou, como o `planHash` do
 * ops-settle: aposta liquidada depois da prévia muda o estorno, e aposta nova
 * do mesmo post sairia sem ter sido vista. Devolve o motivo da recusa, ou null
 * se o lote é o mesmo.
 */
function changedSincePreview(
  plan: BatchRemovalPlan,
  confirmed: readonly ConfirmedRemoval[],
  requested: ReadonlySet<string>,
): string | null {
  const shown = new Map(confirmed.map((bet) => [bet.id, bet]));
  const current = new Set(plan.remove.map((bet) => bet.id));
  const changes: string[] = [];
  for (const bet of plan.remove) {
    const before = shown.get(bet.id);
    const name = `${bet.evento} — ${bet.selecao}`;
    if (!before) {
      changes.push(requested.has(bet.id) ? `${name} voltou ao tipster` : `${name}, do mesmo post, entrou depois da prévia`);
    } else if (before.status !== bet.status || roundMoney(before.lucro) !== roundMoney(bet.lucro)) {
      changes.push(before.status === "PENDING" ? `${name} foi liquidada` : `${name} mudou de resultado`);
    }
  }
  const gone = confirmed.filter((bet) => !current.has(bet.id)).length;
  if (gone > 0) changes.push(gone === 1 ? "1 aposta da prévia já saiu do lote" : `${gone} apostas da prévia já saíram do lote`);
  if (changes.length === 0) return null;
  const listed = changes.slice(0, 3).join("; ");
  const more = changes.length > 3 ? ` e mais ${changes.length - 3}` : "";
  return `O lote mudou depois da prévia: ${listed}${more}. Confira de novo antes de remover.`;
}

/** O que a remoção em lote faria, sem gravar nada: é o que a confirmação mostra. */
export async function planBatchRemoval(params: { bankrollId: string; betIds: readonly string[] }): Promise<BatchRemovalPlan> {
  const { bets, selectedFound } = await batchBetsTx(prisma, params.bankrollId, params.betIds);
  if (bets.length === 0) throw new RecusaDeNegocioError("Nenhuma das apostas marcadas está mais na lista do tipster.");
  return publicPlan(planOf(bets, selectedFound, params.betIds.length, new Date()));
}

/**
 * Remove as apostas marcadas e as do mesmo post com o efeito do 👎: estorno e
 * restauráveis (`restoreBetsInBatch`), com origem no painel. Só grava se o lote
 * ainda for o que a confirmação mostrou (`confirmed`). Tudo numa transação; a
 * liquidada há mais de 7 dias fica e vira revisão, como no 👎.
 */
export async function removeBetsInBatch(params: {
  bankrollId: string;
  betIds: readonly string[];
  confirmed: readonly ConfirmedRemoval[];
  actor: string;
}): Promise<BatchRemovalPlan> {
  const now = new Date();
  const outcome = await runSerializableTransaction("removeBetsInBatch", async (tx) => {
    const { bets, selectedFound } = await batchBetsTx(tx, params.bankrollId, params.betIds);
    if (bets.length === 0) throw new RecusaDeNegocioError("Nenhuma das apostas marcadas está mais na lista do tipster.");
    const plan = planOf(bets, selectedFound, params.betIds.length, now);
    const changed = changedSincePreview(plan, params.confirmed, new Set(params.betIds));
    if (changed) throw new RecusaDeNegocioError(changed);
    await lockBetsForRemovalTx(tx, plan.removeBets.map((bet) => bet.id));
    const options = { client: reuseSerializableTransaction(tx), deferEffects: true };
    const removed: Array<{ betId: string; result: { alreadyDeleted: boolean } }> = [];
    for (const bet of plan.removeBets) {
      const result = await softDeleteBet({ betId: bet.id, actor: params.actor, motivo: "remoção em lote pelo painel", origin: "painel" }, options);
      removed.push({ betId: bet.id, result });
    }
    for (const bet of plan.reviewBets) {
      await reportOperationalActionTx(tx, {
        source: "bet.batch-removal-review",
        key: bet.id,
        area: "apostas",
        actionType: "bet.removal.review",
        title: "Remoção em lote requer confirmação na ficha",
        description: `${bet.evento} — ${bet.selecao} foi liquidada há mais de 7 dias e ficou fora da remoção em lote. Exclua pela ficha, se for o caso.`,
        priority: 60,
        risk: OperationalRisk.MEDIUM,
        resource: "bet",
        resourceId: bet.id,
        evidence: { reason: "aposta_liquidada_requer_painel", settledAt: bet.settledAt?.toISOString() ?? null },
        autoResolve: false,
      }, now);
    }
    await tx.auditEvent.create({
      data: {
        actor: params.actor,
        action: "bet.batch_remove",
        resource: "bankroll",
        resourceId: params.bankrollId,
        details: {
          requested: [...params.betIds],
          removed: plan.removeBets.map((bet) => bet.id),
          review: plan.reviewBets.map((bet) => bet.id),
        },
      },
    });
    return { plan: publicPlan(plan), removed };
  });
  for (const { betId, result } of outcome.removed) await finishSoftDeleteBet(betId, result);
  return outcome.plan;
}

/**
 * Restauração pelo painel: o "Desfazer" do toast, a lista "Removidas" e a
 * ficha. Volta com o estado financeiro anterior, qualquer que seja a origem.
 */
export async function restoreBetsInBatch(params: {
  bankrollId: string;
  betIds: readonly string[];
  actor: string;
}): Promise<{ restored: string[]; blocked: string[] }> {
  const outcome = await runSerializableTransaction("restoreBetsInBatch", async (tx) => {
    const bets = await tx.bet.findMany({
      where: { id: { in: [...params.betIds] }, bankrollId: params.bankrollId, notTakenAt: { not: null } },
      select: { id: true },
    });
    const options = { client: reuseSerializableTransaction(tx), deferEffects: true };
    const results: Array<{ betId: string; result: RestoreResult }> = [];
    for (const bet of bets) {
      const result = await restoreRemovedBet({ betId: bet.id, actor: params.actor, motivo: "restaurada pelo painel", by: "painel" }, options);
      results.push({ betId: bet.id, result });
    }
    return results;
  });
  for (const { betId, result } of outcome) await finishNotTakenRestore(betId, result);
  return {
    restored: outcome.filter(({ result }) => result.changed).map(({ betId }) => betId),
    blocked: outcome.filter(({ result }) => result.blocked).map(({ betId }) => betId),
  };
}

// ───────────── A remoção na lista e na ficha ─────────────

/** Como a lista "Removidas" e a ficha mostram uma aposta removida. */
export type BetRemoval = {
  at: Date;
  origin: RemovalOrigin;
  /** Sem a marca (exclusão anterior à restauração), não volta pelo painel. */
  restorable: boolean;
  /** O status e o lucro de antes da remoção, que o estorno desfez. */
  previous: { status: BetStatus; lucro: number } | null;
};

/** A remoção de cada aposta removida entre `betIds`, pelo AuditEvent da remoção. */
export async function describeRemovals(betIds: readonly string[], client: Prisma.TransactionClient = prisma): Promise<Map<string, BetRemoval>> {
  if (betIds.length === 0) return new Map();
  // Um probe por aposta devolve só a remoção mais recente: a lista não
  // transfere todos os snapshots antigos nem escolhe a última no processo web.
  const bets = await client.$queryRaw<Array<{
    id: string; deletedAt: Date | null; notTakenAt: Date | null; details: Prisma.JsonValue | null;
  }>>`
    SELECT bet.id, bet."deletedAt", bet."notTakenAt", audit.details
    FROM bets AS bet
    LEFT JOIN LATERAL (
      ${latestRemovalAuditSql(Prisma.sql`bet.id`)}
    ) AS audit ON true
    WHERE bet.id = ANY(${[...betIds]}::text[]) AND bet."deletedAt" IS NOT NULL
  `;
  const removals = new Map<string, BetRemoval>();
  for (const bet of bets) {
    if (!bet.deletedAt) continue;
    const details = recordOf(bet.details);
    const status = typeof details?.previousStatus === "string" && RESTORABLE_STATUSES.has(details.previousStatus)
      ? details.previousStatus as BetStatus
      : null;
    const lucro = typeof details?.previousLucro === "number" && Number.isFinite(details.previousLucro) ? details.previousLucro : null;
    removals.set(bet.id, {
      at: bet.deletedAt,
      origin: removalOriginOf(details, bet.notTakenAt !== null),
      restorable: bet.notTakenAt !== null,
      previous: status && lucro !== null ? { status, lucro } : null,
    });
  }
  return removals;
}
