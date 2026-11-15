import "server-only";
import type { Prisma } from "@/src/generated/prisma/client";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { manualSettlementView } from "@/src/domain/manual-settlement";
import { toNullableNumber, toNumber, unitsToReais } from "@/src/domain/money";
import { hasRecomputableClvEvidence, hasRecomputablePriceEvidence, isPriceSnapshot } from "@/src/domain/price-provenance";
import { quotedLiquidityLimit } from "@/src/domain/liquidity";
import { sportPendingMessage } from "@/src/domain/sport-pending";
import { prisma } from "@/src/infra/prisma";

/**
 * Leitura de apostas para o painel: os SELECTs da ficha (BET_ROW_SELECT) e do
 * Analyzer (ANALYZER_ROW_SELECT), os mappers que convertem Decimal → number na
 * borda e as consultas que devolvem BetRowData.
 */

/**
 * Limite operacional dos cálculos interativos. Acima dele o Analyzer troca o
 * detalhe por um agregado paginado em vez de truncar o histórico.
 */
export const MAX_INTERACTIVE_ANALYTICS_ROWS = 25_000;

type OpeningRaw = {
  provider: string | null;
  priceReference: string | null;
  openingOdd: Prisma.Decimal | null;
  openingRawOdd: Prisma.Decimal | null;
  openingPriceSnapshot: unknown;
  openingPriceObservedAt: Date | null;
  openingMaxBet: number | null;
  openingMaxBetCurrency: string | null;
  noOpeningReason?: string | null;
};

type ClosingPriceRaw = {
  provider: string | null;
  closingPriceReference: string | null;
  closingPriceObservedAt: Date | null;
  closingPriceSnapshot: unknown;
  clv: Prisma.Decimal | null;
  clvReliable: boolean | null;
  closingOdd: Prisma.Decimal | null;
  closingRawOdd: Prisma.Decimal | null;
  closingMaxBet: number | null;
  closingMaxBetCurrency: string | null;
  fetchedAt: Date | null;
  updatedAt?: Date;
  noOddsReason: string | null;
};

/**
 * Preço de abertura e de fechamento só saem para a tela com evidência
 * recomputável (snapshot, provider, referência e instante); sem ela os campos
 * de preço, limite e CLV ficam nulos.
 */
function priceFields(opening: OpeningRaw | null | undefined, closing: ClosingPriceRaw | null, odds: number) {
  const abertura = opening ?? null;
  const openingFair = toNullableNumber(abertura?.openingOdd ?? null);
  const openingRaw = toNullableNumber(abertura?.openingRawOdd ?? null);
  const openingReliable = hasRecomputablePriceEvidence({
    fair: openingFair,
    raw: openingRaw,
    snapshot: abertura?.openingPriceSnapshot,
    provider: abertura?.provider,
    reference: abertura?.priceReference,
    requireReference: true,
    observedAt: abertura?.openingPriceObservedAt,
  });
  const closingFair = toNullableNumber(closing?.closingOdd ?? null);
  const closingRaw = toNullableNumber(closing?.closingRawOdd ?? null);
  const closingProof = {
    fair: closingFair,
    raw: closingRaw,
    snapshot: closing?.closingPriceSnapshot,
    provider: closing?.provider,
    reference: closing?.closingPriceReference,
    requireReference: true,
    observedAt: closing?.closingPriceObservedAt,
  };
  const closingReliable = hasRecomputablePriceEvidence(closingProof);
  const clvConsistent = closingReliable && hasRecomputableClvEvidence({
    ...closingProof, odds, clv: toNullableNumber(closing?.clv ?? null),
  });
  const openingLimit = openingReliable ? quotedLiquidityLimit(abertura?.openingPriceSnapshot, abertura?.openingMaxBet ?? null) : null;
  const closingLimit = closingReliable ? quotedLiquidityLimit(closing?.closingPriceSnapshot, closing?.closingMaxBet ?? null) : null;
  return {
    openingEvidence: openingReliable && abertura && isPriceSnapshot(abertura.openingPriceSnapshot)
      ? { provider: abertura.provider!, reference: abertura.priceReference!, observedAt: abertura.openingPriceObservedAt!.toISOString(), snapshot: abertura.openingPriceSnapshot }
      : null,
    closingEvidence: closingReliable && closing && isPriceSnapshot(closing.closingPriceSnapshot)
      ? { provider: closing.provider!, reference: closing.closingPriceReference!, observedAt: closing.closingPriceObservedAt!.toISOString(), snapshot: closing.closingPriceSnapshot }
      : null,
    closingOdd: closingReliable ? closingFair : null,
    openingMaxBet: openingLimit,
    closingMaxBet: closingLimit,
    openingMaxBetCurrency: openingLimit != null ? abertura?.openingMaxBetCurrency ?? null : null,
    closingMaxBetCurrency: closingLimit != null ? closing?.closingMaxBetCurrency ?? null : null,
    openingOdd: openingReliable ? openingFair : null,
    openingRawOdd: openingReliable ? openingRaw : null,
    closingRawOdd: closingReliable ? closingRaw : null,
    clv: clvConsistent ? toNullableNumber(closing?.clv ?? null) : null,
    clvReliable: clvConsistent ? closing?.clvReliable ?? null : false,
    closingFetchedAt: closing?.fetchedAt ?? null,
    closingUpdatedAt: closing?.updatedAt ?? null,
  };
}

