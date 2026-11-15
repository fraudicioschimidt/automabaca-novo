import { Prisma, type BetStatus } from "@/src/generated/prisma/client";
import { canonicalJson, canonicalSha256 } from "@/src/domain/canonical-json";
import { FINAL_BET_STATUSES_SET } from "@/src/domain/bet-status";
import { spDayKey } from "@/src/domain/dates";
import { computeLucroFromStatus, validateCashoutLucro, InvalidCashoutLucroError } from "@/src/domain/lucro";
import { BET_UNIT_MIN_AMOUNT, roundMoney, toNumber } from "@/src/domain/money";
import { settlementSourceActor } from "@/src/domain/production-write-actors";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";
import { isSameBookmaker, resolveContaAtivaParaCasa } from "@/src/services/contas/link";
import { processMovimentacaoFromBetTx } from "@/src/services/contas/movements";
import { readSettlementEvidenceTx } from "@/src/services/settlement/bet-result";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import {
  type SerializableTransactionClient,
  runSerializableTransaction,
} from "@/src/services/shared/transaction";
import { assertBetSettlementTermsTx, type BetSettlementTerms } from "./settle-terms";
import { finishBetStatusChange, persistirLiquidacaoSemContaTx } from "./settle-effects";

export type ApplyBetStatusChangeParams = {
  betId: string;
  newStatus: BetStatus;
  cashoutLucro?: number;
  source: string;
  requirePending?: boolean;
  /** Homologação: liga o evento à sugestão aprovada nesta mesma transação. */
  judgeSuggestionId?: string;
  /** Snapshot usado no cálculo externo; validado antes de qualquer efeito. */
  expectedTerms?: BetSettlementTerms;
};

/**
 * Por que o resultado não movimentou conta:
 * - `sem_conta_unica`: nenhuma (ou mais de uma) conta ATIVA da casa ligada à banca;
 * - `conta_limitada`: a casa só tem conta LIMITADA, que não recebe aposta nova;
 * - `conta_encerrada`: a conta desta aposta foi encerrada e não há outra elegível;
 * - `conta_removida`: a conta desta aposta foi removida (só na restauração: a
 *   conta não sai enquanto houver aposta viva nela) e não há outra elegível.
 */
export type NoAccountReason = "sem_conta_unica" | "conta_limitada" | "conta_encerrada" | "conta_removida";

export type ApplyBetStatusChangeResult = {
  status: BetStatus;
  lucro: number;
  previousStatus: BetStatus;
  semContaElegivel?: { casaDeAposta: string; bankrollId: string; reason: NoAccountReason };
};

export class BetNotPendingError extends Error {
  readonly betId: string;
  readonly currentStatus: BetStatus;

  constructor(betId: string, currentStatus: BetStatus) {
    super(
      `Aposta ${betId} não está pendente (status atual: ${currentStatus}) — liquidação automática ignorada.`,
    );
    this.name = "BetNotPendingError";
    this.betId = betId;
    this.currentStatus = currentStatus;
  }
}

export class SportNotConfirmedError extends RecusaDeNegocioError {
  readonly betId: string;

  constructor(betId: string) {
    super(
      `Aposta ${betId} ainda não possui esporte confirmado — liquidação aguardando resolução.`,
    );
    this.name = "SportNotConfirmedError";
    this.betId = betId;
  }
}

/** Soft-delete: edição/liquidação não deve reabrir ledger nem falhar o job. */
export class BetRemovedError extends RecusaDeNegocioError {
  readonly betId: string;

  constructor(betId: string, action: "edição" | "liquidação") {
    super(`Aposta ${betId} está removida — ${action} ignorada.`);
    this.name = "BetRemovedError";
    this.betId = betId;
  }
}

/** HALF só é permitido em mercados com linha asiática fracionária. */
export class InvalidSettlementMarketError extends RecusaDeNegocioError {
  readonly betId: string;
  constructor(betId: string, mercado: string, status: string) {
    super(`Aposta ${betId}: mercado "${mercado}" não admite liquidação como ${status}.`);
    this.name = "InvalidSettlementMarketError";
    this.betId = betId;
  }
}

