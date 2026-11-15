import { z } from "zod";
import { Prisma } from "@/src/generated/prisma/client";
import type { SportResolutionSource, SportResolutionStatus } from "@/src/generated/prisma/enums";
import { parseBetLegs, parseStoredLegs, sameBetLegs, type BetLegsTicket } from "@/src/domain/bet-legs";
import { correctedReadingFields, hasUnsupportedPromotionTerms, hasUnsupportedTradingTerms, READING_CORRECTED_ACTION } from "@/src/domain/bet-capture";
import { canonicalizeBookmakerName } from "@/src/domain/bookmaker";
import { resolveFinancialEditValues } from "@/src/domain/capture-financial-history";
import { spDayKey } from "@/src/domain/dates";
import { resolveLiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import { toNumber } from "@/src/domain/money";
import { assertPriceProvenance } from "@/src/domain/price-provenance";
import { percentualContraFair } from "@/src/domain/odds";
import { buildPlayerPropTerms, type PlayerPropTerms } from "@/src/domain/settlement/player-prop-terms";
import { playerPropRule } from "@/src/domain/settlement/player-prop-rules";
import { markSoccerReserveTeams, normalizeStr, sameFixtureTeams } from "@/src/domain/text";
import { canonicalizeBetForRegistration } from "@/src/services/bets/canonicalize-registration";
import { normalizeBetFields, normalizeTicketLegs } from "@/src/services/bets/normalize-fields";
import { betEditSanitySchema } from "@/src/services/bets/sanity";
import { BetRemovedError, insertSettlementEventTx } from "@/src/services/bets/settle";
import { readSettlementEvidenceTx } from "@/src/services/settlement/bet-result";
import { findContaAtivaParaCasa, isSameBookmaker } from "@/src/services/contas/link";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import { processMovimentacaoFromBetTx } from "@/src/services/contas/movements";
import { reportMercadoAliasConflictTx } from "@/src/services/mercados/alias-conflict-action";
import type { MercadoCatalogClient } from "@/src/services/mercados/normalize";
import { prisma } from "@/src/infra/prisma";
import { clearKickoffCooldowns, clearKickoffResolveAttempt } from "@/src/services/sharp/enrich/kickoff-attempts";
import { closeOpenTrainingCaseForDeletedBetTx } from "@/src/services/sharp/enrich/training-cases";
import {
  type SerializableTransactionClient,
  runSerializableTransaction,
} from "@/src/services/shared/transaction";

/**
 * Edição de aposta in-place. Uma edição material preserva o ID, reverte o
 * ledger, reabre a aposta e descarta evidências obsoletas; uma correção
 * compatível (alias, modalidade de aposta final) preserva identidade e
 * liquidação; a correção só de odd, stake ou casa preserva identidade e
 * fechamento (o CLV é refeito) e reabre a liquidação.
 */

export type ApplyBetEditFields = {
  data: Date;
  evento: string;
  esporte: string;
  competicao: string;
  pais: string;
  mercado: string;
  selecao: string;
  liveScoreHome?: number;
  liveScoreAway?: number;
  odds: number;
  stake: number;
  casaDeAposta?: string;
  kickoffInferido?: boolean;
  /** Evidência estrutural da múltipla; quando enviada, precisa ser válida. */
  legsJson?: unknown;
};

export type ApplyBetEditResult = {
  requiresEnrich: boolean;
  identityPreserved: boolean;
  settlementPreserved: boolean;
};

export type ApplySportResolution = {
  /** Obrigatória no writer automático; revisão observada antes da consulta. */
  expectedVersion?: number;
  status: SportResolutionStatus;
  confidence: number;
  source: SportResolutionSource;
  evidence: Prisma.InputJsonValue;
  resolverVersion: number;
  force?: boolean;
};

type ApplyBetEditParams = {
  betId: string;
  fields: ApplyBetEditFields;
  actor: string;
  sportResolution?: ApplySportResolution;
} & (
  | { financialAuthority?: undefined }
  /**
   * O dono edita pela ficha, que manda o formulário inteiro: `expectedVersion`
   * é a revisão da aposta que a ficha mostrava quando abriu.
   */
  | { financialAuthority: "operator"; expectedVersion: number }
);

export class StaleSportResolutionError extends Error {
  constructor(betId: string) {
    super(`Aposta ${betId} mudou durante a resolução de modalidade; reavaliar o estado atual.`);
    this.name = "StaleSportResolutionError";
  }
}

/** A revisão foi lida antes da consulta externa, nunca reconstruída pelo writer. */
export type SportResolutionSnapshot = { id: string; manualSettlementVersion: number };

type IdentityCompatibleBet = {
  data: Date;
  evento: string;
  esporte: string;
  competicao: string;
  pais: string;
  mercado: string;
  selecao: string;
  odds: Prisma.Decimal;
  stake: Prisma.Decimal;
  casaDeAposta: string;
  kickoffInferido: boolean;
};

export function isIdentityCompatibleEdit(
  before: IdentityCompatibleBet,
  after: ApplyBetEditFields,
  options: { allowPriceChange?: boolean } = {},
): boolean {
  return (
    sameFixtureTeams(before.evento, after.evento) &&
    before.data.getTime() === after.data.getTime() &&
    before.kickoffInferido === (after.kickoffInferido ?? before.kickoffInferido) &&
    normalizeStr(before.esporte) === normalizeStr(after.esporte) &&
    normalizeStr(before.competicao) === normalizeStr(after.competicao) &&
    normalizeStr(before.pais) === normalizeStr(after.pais) &&
    normalizeStr(before.mercado) === normalizeStr(after.mercado) &&
    normalizeStr(before.selecao) === normalizeStr(after.selecao) &&
    normalizeStr(before.casaDeAposta) === normalizeStr(after.casaDeAposta ?? before.casaDeAposta) &&
    (options.allowPriceChange || (
      toNumber(before.odds) === after.odds &&
      toNumber(before.stake) === after.stake
    ))
  );
}

/**
 * Valida e normaliza uma edição antes de abrir sua transação financeira, com
 * os mesmos tetos de sanidade do registro: falha aqui é no-op com erro
 * acionável. `parsedFields` é a identidade canônica anterior à normalização
 * de catálogo; `fields` é o contrato persistido.
 */
export async function normalizeBetEditInput(
  rawFields: ApplyBetEditFields,
  client?: MercadoCatalogClient,
  /** Placar ao vivo já gravado na aposta; imutável, lido antes da transação. */
  storedLiveScore?: { home: number; away: number } | null,
) {
  const schema = betEditSanitySchema.extend({
    kickoffInferido: z.boolean().optional(),
    legsJson: z.unknown().optional(),
  });
  const rawParsedFields = schema.parse(rawFields);
  const declaredLegs = parseStoredLegs(rawParsedFields.legsJson);
  if (hasUnsupportedTradingTerms(rawParsedFields.mercado, rawParsedFields.selecao,
    ...(declaredLegs?.legs.flatMap((leg) => [leg.mercado, leg.selecao]) ?? []))) {
    throw new RecusaDeNegocioError("Operação recusada: lay, responsabilidade, comissão e cash-out parcial exigem contrato financeiro próprio.");
  }
  if (hasUnsupportedPromotionTerms(rawParsedFields.mercado, rawParsedFields.selecao,
    ...(declaredLegs?.legs.flatMap((leg) => [leg.mercado, leg.selecao]) ?? []))) {
    throw new RecusaDeNegocioError("Edição recusada: regra promocional sem contrato financeiro próprio. Freebet e reembolso não usam o cálculo de stake em dinheiro.");
  }
  const canonicalFields = await canonicalizeBetForRegistration(rawParsedFields);
  const liveScore = resolveLiveScoreAtTip({
    liveScoreHome: canonicalFields.liveScoreHome,
    liveScoreAway: canonicalFields.liveScoreAway,
    texts: [canonicalFields.selecao],
    market: canonicalFields.mercado,
  });
  if (!liveScore.ok) {
    throw new Error(`Placar live inválido na edição (${liveScore.reason}).`);
  }
  const parsedFields = {
    ...canonicalFields,
    ...(liveScore.score
      ? {
          liveScoreHome: liveScore.score.home,
          liveScoreAway: liveScore.score.away,
        }
      : {}),
    ...(canonicalFields.casaDeAposta !== undefined
      ? { casaDeAposta: canonicalizeBookmakerName(canonicalFields.casaDeAposta) }
      : {}),
  };
  const normalized = await normalizeBetFields({
    evento: parsedFields.evento,
    mercado: parsedFields.mercado,
    selecao: parsedFields.selecao,
    esporte: parsedFields.esporte,
    casaDeAposta: parsedFields.casaDeAposta,
    liveScore: parsedFields.liveScoreHome != null && parsedFields.liveScoreAway != null
      ? { home: parsedFields.liveScoreHome, away: parsedFields.liveScoreAway }
      : storedLiveScore ?? null,
    client: client,
  });
  const fields = schema.parse({
    ...parsedFields,
    evento: normalized.evento,
    mercado: normalized.mercado,
    selecao: normalized.selecao,
  });
  return { fields, normalized, parsedFields };
}

type NormalizedEdit = Awaited<ReturnType<typeof normalizeBetEditInput>>;
type EditedFields = NormalizedEdit["fields"];

async function prepareEditedLegs(params: {
  fields: ApplyBetEditFields;
  parsed: { evento: string; mercado: string; selecao: string; esporte: string; casaDeAposta?: string };
  client?: MercadoCatalogClient;
}): Promise<{ hasExplicitLegs: boolean; normalizedLegs: BetLegsTicket | null }> {
  const hasExplicitLegs = Object.prototype.hasOwnProperty.call(params.fields, "legsJson");
  const explicitLegs = hasExplicitLegs && params.fields.legsJson != null
    ? parseStoredLegs(params.fields.legsJson)
    : null;
  if (hasExplicitLegs && params.fields.legsJson != null && !explicitLegs) {
    throw new Error("Edição de múltipla recusada: legsJson explícito é inválido.");
  }
  const incoming = explicitLegs ?? parseBetLegs(params.parsed.evento, params.parsed.selecao, params.parsed.mercado);
  const normalizedLegs = incoming
    ? await normalizeTicketLegs(
        incoming,
        params.parsed.esporte,
        params.parsed.casaDeAposta ?? "",
        params.client,
      )
    : null;
  return { hasExplicitLegs, normalizedLegs };
}

function resolveEditedLegs(params: {
  existingLegsJson: unknown;
  normalizedLegs: BetLegsTicket | null;
  hasExplicitLegs: boolean;
  existingTerms: readonly [string, string];
  incomingTerms: readonly [string, string];
}): BetLegsTicket | null {
  const stored = parseStoredLegs(params.existingLegsJson);
  const termsUnchanged = params.incomingTerms[0].trim() === params.existingTerms[0].trim()
    && params.incomingTerms[1].trim() === params.existingTerms[1].trim();
  const next = params.normalizedLegs ?? (
    stored && !params.hasExplicitLegs && termsUnchanged ? stored : null
  );
  if (stored && next === null) {
    throw new Error(
      "Edição de múltipla recusada: informe legsJson válido ao alterar evento ou seleção.",
    );
  }
  return next;
}

/**
 * Snapshot para edição. O adapter `pg` executava includes irmãos em paralelo
 * no mesmo client da transação; as leituras são sequenciais de propósito.
 */
async function loadBetEditState(tx: Prisma.TransactionClient, betId: string) {
  const betRow = await tx.bet.findUniqueOrThrow({
    where: { id: betId },
    select: {
      id: true,
      manualSettlementVersion: true,
      deletedAt: true,
      contaId: true,
      casaDeAposta: true,
      data: true,
      evento: true,
      esporte: true,
      sportResolutionStatus: true,
      sportConfidence: true,
      sportSource: true,
      competicao: true,
      pais: true,
      mercado: true,
      selecao: true,
      liveScoreHome: true,
      liveScoreAway: true,
      odds: true,
      stake: true,
      captureStakeSnapshot: true,
      manualStakeOverride: true,
      manualOddsOverride: true,
      kickoffInferido: true,
      status: true,
      valorUnidade: true,
      bankrollId: true,
      legsJson: true,
      captureReader: true,
      lucro: true,
    },
  });
  const sharp = await tx.betSharp.findUnique({
    where: { betId: betRow.id },
    select: { identityStatus: true },
  });
  const bankroll = await tx.bankroll.findUniqueOrThrow({
    where: { id: betRow.bankrollId },
    select: { id: true, vincularContas: true },
  });
  const conta = betRow.contaId
    ? await tx.conta.findUnique({
        where: { id: betRow.contaId },
        select: { status: true, deletedAt: true, casaDeAposta: true },
      })
    : null;
  const playerProp = await tx.betPlayerProp.findUnique({ where: { betId: betRow.id } });
  return { ...betRow, sharp, bankroll, playerProp, conta };
}

type EditBet = Awaited<ReturnType<typeof loadBetEditState>>;

/** Confere a decisão do resolvedor de esporte e conserva sua evidência na mesma transação. */
async function assertSportResolutionEditTx(
  tx: Prisma.TransactionClient,
  bet: EditBet,
  params: ApplyBetEditParams,
): Promise<void> {
  const resolution = params.sportResolution;
  if (params.actor !== "sport-resolver" || !resolution) return;
  const fields = params.fields;
  // O resolvedor não muda os termos; a única exceção é a marca de reserva do
  // futebol (`markSoccerReserveTeams`), recalculada aqui sobre a aposta atual.
  const marked = markSoccerReserveTeams({ evento: bet.evento, selecao: bet.selecao });
  const sameTerms = (fields.evento === bet.evento && fields.selecao === bet.selecao)
    || (fields.esporte === "Soccer" && fields.evento === marked.evento && fields.selecao === marked.selecao);
  if (!Number.isInteger(resolution.expectedVersion) || resolution.expectedVersion !== bet.manualSettlementVersion ||
      !sameTerms || fields.mercado !== bet.mercado ||
      (!bet.kickoffInferido && (fields.data.getTime() !== bet.data.getTime() || fields.kickoffInferido === true))) {
    throw new StaleSportResolutionError(bet.id);
  }
  await tx.betCaptureEvidence.updateMany({
    where: { betId: bet.id },
    data: { candidatesJson: resolution.evidence },
  });
}

/**
 * Horário confirmado não volta a ficar a confirmar: sem a hora, a edição
 * gravaria o marcador de meia-noite no lugar do instante conhecido.
 */
function assertKeepsConfirmedKickoff(bet: EditBet, fields: ApplyBetEditFields): void {
  if (!bet.kickoffInferido && fields.kickoffInferido === true) {
    throw new RecusaDeNegocioError("Informe o horário.");
  }
}

/**
 * Horário que continua a confirmar no mesmo dia guarda o instante gravado: a
 * edição só conhece o dia, e a hora do post é a âncora da busca de horário e
 * da deduplicação.
 */
function editedKickoff(bet: EditBet, fields: ApplyBetEditFields): Date {
  const staysProvisional = bet.kickoffInferido && fields.kickoffInferido === true &&
    spDayKey(bet.data) === spDayKey(fields.data);
  return staysProvisional ? bet.data : fields.data;
}

/**
 * Campos efetivos: o contrato persistente de prop de jogador vale em edição só
 * numérica (renormalizar um rótulo legado transformaria o total do jogador em
 * total da partida), e stake/odd respeitam a autoridade financeira.
 */
function resolveEditedFields(
  bet: EditBet,
  params: ApplyBetEditParams,
  normalized: NormalizedEdit,
): EditedFields {
  const data = editedKickoff(bet, normalized.fields);
  const unchangedPlayerTerms = Boolean(bet.playerProp) &&
    !normalized.normalized.mercadoAliasConflict &&
    isIdentityCompatibleEdit(bet, { ...params.fields, data }, { allowPriceChange: true });
  const identityFields = unchangedPlayerTerms
    ? { ...normalized.fields, evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao }
    : normalized.fields;
  return {
    ...identityFields,
    data,
    ...resolveFinancialEditValues(bet, normalized.fields, params.financialAuthority ?? "system"),
  };
}

type EditPlan = {
  legsChanged: boolean;
  primeiroPlacarLive: boolean;
  oddsChanged: boolean;
  stakeChanged: boolean;
  casaChanged: boolean;
  /** Identidade MATCHED/MANUAL continua valendo para o mesmo jogo. */
  preserveResolvedIdentity: boolean;
  /** O resolvedor só troca a modalidade de uma aposta já liquidada. */
  isSportResolverOnSettled: boolean;
  preserveSettlement: boolean;
};

/** O que a edição preserva. Placar, odds, stake, casa e pernas invalidam a liquidação. */
function planBetEdit(
  bet: EditBet,
  params: ApplyBetEditParams,
  f: EditedFields,
  nextLegs: BetLegsTicket | null,
  mercadoAliasConflict: boolean,
): EditPlan {
  const legsChanged = !sameBetLegs(bet.legsJson, nextLegs);
  if (
    bet.liveScoreHome !== null &&
    f.liveScoreHome !== undefined &&
    (f.liveScoreHome !== bet.liveScoreHome || f.liveScoreAway !== bet.liveScoreAway)
  ) {
    throw new Error(`Placar live da aposta ${bet.id} é imutável.`);
  }
  const preserveResolvedIdentity =
    !legsChanged &&
    !mercadoAliasConflict &&
    (bet.sharp?.identityStatus === "MATCHED" || bet.sharp?.identityStatus === "MANUAL") &&
    // Odd, stake e casa não mudam o jogo nem o fechamento da Pinnacle; a
    // evidência de preço e a financeira são refeitas à parte. Na prop de
    // jogador a casa define a regra de liquidação, e trocá-la é estrutural.
    isIdentityCompatibleEdit(bet, bet.playerProp ? f : { ...f, casaDeAposta: bet.casaDeAposta }, { allowPriceChange: true });
  const primeiroPlacarLive =
    bet.liveScoreHome === null &&
    bet.liveScoreAway === null &&
    f.liveScoreHome !== undefined &&
    f.liveScoreAway !== undefined;
  const oddsChanged = f.odds !== undefined && toNumber(bet.odds) !== f.odds;
  const stakeChanged = f.stake !== undefined && toNumber(bet.stake) !== f.stake;
  const casaChanged =
    f.casaDeAposta !== undefined &&
    normalizeStr(bet.casaDeAposta) !== normalizeStr(f.casaDeAposta);
  const isSportResolverOnSettled =
    params.actor === "sport-resolver" && params.sportResolution !== undefined &&
    !legsChanged &&
    bet.status !== "PENDING" &&
    !oddsChanged &&
    !stakeChanged &&
    !casaChanged;
  const preserveSettlement =
    isSportResolverOnSettled ||
    (preserveResolvedIdentity &&
      !primeiroPlacarLive &&
      !oddsChanged &&
      !stakeChanged &&
      !casaChanged);
  return {
    legsChanged,
    primeiroPlacarLive,
    oddsChanged,
    stakeChanged,
    casaChanged,
    preserveResolvedIdentity,
    isSportResolverOnSettled,
    preserveSettlement,
  };
}

/**
 * Fonte da reabertura no ledger de liquidação, no mesmo vocabulário da
 * liquidação: `manual:<usuário>` quando o operador edita pelo painel; o ator
 * automático ("sport-resolver") como está, cadastrado em
 * `production-write-actors.ts`. Sem isso a revisão diária lia o nome cru como
 * escrita sem autor.
 */
function reopenSource(params: ApplyBetEditParams): string {
  return params.financialAuthority === "operator" ? `manual:${params.actor}` : params.actor;
}

/** Mudança estrutural ou primeiro placar invalida resultado e dinheiro. */
async function reopenSettlementTx(tx: Prisma.TransactionClient, bet: EditBet, source: string, actor: string, previousEvidence: Prisma.InputJsonObject): Promise<void> {
  if (bet.status !== "PENDING") {
    await insertSettlementEventTx(tx, {
      betId: bet.id,
      type: "STATUS_CHANGED",
      payload: {
        from: bet.status,
        previousLucro: toNumber(bet.lucro),
        odds: toNumber(bet.odds), stake: toNumber(bet.stake), valorUnidade: toNumber(bet.valorUnidade),
        contaId: bet.contaId,
        terms: { evento: bet.evento, esporte: bet.esporte, pais: bet.pais, competicao: bet.competicao,
          data: bet.data.toISOString(), mercado: bet.mercado, selecao: bet.selecao, legsJson: bet.legsJson },
        previousEvidence,
        to: "PENDING",
        lucro: 0,
        source,
        changedAt: new Date().toISOString(),
      },
    });
  }
  await processMovimentacaoFromBetTx(tx, {
    betId: bet.id,
    newStatus: "PENDING",
    lucroUnidades: 0,
    valorUnidade: toNumber(bet.valorUnidade),
    contaId: bet.contaId,
    actor,
  });
}

/**
 * Recalcula o contrato de prop de jogador. Edição numérica conserva o contrato
 * explícito, inclusive quando o rótulo legado sozinho não o reconstruiria.
 */
async function syncPlayerPropTx(
  tx: Prisma.TransactionClient,
  bet: EditBet,
  f: EditedFields,
  nextLegs: BetLegsTicket | null,
  casaChanged: boolean,
): Promise<void> {
  const sameProp = bet.playerProp && f.mercado === bet.mercado && f.selecao === bet.selecao && !casaChanged;
  const prop = sameProp && bet.playerProp
    ? bet.playerProp.terms as unknown as PlayerPropTerms
    : buildPlayerPropTerms({ mercado: f.mercado, selecao: f.selecao, evento: f.evento, esporte: f.esporte ?? bet.esporte });
  const samePlayerFixture = f.evento === bet.evento && (f.esporte ?? bet.esporte) === bet.esporte && f.data.getTime() === bet.data.getTime();
  if (prop && !nextLegs) await tx.betPlayerProp.upsert({
    where: { betId: bet.id },
    create: { betId: bet.id, terms: prop, rule: playerPropRule(f.casaDeAposta ?? bet.casaDeAposta, prop.family) },
    update: { terms: sameProp && bet.playerProp ? (bet.playerProp.terms as Prisma.InputJsonValue) : prop, rule: sameProp && bet.playerProp ? (bet.playerProp.rule as Prisma.InputJsonValue) : playerPropRule(f.casaDeAposta ?? bet.casaDeAposta, prop.family), revision: { increment: 1 }, playerIdentityId: sameProp && samePlayerFixture ? bet.playerProp?.playerIdentityId : null, providerMatchId: samePlayerFixture ? bet.playerProp?.providerMatchId : null, resolutionStatus: "PENDING", evidence: Prisma.DbNull },
  });
  else if (bet.playerProp) await tx.betPlayerProp.deleteMany({ where: { betId: bet.id } });
}

type PersistedIdentity = Pick<EditedFields, "evento" | "competicao" | "pais" | "mercado" | "selecao">;

/** O horário gravado: o resolvedor de esporte não move o horário de aposta liquidada. */
function persistedKickoff(bet: EditBet, f: EditedFields, plan: EditPlan): { data: Date; kickoffInferido: boolean } {
  if (plan.isSportResolverOnSettled) return { data: bet.data, kickoffInferido: bet.kickoffInferido };
  return { data: f.data, kickoffInferido: f.kickoffInferido ?? bet.kickoffInferido };
}

function editedBetData(params: {
  bet: EditBet;
  edit: ApplyBetEditParams;
  f: EditedFields;
  plan: EditPlan;
  identity: PersistedIdentity;
  nextLegs: BetLegsTicket | null;
  contaId: string | null;
  casaDeAposta: string;
}): Prisma.BetUncheckedUpdateInput {
  const { bet, edit, f, plan, identity, nextLegs } = params;
  const resolverKeepsSport = edit.actor === "sport-resolver" && bet.sportResolutionStatus === "CONFIRMED" && !edit.sportResolution?.force;
  return {
    ...persistedKickoff(bet, f, plan),
    // Com identidade MATCHED/MANUAL o evento canônico é evidência sharp: trocar
    // só Bet.evento deixaria providerMatchId/closing apontando ao nome anterior.
    evento: identity.evento,
    esporte: resolverKeepsSport ? bet.esporte : f.esporte,
    ...(edit.sportResolution && !resolverKeepsSport
      ? {
          sportResolutionStatus: edit.sportResolution.status,
          sportConfidence: edit.sportResolution.confidence,
          sportSource: edit.sportResolution.source,
          sportEvidence: edit.sportResolution.evidence,
          sportResolvedAt:
            edit.sportResolution.status === "CONFIRMED" ? new Date() : null,
          sportResolverVersion: edit.sportResolution.resolverVersion,
        }
      : {}),
    // Evento e seleção formam um par que a liquidação casa no mesmo
    // vocabulário; competição e país vêm do provider junto com eles, e a
    // edição os traz vazios.
    competicao: identity.competicao,
    pais: identity.pais,
    mercado: identity.mercado,
    selecao: identity.selecao,
    legsJson: nextLegs === null
      ? Prisma.DbNull
      : (nextLegs as Prisma.InputJsonValue),
    ...(f.liveScoreHome !== undefined && f.liveScoreAway !== undefined
      ? {
          liveScoreHome: f.liveScoreHome,
          liveScoreAway: f.liveScoreAway,
        }
      : {}),
    odds: f.odds,
    stake: f.stake,
    ...(edit.financialAuthority === "operator" ? {
      manualStakeOverride: bet.manualStakeOverride || plan.stakeChanged,
      manualOddsOverride: bet.manualOddsOverride || plan.oddsChanged,
    } : {}),
    contaId: params.contaId,
    casaDeAposta: params.casaDeAposta,
    ...(!plan.preserveSettlement || bet.status === "PENDING"
      ? {
          status: "PENDING" as const,
          lucro: 0,
          settledAt: null,
        }
      : {}),
  };
}

/**
 * Odd corrigida no mesmo jogo: o fechamento continua o mesmo, e só o CLV, que
 * compara a odd com a fair de fechamento, é refeito. Sem fechamento ainda, a
 * escrita dele confere a odd atual (`expectedOdds`).
 */
async function repriceClvTx(tx: Prisma.TransactionClient, betId: string, odds: number): Promise<void> {
  const closing = await tx.betClosing.findUnique({ where: { betId }, select: {
    closingOdd: true, closingRawOdd: true, closingPriceSnapshot: true, provider: true,
    closingPriceReference: true, closingPriceObservedAt: true,
  } });
  if (closing?.closingOdd == null) return;
  let clv: number | null = null;
  try {
    const quote = assertPriceProvenance({
      fair: toNumber(closing.closingOdd), raw: closing.closingRawOdd === null ? null : toNumber(closing.closingRawOdd),
      snapshot: closing.closingPriceSnapshot, provider: closing.provider, reference: closing.closingPriceReference,
      requireReference: true, observedAt: closing.closingPriceObservedAt,
    });
    clv = percentualContraFair(odds, quote.fair);
  } catch {
    // Corrigir a odd não completa uma prova de fechamento ausente ou divergente.
  }
  await tx.betClosing.update({
    where: { betId },
    data: { clv, ...(clv === null ? { clvReliable: false } : {}) },
  });
}

/** Descarta a evidência sharp/closing que a edição tornou obsoleta. */
async function invalidateSharpEvidenceTx(
  tx: Prisma.TransactionClient,
  bet: EditBet,
  plan: EditPlan,
  odds: number,
): Promise<void> {
  const structural = !plan.preserveResolvedIdentity && !plan.isSportResolverOnSettled;
  if (structural) {
    await tx.betSharp.deleteMany({ where: { betId: bet.id } });
    await tx.betClosing.deleteMany({ where: { betId: bet.id } });
    // A abertura e o contador da busca pós-jogo eram do jogo antigo.
    await tx.betOpening.deleteMany({ where: { betId: bet.id } });
    await tx.betResult.deleteMany({ where: { betId: bet.id } });
  } else if (!plan.preserveSettlement) {
    if (plan.primeiroPlacarLive || bet.playerProp) {
      // A identidade continua útil para reencontrar o jogo, mas preços prematch
      // não descrevem uma entrada cujo placar agora é conhecido, e prop de
      // jogador não tem preço de referência.
      await tx.betSharp.updateMany({
        where: { betId: bet.id },
        data: {
          priceReference: null,
          noOddsReason: bet.playerProp && !plan.primeiroPlacarLive ? "unsupported_market" : "aposta_ao_vivo",
        },
      });
      await tx.betClosing.updateMany({
        where: { betId: bet.id },
        data: {
          closingOdd: null, closingRawOdd: null, closingPriceSnapshot: Prisma.DbNull,
          closingPriceReference: null, closingPriceObservedAt: null, clv: null, clvReliable: null,
          noOddsReason: null, closingMaxBet: null, closingMaxBetCurrency: null,
          source: null, provider: null, fetchedAt: null,
        },
      });
    } else if (plan.oddsChanged) {
      await repriceClvTx(tx, bet.id, odds);
    }
    // Do resultado fica só o jogo vinculado no provider de resultado, que a
    // liquidação volta a ler.
    await tx.betResult.updateMany({
      where: { betId: bet.id },
      data: { scoreHome: null, scoreAway: null, resultSnapshot: Prisma.DbNull, resultCheckedAt: null, resultFinal: false },
    });
  }
  if (structural) {
    // Só mudança estrutural invalida treino e cooldowns anteriores.
    await closeOpenTrainingCaseForDeletedBetTx(tx, bet.id);
    await clearKickoffResolveAttempt(bet.id, tx);
    await clearKickoffCooldowns(bet.id, tx);
  }
}

async function auditBetEditTx(tx: Prisma.TransactionClient, params: {
  bet: EditBet;
  edit: ApplyBetEditParams;
  f: EditedFields;
  plan: EditPlan;
  identity: PersistedIdentity;
  normalized: NormalizedEdit["normalized"];
  nextLegs: BetLegsTicket | null;
  contaId: string | null;
  casaDeAposta: string;
  previousEvidence?: Prisma.InputJsonObject;
  after: Pick<EditBet, "esporte" | "sportResolutionStatus" | "sportConfidence" | "sportSource">;
}): Promise<void> {
  const { bet, edit, f, plan, identity, normalized } = params;
  const preserveStake = edit.financialAuthority !== "operator" && bet.manualStakeOverride;
  const preserveOdds = edit.financialAuthority !== "operator" && bet.manualOddsOverride;
  const kickoff = persistedKickoff(bet, f, plan);
  await tx.auditEvent.create({
    data: {
      actor: edit.actor,
      action: "bet.edit",
      resource: "bet",
      resourceId: bet.id,
      details: {
        previousEvidence: params.previousEvidence,
        financialAuthority: edit.financialAuthority ?? "system",
        financialFieldsPreserved: { stake: preserveStake, odds: preserveOdds },
        antes: {
          evento: bet.evento, esporte: bet.esporte, pais: bet.pais, competicao: bet.competicao,
          data: bet.data.toISOString(), kickoffInferido: bet.kickoffInferido,
          sportResolutionStatus: bet.sportResolutionStatus, sportConfidence: bet.sportConfidence, sportSource: bet.sportSource,
          mercado: bet.mercado, selecao: bet.selecao,
          liveScoreHome: bet.liveScoreHome, liveScoreAway: bet.liveScoreAway,
          odds: toNumber(bet.odds), stake: toNumber(bet.stake),
          casaDeAposta: bet.casaDeAposta, contaId: bet.contaId,
          legsJson: bet.legsJson,
        },
        depois: {
          evento: identity.evento, esporte: params.after.esporte,
          pais: identity.pais, competicao: identity.competicao,
          data: kickoff.data.toISOString(), kickoffInferido: kickoff.kickoffInferido,
          sportResolutionStatus: params.after.sportResolutionStatus,
          sportConfidence: params.after.sportConfidence,
          sportSource: params.after.sportSource,
          mercado: identity.mercado, selecao: identity.selecao,
          liveScoreHome: f.liveScoreHome ?? bet.liveScoreHome, liveScoreAway: f.liveScoreAway ?? bet.liveScoreAway,
          odds: f.odds, stake: f.stake, casaDeAposta: params.casaDeAposta, contaId: params.contaId,
          mercadoMatched: normalized.mercadoMatched,
          mercadoAliasConflict: normalized.mercadoAliasConflict ?? null,
          identityPreserved: plan.preserveResolvedIdentity,
          settlementPreserved: plan.preserveSettlement && bet.status !== "PENDING",
          legsJson: params.nextLegs,
        },
      } satisfies Prisma.InputJsonValue,
    },
  });
}

/**
 * A edição do dono numa aposta capturada mede o acerto de quem a leu: grava o
 * leitor e os campos da leitura que mudaram, sem o texto do post. Edição do
 * sistema (resolvedor de esporte) não é correção de leitura.
 */
async function auditReadingCorrectionTx(tx: Prisma.TransactionClient, params: {
  bet: EditBet;
  edit: ApplyBetEditParams;
  f: EditedFields;
  identity: PersistedIdentity;
}): Promise<void> {
  const { bet, edit, f, identity } = params;
  if (edit.financialAuthority !== "operator" || bet.captureReader === null) return;
  const fields = correctedReadingFields(
    { evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao, odds: toNumber(bet.odds), stake: toNumber(bet.stake) },
    { evento: identity.evento, mercado: identity.mercado, selecao: identity.selecao, odds: f.odds, stake: f.stake },
  );
  // Stake definida pela banca não foi lida do post: mudá-la não é erro de leitura.
  const stakeSource = (bet.captureStakeSnapshot as { source?: unknown } | null)?.source;
  const read = stakeSource === undefined || stakeSource === "message" ? fields : fields.filter((field) => field !== "stake");
  if (read.length === 0) return;
  await tx.auditEvent.create({
    data: {
      actor: edit.actor,
      action: READING_CORRECTED_ACTION,
      resource: "bet",
      resourceId: bet.id,
      details: { reader: bet.captureReader, fields: read } satisfies Prisma.InputJsonValue,
    },
  });
}

/**
 * O placar ao vivo gravado é imutável (`planBetEdit` recusa trocá-lo), então
 * lê-lo antes da transação não corre risco de ficar velho. Ele diz à
 * normalização que o "1x2" da seleção é o placar, não o mercado 1X2.
 */
async function storedLiveScoreOf(
  betId: string,
  client?: SerializableTransactionClient,
): Promise<{ home: number; away: number } | null> {
  const bet = await (client ?? prisma).$transaction((tx) => tx.bet.findUnique({
    where: { id: betId },
    select: { liveScoreHome: true, liveScoreAway: true },
  }));
  return bet && bet.liveScoreHome !== null && bet.liveScoreAway !== null
    ? { home: bet.liveScoreHome, away: bet.liveScoreAway }
    : null;
}

export async function applyBetEdit(
  params: ApplyBetEditParams,
  options?: { client?: SerializableTransactionClient & MercadoCatalogClient },
): Promise<ApplyBetEditResult> {
  const normalized = await normalizeBetEditInput(
    params.fields,
    options?.client,
    await storedLiveScoreOf(params.betId, options?.client),
  );
  const { hasExplicitLegs, normalizedLegs } = await prepareEditedLegs({
    fields: params.fields, parsed: normalized.parsedFields, client: options?.client,
  });
  return runSerializableTransaction(
    "applyBetEdit",
    async (tx) => {
      const bet = await loadBetEditState(tx, params.betId);
      if (bet.deletedAt) {
        throw new BetRemovedError(bet.id, "edição");
      }
      // Formulário aberto antes de uma escrita dos workers (liquidação,
      // casamento, horário, esporte) devolveria os valores velhos e apagaria
      // o fechamento: o dono recarrega e vê o estado novo.
      if (params.financialAuthority === "operator" && params.expectedVersion !== bet.manualSettlementVersion) {
        throw new RecusaDeNegocioError(
          "A aposta mudou desde que a ficha abriu (resultado, jogo casado, horário ou esporte). Recarregue a ficha e refaça a edição.",
        );
      }
      await assertSportResolutionEditTx(tx, bet, params);
      assertKeepsConfirmedKickoff(bet, params.fields);
      const f = resolveEditedFields(bet, params, normalized);
      const nextLegs = resolveEditedLegs({
        existingLegsJson: bet.legsJson, normalizedLegs, hasExplicitLegs,
        existingTerms: [bet.evento, bet.selecao],
        incomingTerms: [normalized.parsedFields.evento, normalized.parsedFields.selecao],
      });
      const plan = planBetEdit(bet, params, f, nextLegs, Boolean(normalized.normalized.mercadoAliasConflict));

      // Correção só de alias em aposta final não religa a outra conta sem mover o ledger.
      const keepsFinalSettlement = plan.preserveSettlement && bet.status !== "PENDING";
      const casaDeAposta = keepsFinalSettlement ? bet.casaDeAposta : (f.casaDeAposta ?? bet.casaDeAposta);
      const resolvedContaId =
        bet.bankroll.vincularContas && casaDeAposta
          ? await findContaAtivaParaCasa(tx, { bankrollId: bet.bankroll.id, casaDeAposta })
          : null;
      // A aposta que já estava numa conta LIMITADA da mesma casa continua nela,
      // mesmo com outra conta ATIVA da casa: a limitação barra aposta nova, não
      // o resultado da que já foi feita (mesma precedência de `settle.ts`).
      const keepsLimitedConta = Boolean(
        bet.contaId && bet.conta && bet.conta.status === "LIMITADA" && bet.conta.deletedAt === null &&
        casaDeAposta && isSameBookmaker(bet.conta.casaDeAposta, casaDeAposta),
      );
      const contaId = keepsFinalSettlement || keepsLimitedConta ? bet.contaId : resolvedContaId;
      const source = plan.preserveResolvedIdentity ? bet : f;
      const identity: PersistedIdentity = {
        evento: source.evento,
        competicao: source.competicao,
        pais: source.pais,
        mercado: source.mercado,
        selecao: source.selecao,
      };
      const previousEvidence = !plan.preserveSettlement ? await readSettlementEvidenceTx(tx, bet.id) : undefined;
      if (!plan.preserveSettlement) await syncPlayerPropTx(tx, bet, f, nextLegs, plan.casaChanged);

      const after = await tx.bet.update({
        where: { id: bet.id },
        data: editedBetData({ bet, edit: params, f, plan, identity, nextLegs, contaId, casaDeAposta }),
        select: { esporte: true, sportResolutionStatus: true, sportConfidence: true, sportSource: true },
      });
      // O estorno vem depois do update, como na liquidação: a aposta trava antes da conta.
      if (!plan.preserveSettlement) await reopenSettlementTx(tx, bet, reopenSource(params), params.actor, previousEvidence!);
      await invalidateSharpEvidenceTx(tx, bet, plan, f.odds);
      await auditBetEditTx(tx, { bet, edit: params, f, plan, identity, normalized: normalized.normalized, nextLegs, contaId, casaDeAposta, previousEvidence, after });
      await auditReadingCorrectionTx(tx, { bet, edit: params, f, identity });

      if (normalized.normalized.mercadoAliasConflict) {
        await reportMercadoAliasConflictTx(tx, {
          betId: bet.id,
          mercadoRecebido: normalized.parsedFields.mercado,
          esporte: normalized.fields.esporte,
          conflict: normalized.normalized.mercadoAliasConflict,
        });
      }

      return {
        requiresEnrich: !plan.preserveResolvedIdentity,
        identityPreserved: plan.preserveResolvedIdentity,
        settlementPreserved: plan.preserveSettlement,
      };
    },
    options,
  );
}