export function mapBetRow(bet: {
  id: string;
  manualSettlementVersion?: number;
  valorUnidade?: Prisma.Decimal;
  data: Date;
  evento: string;
  competicao: string;
  pais: string;
  esporte: string;
  sportResolutionStatus: string;
  sportEvidence?: unknown;
  mercado: string;
  selecao: string;
  liveScoreHome: number | null;
  liveScoreAway: number | null;
  kickoffInferido: boolean;
  casaDeAposta: string;
  tipster: string;
  odds: Prisma.Decimal;
  stake: Prisma.Decimal;
  status: string;
  lucro: Prisma.Decimal;
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  settledAt: Date | null;
  takenAt?: Date | null;
  source: string;
  sourceExternalId: string | null;
  conta: { id: string; titular: string; apelido: string | null } | null;
  bankroll: { slug: string };
  sharp: { identityStatus: string; provider: string | null; priceReference: string | null; noOddsReason: string | null } | null;
  opening?: OpeningRaw | null;
  closing: (ClosingPriceRaw & { source: string | null }) | null;
}): BetRowData {
  const prices = priceFields(bet.opening, bet.closing, toNumber(bet.odds));
  return {
    id: bet.id,
    settlementView: bet.manualSettlementVersion !== undefined && bet.valorUnidade !== undefined
      ? manualSettlementView({ ...bet, manualSettlementVersion: bet.manualSettlementVersion, valorUnidade: bet.valorUnidade }) : null,
    data: bet.data,
    evento: bet.evento,
    competicao: bet.competicao,
    pais: bet.pais,
    esporte: bet.esporte,
    sportResolutionStatus: bet.sportResolutionStatus,
    sportPendingMessage: bet.sportResolutionStatus === "CONFIRMED" ? null : sportPendingMessage(bet.sportEvidence),
    mercado: bet.mercado,
    selecao: bet.selecao,
    liveScoreHome: bet.liveScoreHome,
    liveScoreAway: bet.liveScoreAway,
    kickoffInferido: bet.kickoffInferido,
    casaDeAposta: bet.casaDeAposta,
    tipster: bet.tipster,
    ...(bet.valorUnidade === undefined ? {} : { valorUnidade: toNumber(bet.valorUnidade) }),
    odds: toNumber(bet.odds),
    stake: toNumber(bet.stake),
    status: bet.status,
    lucro: toNumber(bet.lucro),
    ...prices,
    registradoEm: bet.registradoEm,
    sourcePostedAt: bet.sourcePostedAt,
    settledAt: bet.settledAt,
    takenAt: bet.takenAt ?? null,
    closingProvider: bet.closing?.provider ?? null,
    closingSource: bet.closing?.source ?? null,
    identityStatus: bet.sharp?.identityStatus ?? null,
    noOddsReason: bet.sharp?.noOddsReason ?? null,
    closingNoOddsReason: bet.closing?.noOddsReason ?? null,
    openingNoOddsReason: bet.opening?.noOpeningReason ?? null,
    source: bet.source,
    sourceExternalId: bet.sourceExternalId,
    contaTitular: bet.conta?.titular ?? null,
    contaId: bet.conta?.id ?? null,
    contaApelido: bet.conta?.apelido ?? null,
    bkSlug: bet.bankroll.slug,
  };
}