export function assertSettlementKickoff(
  bet: { data: Date; kickoffInferido: boolean },
  newStatus: BetStatus,
  now: Date,
): void {
  if (!FINAL_BET_STATUSES_SET.has(newStatus) || newStatus === "CASHOUT") return;
  const future = bet.kickoffInferido
    ? spDayKey(now) <= spDayKey(bet.data)
    : bet.data.getTime() > now.getTime();
  if (!future) return;
  throw bet.kickoffInferido
    ? new RecusaDeNegocioError("A aposta possui kickoff provisório. Confirme o horário do evento antes de liquidá-la no mesmo dia.",
      { waitsFor: "o horário do evento for confirmado (ou o dia do jogo passar)" })
    : new RecusaDeNegocioError("Este evento é futuro. Aguarde o início do evento para registrar o resultado.",
      { waitsFor: "o evento começar" });
}

/**
 * Encerramentos financeiros manuais não dependem de placar nem esporte.
 * Cashout usa o lucro declarado; placar automático continua exigindo CONFIRMED.
 */
export function allowsSettlementWithoutConfirmedSport(
  newStatus: BetStatus,
  source: string,
): boolean {
  return (newStatus === "VOID" || newStatus === "CANCELED" || newStatus === "CASHOUT") &&
    (source === "manual" || source.startsWith("manual:"));
}

/** Evento idempotente por (aposta, tipo, hash do payload canônico). */
export async function insertSettlementEventTx(
  tx: Prisma.TransactionClient,
  params: { betId: string; type: string; payload: Record<string, unknown> },
): Promise<void> {
  const payloadHash = canonicalSha256(params.payload);
  await tx.$executeRaw`
    INSERT INTO "settlement_events" ("id", "betId", "type", "payload", "payloadHash", "createdAt")
    VALUES (
      gen_random_uuid()::text,
      ${params.betId},
      ${params.type},
      ${canonicalJson(params.payload)}::jsonb,
      ${payloadHash},
      now()
    )
    ON CONFLICT ("betId", "type", "payloadHash") DO NOTHING
  `;
}

const LEDGER_STATUSES: ReadonlySet<BetStatus> = new Set(["WON", "HALF_WON", "LOST", "HALF_LOST", "CASHOUT"]);

async function loadBetForSettlement(tx: Prisma.TransactionClient, betId: string) {
  return tx.bet.findUniqueOrThrow({
    where: { id: betId },
    select: {
      id: true,
      deletedAt: true,
      sportResolutionStatus: true,
      status: true,
      stake: true,
      odds: true,
      lucro: true,
      mercado: true,
      evento: true, esporte: true, pais: true, competicao: true, legsJson: true,
      playerProp: { select: { revision: true, evidence: true } },
      selecao: true,
      data: true,
      kickoffInferido: true,
      contaId: true,
      conta: {
        select: { id: true, deletedAt: true, status: true, casaDeAposta: true, bankrollLinks: { select: { bankrollId: true } } },
      },
      casaDeAposta: true,
      valorUnidade: true,
      bankroll: {
        select: { id: true, vincularContas: true, playerPropsAutoSettlement: true },
      },
    },
  });
}

type SettlementBet = Awaited<ReturnType<typeof loadBetForSettlement>>;

/** Recusas de negócio, na ordem em que o operador precisa vê-las. */
function assertSettlementAllowed(
  bet: SettlementBet,
  params: ApplyBetStatusChangeParams,
  automatic: boolean,
  now: Date,
): void {
  // Aposta removida já teve o ledger estornado e some das listagens; liquidá-la
  // creditaria a conta numa linha invisível.
  if (bet.deletedAt) {
    throw new BetRemovedError(bet.id, "liquidação");
  }
  if (automatic && params.newStatus === "CASHOUT") {
    throw new RecusaDeNegocioError("Cashout exige encerramento manual com lucro confirmado pelo dono.");
  }
  if ((params.newStatus === "HALF_WON" || params.newStatus === "HALF_LOST") && !admitsAsianFractionalSettlement(bet.mercado, bet.selecao)) {
    throw new InvalidSettlementMarketError(bet.id, bet.mercado, params.newStatus);
  }
  if (
    params.newStatus !== "PENDING" &&
    bet.sportResolutionStatus !== "CONFIRMED" &&
    !allowsSettlementWithoutConfirmedSport(params.newStatus, params.source)
  ) {
    throw new SportNotConfirmedError(bet.id);
  }
  if (automatic && bet.playerProp) {
    const proof = bet.playerProp.evidence as Record<string, unknown> | null;
    if (params.source !== "flashscore" || params.expectedTerms?.playerPropRevision !== bet.playerProp.revision || !bet.bankroll.playerPropsAutoSettlement || proof?.stable !== true || proof.proposedStatus !== params.newStatus) {
      throw new RecusaDeNegocioError("Prop de jogador exige evidência validada e automação habilitada para o grupo.");
    }
  }
  assertSettlementKickoff(bet, params.newStatus, now);
}

