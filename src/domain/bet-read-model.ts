import type { ExportPriceEvidence } from "./bet-export";
import type { ManualSettlementView } from "./manual-settlement";

/** Snapshot de leitura compartilhado por métricas e adaptadores; sem Prisma ou I/O. */
export type BetRowData = {
  id: string;
  settlementView?: ManualSettlementView | null;
  data: Date;
  evento: string;
  competicao: string;
  pais: string;
  esporte: string;
  sportResolutionStatus?: string;
  sportPendingMessage?: string | null;
  mercado: string;
  selecao: string;
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
  kickoffInferido?: boolean;
  contaId?: string | null;
  contaApelido?: string | null;
  casaDeAposta: string;
  tipster: string;
  odds: number;
  stake: number;
  status: string;
  lucro: number;
  openingEvidence?: ExportPriceEvidence | null;
  closingEvidence?: ExportPriceEvidence | null;
  closingOdd: number | null;
  /** Abertura (`bet_opening`, BridgeOdds). */
  openingMaxBet: number | null;
  closingMaxBet: number | null;
  openingMaxBetCurrency?: string | null;
  closingMaxBetCurrency?: string | null;
  openingOdd: number | null;
  openingRawOdd: number | null;
  closingRawOdd: number | null;
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  settledAt?: Date | null;
  /** Quando o dono marcou a entrada como pega (👍 no post do canal). */
  takenAt?: Date | null;
  clv: number | null;
  clvReliable: boolean | null;
  closingFetchedAt?: Date | null;
  /** Última escrita da prova: a busca pós-jogo pode completar CLV depois de fetchedAt. */
  closingUpdatedAt?: Date | null;
  /** Quem FORNECEU a odd de fechamento — a procedência verificável do CLV. */
  closingProvider?: string | null;
  /** Mecanismo da escrita: CRON (automático), MANUAL, REPROCESS (repescagem). */
  closingSource?: string | null;
  identityStatus: string | null;
  noOddsReason: string | null;
  closingNoOddsReason: string | null;
  /** Por que a abertura falta (`bet_opening.noOpeningReason`). */
  openingNoOddsReason?: string | null;
  source: string;
  sourceExternalId: string | null;
  contaTitular: string | null;
  bkSlug?: string;
  /** A banca de onde a aposta veio, na carteira (o Analyzer de todas as bancas juntas). */
  bankrollName?: string;
  /**
   * Valor histórico da unidade. Na carteira stake/lucro já estão em reais;
   * stakeUnits/profitUnits conservam os originais para exportação e simulação.
   */
  valorUnidade?: number;
  /** Valores originais para simulação: a conversão em reais pode arredondar microunidades. */
  stakeUnits?: number;
  profitUnits?: number;
};