export const BET_ROW_SELECT = {
  manualSettlementVersion: true, valorUnidade: true,
  id: true, data: true, evento: true, competicao: true, pais: true,
  esporte: true, sportResolutionStatus: true, sportEvidence: true, mercado: true, selecao: true,
  liveScoreHome: true, liveScoreAway: true, kickoffInferido: true,
  casaDeAposta: true, tipster: true, odds: true, stake: true, status: true,
  lucro: true, registradoEm: true, sourcePostedAt: true, settledAt: true, takenAt: true, source: true,
  sourceExternalId: true,
  conta: { select: { id: true, titular: true, apelido: true } },
  bankroll: { select: { slug: true } },
  sharp: { select: { identityStatus: true, provider: true, priceReference: true, noOddsReason: true } },
  opening: { select: { provider: true, priceReference: true, openingOdd: true, openingRawOdd: true, openingPriceSnapshot: true, openingPriceObservedAt: true, openingMaxBet: true, openingMaxBetCurrency: true, noOpeningReason: true } },
  closing: { select: { clv: true, clvReliable: true, closingOdd: true, closingRawOdd: true, closingPriceSnapshot: true, closingPriceReference: true, closingPriceObservedAt: true, closingMaxBet: true, closingMaxBetCurrency: true, noOddsReason: true, fetchedAt: true, updatedAt: true, provider: true, source: true } },
} as const;

/**
 * O post de onde a aposta veio, para a ficha: origem, mensagem e a evidência
 * da captura (texto e leitor) enquanto ela não expira. null se a aposta não
 * existe; a removida também tem ficha, só de leitura.
 */
export async function getBetCaptureOrigin(betId: string): Promise<{
  source: string;
  sourceExternalId: string | null;
  evidence: { caption: string | null; parser: string; totalUnitFromLine?: boolean } | null;
} | null> {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: { source: true, sourceExternalId: true, captureEvidence: { select: { caption: true, parser: true, parsedJson: true } } },
  });
  if (!bet) return null;
  const evidence = bet.captureEvidence;
  const parsed = evidence?.parsedJson as { totalUnitFromLine?: unknown } | null | undefined;
  return {
    source: bet.source,
    sourceExternalId: bet.sourceExternalId,
    evidence: evidence
      ? { caption: evidence.caption, parser: evidence.parser, totalUnitFromLine: parsed?.totalUnitFromLine === true }
      : null,
  };
}

/**
 * Uma aposta pela id (ficha /aposta?id=). null se não existe; a removida volta
 * também, e a ficha a mostra só para leitura (`describeRemovals`).
 */
export async function getBetDetail(betId: string): Promise<BetRowData | null> {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: BET_ROW_SELECT,
  });
  return bet ? mapBetRow(bet) : null;
}

/**
 * SELECT enxuto do Analyzer: só os campos que os cálculos, o shim
 * (app/_design/lib/tested-analyzer) e a gaveta leem. `id` e `selecao` servem à
 * gaveta (chave e link para a ficha); `noOddsReason`, `closingNoOddsReason` e
 * `noOpeningReason` decidem a base alcançável das métricas de cobertura
 * (`analyzer/cobertura.ts`).
 * Não mexa em BET_ROW_SELECT por isto: a ficha precisa dos outros campos.
 */
