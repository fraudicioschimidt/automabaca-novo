/**
 * Exportação CSV do histórico de apostas — colunas, rótulos e escape.
 * Client-safe: usado pela tela (fallback local / copiar visíveis) e pela
 * server action (histórico completo).
 *
 * Schema mais rico que o v2 (14 cols): inclui esporte, casa, autor da tip, origem,
 * opening/fair/closing, identidade e motivo de ausência de odd — o que o
 * sharp já calcula e o Excel precisa para análise fora do painel.
 */
import { unitsToReais } from "./money";
import type { PriceSnapshot } from "./price-provenance";
import { captureOriginLabel } from "./telegram-source";

export const BET_EXPORT_COLUMNS = [
  "Data",
  "Hora",
  "DataLiquidacao",
  "HoraLiquidacao",
  "Mandante",
  "Visitante",
  "Esporte",
  "Regiao",
  "Liga",
  "Mercado",
  "Linha",
  "PlacarTip",
  "Casa",
  "Titular",
  "Conta",
  "AutorDaTip",
  "Origem",
  "Odds",
  "Opening",
  "Closing",
  "Linha%",
  "CLV%",
  "Stake",
  "Status",
  "Lucro",
  "Identidade",
  "SemOdd",
  "IdAposta", "TipsterSlug", "UnidadeHistorica", "StakeReais", "LucroReais",
  "KickoffISO", "KickoffInferido", "RegistradoISO", "PostISO", "LiquidadoISO", "IdOrigem",
  "ClosingCongeladoISO", "CLVConfiavel", "OpeningBruta", "ClosingBruta",
  "OpeningProvider", "OpeningReferencia", "OpeningObservadoISO", "OpeningSnapshot",
  "ClosingProvider", "ClosingReferencia", "ClosingObservadoISO", "ClosingSnapshot",
  "OpeningLimite", "OpeningMoeda", "ClosingLimite", "ClosingMoeda",
  "ClosingAtualizadoISO", "VersaoExportacao",
] as const;

/** Só prova validada; JSON mínimo do book, sem o payload do fornecedor. */
export type ExportPriceEvidence = {
  provider: string;
  reference: string;
  observedAt: string;
  snapshot: PriceSnapshot;
};

export type BetExportInput = {
  id?: string;
  bankrollSlug?: string;
  unitValue?: number;
  kickoffIso?: string;
  kickoffInferred?: boolean;
  registeredIso?: string;
  postedIso?: string;
  settledIso?: string;
  sourceExternalId?: string;
  closingFrozenIso?: string;
  closingUpdatedIso?: string;
  clvReliable?: boolean;
  openingRaw?: number | null;
  closingRaw?: number | null;
  openingEvidence?: ExportPriceEvidence | null;
  closingEvidence?: ExportPriceEvidence | null;
  openingLimit?: number | null;
  openingCurrency?: string | null;
  closingLimit?: number | null;
  closingCurrency?: string | null;
  day: string;
  time: string;
  settledDay?: string;
  settledTime?: string;
  home: string;
  away: string;
  esporte: string;
  region: string;
  league: string;
  market: string;
  line: string;
  scoreAtTip: string;
  casa: string;
  titular?: string;
  conta?: string;
  tipster: string;
  origin: string;
  odds: number;
  opening: number | null;
  closing: number | null;
  /** Movimento da linha: fair de abertura → fair de fechamento, em %. */
  movimento: number | null;
  clv: number | null;
  stake: number;
  status: string;
  profit: number | null;
  identity: string;
  noOdds: string;
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  won: "Ganha",
  halfwon: "Meia ganha",
  half_won: "Meia ganha",
  lost: "Perdida",
  half: "Meia perda",
  half_lost: "Meia perda",
  void: "Reembolso",
  cashout: "Cashout",
  // Aceita também o enum do banco (caso o mapper passe cru).
  PENDING: "Pendente",
  WON: "Ganha",
  HALF_WON: "Meia ganha",
  LOST: "Perdida",
  HALF_LOST: "Meia perda",
  VOID: "Reembolso",
  CANCELED: "Cancelada",
  CASHOUT: "Cashout",
};

