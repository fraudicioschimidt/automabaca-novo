import { parseSpDateTimeInput, shiftDayKey } from "./dates";

export const ANALYZER_PERIODS = ["tudo", "90d", "30d", "7d", "hoje"] as const;
export type AnalyzerPeriod = typeof ANALYZER_PERIODS[number];
export type AnalyzerQuery = { periodo: AnalyzerPeriod; esporte: string; casa: string; pagina: number };
export const ANALYZER_PAGE_SIZE = 50;

/**
 * `defaultPeriod` vale quando a URL não escolhe período: a banca abre em
 * `tudo`, a carteira em `90d` (junta todas as bancas e chega antes ao teto de
 * detalhe).
 */
export function parseAnalyzerQuery(input: Record<string, unknown> = {}, defaultPeriod: AnalyzerPeriod = "tudo"): AnalyzerQuery {
  const text = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 100) : "";
  const period = text(input.periodo);
  const page = Number(input.pagina);
  return {
    periodo: ANALYZER_PERIODS.find((value) => value === period) ?? defaultPeriod,
    esporte: text(input.esporte), casa: text(input.casa),
    pagina: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000_000) : 1,
  };
}

export function analyzerPeriodDays(period: string): number | null {
  return period === "hoje" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : period === "90d" ? 90 : null;
}

/**
 * A janela do recorte, pelo dia do jogo (kickoff) em São Paulo: o mesmo eixo do
 * agrupamento por período e do CLV. Inclui a janela anterior apenas quando ela
 * alimenta o comparativo.
 */
export function analyzerDateFilter(period: AnalyzerPeriod, today: string, includePrevious = false) {
  const days = analyzerPeriodDays(period);
  if (!days) return undefined;
  const start = shiftDayKey(today, 1 - days * (includePrevious ? 2 : 1));
  const end = shiftDayKey(today, 1);
  const gte = parseSpDateTimeInput(start, "00:00");
  const lt = parseSpDateTimeInput(end, "00:00");
  if (!gte || !lt) throw new Error("Período inválido.");
  return { gte, lt };
}

/**
 * O filtro do recorte. O fim da janela vale para o que já tem resultado: a
 * pendente de jogo futuro entra, senão a aposta de hoje para o jogo de amanhã
 * não apareceria em recorte nenhum.
 */
export function analyzerWindowWhere(period: AnalyzerPeriod, today: string, includePrevious = false) {
  const window = analyzerDateFilter(period, today, includePrevious);
  if (!window) return {};
  return { data: { gte: window.gte }, OR: [{ data: { lt: window.lt } }, { status: "PENDING" as const }] };
}