function settlementLucro(params: ApplyBetStatusChangeParams, stake: number, odds: number): number {
  if (params.newStatus !== "CASHOUT") {
    return computeLucroFromStatus({ status: params.newStatus, stake, odds });
  }
  if (params.cashoutLucro === undefined) {
    throw new RecusaDeNegocioError("Cashout exige o valor do lucro (em unidades).");
  }
  try {
    return validateCashoutLucro({ lucro: params.cashoutLucro, stake, odds });
  } catch (error) {
    if (error instanceof InvalidCashoutLucroError) throw new RecusaDeNegocioError(error.message);
    throw error;
  }
}

/**
 * Conta que recebe o lançamento. A conta pode ter sido criada depois da
 * captura, ou a associada pode ter sido encerrada: o vínculo é refeito,
 * fechado a ambiguidade. Sem conta única elegível, o resultado esportivo é
 * gravado sem ledger e vira ação visível (`semContaElegivel`).
 *
 * LIMITADA quer dizer que a casa restringiu apostas NOVAS: a aposta que já
 * estava na conta liquida nela (ganho, perda, estorno e correção). Só o
 * vínculo novo exige conta ATIVA. ENCERRADA não recebe nada: o vínculo é
 * refeito para outra conta ATIVA da casa, ou o resultado fica sem ledger.
 */
async function resolveSettlementConta(
  tx: Prisma.TransactionClient,
  bet: SettlementBet,
  newStatus: BetStatus,
  lucro: number,
): Promise<{ contaId: string | null; noAccountReason: NoAccountReason | null; movesLedger: boolean }> {
  const movesLedger = LEDGER_STATUSES.has(newStatus) && lucro !== 0;
  const conta = bet.conta;
  const linkedToBankroll = conta?.bankrollLinks.some((l) => l.bankrollId === bet.bankroll.id) ?? false;
  const sameHouse = !bet.casaDeAposta || (conta ? isSameBookmaker(conta.casaDeAposta, bet.casaDeAposta) : false);
  const liveConta = Boolean(bet.contaId && conta && conta.deletedAt === null && sameHouse);
  const contaAssociadaValida = liveConta && (
    (conta!.status === "ATIVA" && (!bet.bankroll.vincularContas || linkedToBankroll || conta!.bankrollLinks.length === 0)) ||
    // Conta global já associada continua elegível: criar outra conta para o
    // tipster não transfere apostas existentes. LIMITADA também conserva o vínculo.
    (conta!.status === "LIMITADA" && (!bet.bankroll.vincularContas || linkedToBankroll || conta!.bankrollLinks.length === 0))
  );
  let contaId = contaAssociadaValida ? bet.contaId : null;
  let blockedByExistingAccounts = false;
  let onlyLimited = false;
  if (!contaId && movesLedger && bet.bankroll.vincularContas && bet.casaDeAposta) {
    const resolution = await resolveContaAtivaParaCasa(tx, {
      bankrollId: bet.bankroll.id,
      casaDeAposta: bet.casaDeAposta,
    });
    contaId = resolution.contaId;
    onlyLimited = resolution.onlyLimited === true;
    blockedByExistingAccounts = resolution.blockedByExistingAccounts || Boolean(bet.contaId && !contaId);
  }
  const semContaElegivel =
    movesLedger && bet.bankroll.vincularContas && Boolean(bet.casaDeAposta) && !contaId && blockedByExistingAccounts;
  const noAccountReason: NoAccountReason | null = !semContaElegivel
    ? null
    : bet.contaId && conta?.deletedAt
      ? "conta_removida"
      : bet.contaId && conta?.status === "ENCERRADA"
        ? "conta_encerrada"
        : onlyLimited
          ? "conta_limitada"
          : "sem_conta_unica";
  // Sem vínculo dinâmico elegível (ex.: aposta sem casa), mantém a conta da
  // aposta para o ledger lançar ContaIndisponivelError em vez de pular.
  if (!contaId && !semContaElegivel && bet.contaId) {
    contaId = bet.contaId;
  }
  return { contaId, noAccountReason, movesLedger };
}