export const ANALYZER_ROW_SELECT = {
  id: true,
  selecao: true,
  data: true,
  evento: true,
  competicao: true,
  pais: true,
  esporte: true,
  mercado: true,
  casaDeAposta: true,
  odds: true,
  stake: true,
  status: true,
  lucro: true,
  registradoEm: true, sourcePostedAt: true,
  settledAt: true,
  kickoffInferido: true,
  sharp: { select: { noOddsReason: true } },
  opening: { select: { provider: true, priceReference: true, openingOdd: true, openingRawOdd: true, openingPriceSnapshot: true, openingPriceObservedAt: true, openingMaxBet: true, openingMaxBetCurrency: true, noOpeningReason: true } },
  closing: { select: { provider: true, closingPriceReference: true, closingPriceObservedAt: true, closingPriceSnapshot: true, clv: true, clvReliable: true, closingOdd: true, closingRawOdd: true, closingMaxBet: true, closingMaxBetCurrency: true, fetchedAt: true, updatedAt: true, noOddsReason: true } },
} as const;

type AnalyzerRowRaw = {
  id: string;
  selecao: string;
  data: Date;
  evento: string;
  competicao: string;
  pais: string;
  esporte: string;
  mercado: string;
  casaDeAposta: string;
  odds: Prisma.Decimal;
  stake: Prisma.Decimal;
  status: string;
  lucro: Prisma.Decimal;
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  settledAt: Date | null;
  kickoffInferido: boolean;
  sharp: { noOddsReason: string | null } | null;
  opening?: OpeningRaw | null;
  closing: ClosingPriceRaw | null;
};

/**
 * Devolve um BetRowData completo para o tipo seguir único; os campos que o
 * Analyzer não lê vêm com placeholder, não do banco.
 */
export function mapAnalyzerRow(bet: AnalyzerRowRaw): BetRowData {
  return {
    id: bet.id,
    data: bet.data,
    evento: bet.evento,
    competicao: bet.competicao,
    pais: bet.pais,
    esporte: bet.esporte,
    mercado: bet.mercado,
    selecao: bet.selecao,
    casaDeAposta: bet.casaDeAposta,
    tipster: "",
    odds: toNumber(bet.odds),
    stake: toNumber(bet.stake),
    status: bet.status,
    lucro: toNumber(bet.lucro),
    ...priceFields(bet.opening, bet.closing, toNumber(bet.odds)),
    registradoEm: bet.registradoEm,
    sourcePostedAt: bet.sourcePostedAt,
    settledAt: bet.settledAt,
    kickoffInferido: bet.kickoffInferido,
    identityStatus: null,
    noOddsReason: bet.sharp?.noOddsReason ?? null,
    closingNoOddsReason: bet.closing?.noOddsReason ?? null,
    openingNoOddsReason: bet.opening?.noOpeningReason ?? null,
    source: "",
    sourceExternalId: null,
    contaTitular: null,
  };
}

/** O SELECT do Analyzer mais o que a carteira precisa: a banca e o valor da unidade da aposta. */
export const PORTFOLIO_ROW_SELECT = { ...ANALYZER_ROW_SELECT, bankrollId: true, valorUnidade: true } as const;

/**
 * A linha da carteira: stake e lucro em reais, porque somar unidades de bancas
 * com valores diferentes não mede nada. O CLV é percentual e não muda.
 */
export function mapPortfolioRow(
  bet: AnalyzerRowRaw & { valorUnidade: Prisma.Decimal },
  bankrollName: string,
): BetRowData {
  const row = mapAnalyzerRow(bet);
  const unitValue = toNumber(bet.valorUnidade);
  return {
    ...row,
    stake: unitsToReais(row.stake, unitValue),
    lucro: unitsToReais(row.lucro, unitValue),
    bankrollName,
    valorUnidade: unitValue,
    stakeUnits: row.stake,
    profitUnits: row.lucro,
  };
}