const IDENTITY_LABELS: Record<string, string> = {
  PENDING: "Pendente",
  MATCHED: "Casada",
  UNMATCHED: "Não casada",
  AMBIGUOUS: "Ambígua",
};

export function betExportStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function betExportIdentityLabel(status: string | null | undefined): string {
  if (!status) return "";
  return IDENTITY_LABELS[status] ?? status;
}

/** Origem da captura → rótulo curto (espelha a ficha, sem depender do adapter UI). */
export function betExportOriginLabel(source: string): string {
  return source ? captureOriginLabel(source) : "";
}

export function betExportRow(b: BetExportInput): (string | number)[] {
  return [
    b.day,
    b.time,
    b.settledDay ?? "",
    b.settledTime ?? "",
    b.home,
    b.away,
    b.esporte,
    b.region,
    b.league,
    b.market,
    sheetText(b.line),
    sheetText(b.scoreAtTip),
    b.casa,
    b.titular ?? "",
    b.conta ?? "",
    b.tipster,
    b.origin,
    b.odds,
    b.opening == null ? "" : sheetNumber(b.opening, SHEET_UNITS),
    b.closing == null ? "" : sheetNumber(b.closing, SHEET_UNITS),
    b.movimento ?? "",
    b.clv ?? "",
    sheetNumber(b.stake, SHEET_UNITS),
    betExportStatusLabel(b.status),
    b.profit == null ? "" : sheetNumber(b.profit, SHEET_UNITS),
    b.identity,
    b.noOdds,
    b.id ?? "", b.bankrollSlug ?? "", b.unitValue ?? "",
    b.unitValue == null ? "" : sheetNumber(unitsToReais(b.stake, b.unitValue), SHEET_UNITS),
    b.unitValue == null || b.profit == null ? "" : sheetNumber(unitsToReais(b.profit, b.unitValue), SHEET_UNITS),
    b.kickoffIso ?? "", b.kickoffInferred == null ? "" : String(b.kickoffInferred),
    b.registeredIso ?? "", b.postedIso ?? "", b.settledIso ?? "", sheetText(b.sourceExternalId ?? ""),
    b.closingFrozenIso ?? "", b.clvReliable == null ? "" : String(b.clvReliable),
    b.openingRaw ?? "", b.closingRaw ?? "",
    b.openingEvidence?.provider ?? "", b.openingEvidence?.reference ?? "", b.openingEvidence?.observedAt ?? "",
    b.openingEvidence ? JSON.stringify(b.openingEvidence.snapshot) : "",
    b.closingEvidence?.provider ?? "", b.closingEvidence?.reference ?? "", b.closingEvidence?.observedAt ?? "",
    b.closingEvidence ? JSON.stringify(b.closingEvidence.snapshot) : "",
    b.openingLimit ?? "", b.openingCurrency ?? "", b.closingLimit ?? "", b.closingCurrency ?? "",
    b.closingUpdatedIso ?? "", 1,
  ];
}

/**
 * CSV e TSV vão para planilha em PT-BR, onde o ponto é o milhar: "1.925" viraria
 * 1925. Número sai com vírgula decimal, sem agrupamento e com até 4 casas (a
 * precisão da odd bruta); a odd justa conserva suas seis casas. o arredondamento corta a cauda de float do movimento.
 * Stake e lucro saem com as 6 casas das unidades no banco: com menos, a soma
 * da coluna diverge do painel.
 */
const SHEET_NUMBER = new Intl.NumberFormat("pt-BR", { useGrouping: false, maximumFractionDigits: 4 });
const SHEET_UNITS = new Intl.NumberFormat("pt-BR", { useGrouping: false, maximumFractionDigits: 6 });

/**
 * O "-0" (zero negativo ou valor que arredonda a zero) sai como "0" à mão:
 * `signDisplay: "negative"` lançaria RangeError em navegador sem Intl v3, e o
 * módulo carrega junto com a tela da banca.
 */