/**
 * A conta de uma aposta removida que volta a `status` (restauração): a regra
 * da liquidação, exceto que a conta removida não volta com a aposta. A
 * liquidação a mantém para o ledger falhar alto, mas a aposta removida já
 * teve o efeito estornado e não segura a conta, e sem outra elegível a
 * restauração ficaria impossível. Nesse caso o resultado volta sem ledger.
 * A ação "liquidada sem conta" abre como na liquidação: quando a banca liga
 * contas pela casa da aposta, que é o único caso em que ligar outra conta e
 * voltar para Pendente resolve.
 */
export async function resolveRestoredBetContaTx(
  tx: Prisma.TransactionClient,
  betId: string,
  status: BetStatus,
  lucro: number,
): Promise<{
  contaId: string | null;
  semContaElegivel?: ApplyBetStatusChangeResult["semContaElegivel"];
  ledgerPosted: boolean;
}> {
  const bet = await loadBetForSettlement(tx, betId);
  const resolved = await resolveSettlementConta(tx, bet, status, lucro);
  const removedConta = resolved.contaId !== null && resolved.contaId === bet.contaId && bet.conta?.deletedAt != null;
  const contaId = removedConta ? null : resolved.contaId;
  const reason = resolved.noAccountReason;
  return {
    contaId,
    ...(reason && bet.casaDeAposta
      ? { semContaElegivel: { casaDeAposta: bet.casaDeAposta, bankrollId: bet.bankroll.id, reason } }
      : {}),
    ledgerPosted: Boolean(contaId && resolved.movesLedger),
  };
}

/**
 * Reabrir para PENDING limpa a evidência automática de RESULTADO (placar e
 * prova de prop estável, com nova revisão): sem isso o worker re-liquidaria na
 * hora. CLV é fato de mercado e fica; limpá-lo forçaria buscar odd expirada.
 */
export async function clearAutomaticEvidenceOnReopenTx(tx: Prisma.TransactionClient, betId: string): Promise<void> {
  await tx.betResult.updateMany({
    where: { betId },
    data: {
      scoreHome: null,
      scoreAway: null,
      resultProvider: null,
      resultMatchId: null,
      resultMatchConfidence: null,
      resultSnapshot: Prisma.DbNull,
      resultCheckedAt: null,
      resultFinal: false,
    },
  });
  await tx.betPlayerProp.updateMany({
    where: { betId },
    data: {
      evidence: Prisma.DbNull,
      revision: { increment: 1 },
      resolutionStatus: "PENDING",
    },
  });
}

/**
 * Transação única: status, lucro, ledger e evento idempotente. Repetir o
 * mesmo status+lucro não grava evento novo; cada mudança real leva
 * `changedAt`, para que um ciclo WON→VOID→WON não colida no hash do payload.
 */
async function applyBetStatusChangeTxCore(
  tx: Prisma.TransactionClient,
  params: ApplyBetStatusChangeParams,
  automatic: boolean,
): Promise<ApplyBetStatusChangeResult> {
  if (params.expectedTerms) {
    if (params.expectedTerms.id !== params.betId) {
      throw new Error("Snapshot de liquidação pertence a outra aposta.");
    }
    await assertBetSettlementTermsTx(tx, params.expectedTerms, { allowSettledTransition: true });
  }
  const bet = await loadBetForSettlement(tx, params.betId);
  const changedAt = new Date();
  assertSettlementAllowed(bet, params, automatic, changedAt);
  const lucro = settlementLucro(params, toNumber(bet.stake), toNumber(bet.odds));

  // CAS da automação: quem liquidou entre a leitura do job e esta escrita vence.
  const sameOutcome =
    bet.status === params.newStatus &&
    Math.abs(roundMoney(toNumber(bet.lucro)) - roundMoney(lucro)) < BET_UNIT_MIN_AMOUNT;
  if ((automatic || params.requirePending) && bet.status !== "PENDING" && !sameOutcome) {
    throw new BetNotPendingError(bet.id, bet.status);
  }

  const conta = await resolveSettlementConta(tx, bet, params.newStatus, lucro);
  const contaChanged = bet.contaId !== conta.contaId;
  const movimentacao = {
    betId: bet.id,
    newStatus: params.newStatus,
    lucroUnidades: lucro,
    valorUnidade: toNumber(bet.valorUnidade),
    contaId: conta.contaId,
    actor: settlementSourceActor(params.source),
  };

  if (sameOutcome) {
    // Mesma transição já aplicada. Um reopen repetido ainda limpa a evidência:
    // uma corrida job×tela pode ter reingerido placar ou prova de prop.
    if (params.newStatus === "PENDING") {
      const previousEvidence = await readSettlementEvidenceTx(tx, bet.id);
      const reopened = await tx.bet.update({ where: { id: bet.id }, data: { manualSettlementVersion: { increment: 1 } }, select: { manualSettlementVersion: true } });
      await clearAutomaticEvidenceOnReopenTx(tx, bet.id);
      await insertSettlementEventTx(tx, { betId: bet.id, type: "EVIDENCE_CLEARED", payload: {
        source: params.source, previousEvidence, version: reopened.manualSettlementVersion, changedAt: changedAt.toISOString(),
      } });
    }
    if (contaChanged) {
      await tx.bet.update({
        where: { id: bet.id },
        data: { contaId: conta.contaId },
      });
      // Desvincular também estorna: a conta antiga não fica com o lucro.
      await processMovimentacaoFromBetTx(tx, movimentacao);
    }
  } else {
    const previousEvidence = params.newStatus === "PENDING" ? await readSettlementEvidenceTx(tx, bet.id) : undefined;
    await tx.bet.update({
      where: { id: bet.id },
      // settledAt só na 1ª saída de PENDING: correção WON→LOST não move o KPI do dia.
      data: {
        status: params.newStatus,
        lucro,
        contaId: contaChanged ? conta.contaId : undefined,
        settledAt:
          params.newStatus === "PENDING"
            ? null
            : bet.status === "PENDING"
              ? changedAt
              : undefined,
      },
    });
    if (params.newStatus === "PENDING") {
      await clearAutomaticEvidenceOnReopenTx(tx, bet.id);
    }
    await processMovimentacaoFromBetTx(tx, movimentacao);
    await insertSettlementEventTx(tx, {
      betId: bet.id,
      type: "STATUS_CHANGED",
      payload: {
        from: bet.status,
        previousLucro: toNumber(bet.lucro),
        odds: toNumber(bet.odds), stake: toNumber(bet.stake), valorUnidade: toNumber(bet.valorUnidade),
        contaId: conta.contaId,
        previousContaId: bet.contaId,
        terms: { evento: bet.evento, esporte: bet.esporte, pais: bet.pais, competicao: bet.competicao,
          data: bet.data.toISOString(), mercado: bet.mercado, selecao: bet.selecao, legsJson: bet.legsJson },
        ...(previousEvidence ? { previousEvidence } : {}),
        to: params.newStatus,
        lucro,
        source: params.source,
        ...(params.judgeSuggestionId ? { judgeSuggestionId: params.judgeSuggestionId } : {}),
        changedAt: changedAt.toISOString(),
      },
    });
  }

  const result: ApplyBetStatusChangeResult = {
    status: params.newStatus,
    lucro,
    previousStatus: bet.status,
    ...(conta.noAccountReason && bet.casaDeAposta
      ? {
          semContaElegivel: {
            casaDeAposta: bet.casaDeAposta,
            bankrollId: bet.bankroll.id,
            reason: conta.noAccountReason,
          },
        }
      : {}),
  };
  await persistirLiquidacaoSemContaTx(tx, bet.id, result, {
    ledgerPosted: Boolean(conta.contaId && conta.movesLedger),
  });
  return result;
}

/** Decisão do operador (painel, `ops-settle`); pode corrigir um resultado já liquidado. */
export async function applyManualBetStatusChangeTx(
  tx: Prisma.TransactionClient,
  params: ApplyBetStatusChangeParams,
): Promise<ApplyBetStatusChangeResult> {
  return applyBetStatusChangeTxCore(tx, params, false);
}

/** Liquidação automática em tx aberta: CAS PENDING obrigatório por construção. */
export async function applyAutomaticBetStatusChangeTx(
  tx: Prisma.TransactionClient,
  params: ApplyBetStatusChangeParams,
): Promise<ApplyBetStatusChangeResult> {
  return applyBetStatusChangeTxCore(tx, params, true);
}

/** Automação fail-closed: nunca sobrescreve uma decisão que deixou PENDING. */
export async function applyAutomaticBetStatusChange(
  params: ApplyBetStatusChangeParams,
  options?: { client?: SerializableTransactionClient },
): Promise<ApplyBetStatusChangeResult> {
  const result = await runSerializableTransaction(
    "applyAutomaticBetStatusChange",
    (tx) => applyBetStatusChangeTxCore(tx, params, true),
    options,
  );
  await finishBetStatusChange(params.betId, result);
  return result;
}