function sheetNumber(value: number, format: Intl.NumberFormat = SHEET_NUMBER): string {
  const text = format.format(value);
  return text === "-0" ? "0" : text;
}

/**
 * Texto feito só de números ("2-1" do placar, "2.5" ou "-1.5" da linha) a
 * planilha leria como data ou milhar: sai marcado como texto, como a célula
 * com cara de fórmula.
 */
function sheetText(value: string): string {
  const text = value.trim();
  return /^[+-]?\d+(?:[.,:/-]\d+)*$/.test(text) ? `'${text}` : value;
}

function spreadsheetSafeCell(value: string | number): string {
  const original = typeof value === "number" ? sheetNumber(value) : value;
  const isNumericText = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(original.trim());
  const looksLikeFormula =
    typeof value === "string" &&
    !isNumericText &&
    (/^[\s\t\r\n]*[=+\-@]/.test(original) || /^cmd\b/i.test(original.trim()) || /^\|/.test(original.trim()));
  const raw = original.replace(/\r\n|\n|\r|\t/g, " ");
  return looksLikeFormula ? `'${raw.replace(/^\s+/, "")}` : raw;
}

export function escapeCsvCell(value: string | number): string {
  const s = spreadsheetSafeCell(value);
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeTsvCell(value: string | number): string {
  return spreadsheetSafeCell(value).replace(/\t/g, " ").replace(/[\r\n]+/g, " ");
}

/** CSV com separador `;` e BOM UTF-8 (Excel PT-BR). */
export function buildBetExportCsv(bets: readonly BetExportInput[]): string {
  const lines = [
    BET_EXPORT_COLUMNS.join(";"),
    ...bets.map((b) => betExportRow(b).map(escapeCsvCell).join(";")),
  ];
  return `\ufeff${lines.join("\n")}`;
}

/** TSV para “copiar visíveis” (tab-separated, sem BOM), com os números em PT-BR. */
export function buildBetExportTsv(bets: readonly BetExportInput[]): string {
  return [
    BET_EXPORT_COLUMNS.join("\t"),
    ...bets.map((b) => betExportRow(b).map(escapeTsvCell).join("\t")),
  ].join("\n");
}

/** Nome do arquivo de download por slug da banca. */
export function betExportFilename(slug?: string | null): string {
  return slug && /^[a-z0-9-]+$/i.test(slug) ? `${slug}-apostas.csv` : "apostas.csv";
}

/**
 * Forma mínima da aposta na tela (toBet / mock) → linha de export.
 * Usado no fallback client e no “copiar visíveis”.
 */
export function uiBetToExportInput(b: {
  id?: string;
  day: string;
  time: string;
  resultDay?: string | null;
  resultTime?: string | null;
  home: string;
  away: string;
  esporte?: string;
  region: string;
  league?: string | null;
  market: string;
  line: string;
  liveScoreAtTip?: string | null;
  odds: number;
  movimento?: number | null;
  clv: number | null;
  stake: number;
  status: string;
  profit: number | null;
  d?: {
    open?: number | null;
    close?: number | null;
    casa?: string | null;
    origin?: string | null;
    contaTitular?: string | null;
    contaApelido?: string | null;
  };
}): BetExportInput {
  return {
    id: b.id,
    day: b.day,
    time: b.time,
    settledDay: b.resultDay ?? "",
    settledTime: b.resultTime ?? "",
    home: b.home,
    away: b.away,
    esporte: b.esporte ?? "",
    region: b.region,
    league: b.league || "",
    market: b.market,
    line: b.line,
    scoreAtTip: b.liveScoreAtTip ?? "",
    casa: b.d?.casa || "",
    titular: b.d?.contaTitular || "",
    conta: b.d?.contaApelido || "",
    tipster: "",
    origin: b.d?.origin || "",
    odds: b.odds,
    opening: b.d?.open ?? null,
    closing: b.d?.close ?? null,
    movimento: b.movimento ?? null,
    clv: b.clv,
    stake: b.stake,
    status: b.status,
    profit: b.profit,
    identity: "",
    noOdds: "",
  };
}
