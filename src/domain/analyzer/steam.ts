import { roundMoney } from "@/src/domain/money";
import { spDayKey } from "@/src/domain/dates";
import { fechamentoConfirmado } from "@/src/domain/no-odds-reason";
import type { BetRowData } from "@/src/domain/bet-read-model";
import { agregaGrupo, media, ordenaPorData, type GrupoAgg } from "./shared";

/** Aba Steam & Line: deltas vs abertura/fechamento RAW da
 * Pinnacle, classificação steam/neutro/reverse e trajetórias de preço. */

export type SteamBucketV1 = GrupoAgg & { label: string };

export type SteamV1 = {
  totalBets: number;
  withOpening: number;
  withClosing: number;
  avgOpeningToEntry: number | null; // % (odd entrada vs abertura raw)
  avgEntryToClosing: number | null; // % (odd entrada vs fechamento raw)
  steam: GrupoAgg;
  noSteam: GrupoAgg;
  reverseLine: GrupoAgg;
  openingDeltaDist: Array<{ label: string; count: number }>;
  closingDeltaDist: Array<{ label: string; count: number }>;
  byOpeningDelta: SteamBucketV1[];
  byClosingDelta: SteamBucketV1[];
  pricePaths: Array<{
    dayKey: string;
    evento: string;
    opening: number | null;
    taken: number;
    closing: number | null;
    lucro: number | null;
  }>;
};

const DELTA_FAIXAS: Array<[string, (v: number) => boolean]> = [
  ["< −5%", (v) => v < -5],
  ["−5 a −2%", (v) => v >= -5 && v < -2],
  ["−2 a 0%", (v) => v >= -2 && v < 0],
  ["0 a +2%", (v) => v >= 0 && v < 2],
  ["+2 a +5%", (v) => v >= 2 && v < 5],
  ["≥ +5%", (v) => v >= 5],
];

/** Andar mínimo da linha, em %, para contar como movimento; abaixo, estável. */
const MOVIMENTO_MINIMO_PCT = 2;

/**
 * O movimento de UMA aposta, da abertura justa ao fechamento justo
 * (`movimento`, em %). Odd que cai é o mercado indo para a seleção (steam);
 * odd que sobe, indo contra (drift). Sem os dois preços não há leitura, e
 * `null` não pode virar "estável".
 */
export function tipoDeMovimento(movimentoPct: number | null | undefined): "steam" | "drift" | "estavel" | null {
  if (movimentoPct == null || !Number.isFinite(movimentoPct)) return null;
  if (movimentoPct <= -MOVIMENTO_MINIMO_PCT) return "steam";
  if (movimentoPct >= MOVIMENTO_MINIMO_PCT) return "drift";
  return "estavel";
}

export function rawPriceDeltaPct(minha: number, referencia: number | null): number | null {
  if (referencia === null || !Number.isFinite(referencia) || referencia <= 1) return null;
  // Odds brutas têm quatro casas: oito casas no percentual preservam a
  // resolução delas e impedem que ruído binário atravesse os cortes das faixas.
  return roundMoney((minha / referencia - 1) * 100, 8);
}

function rawOddValida(odd: number | null): odd is number {
  return odd !== null && Number.isFinite(odd) && odd > 1;
}

export function computeSteamV1(bets: BetRowData[]): SteamV1 {
  const comAbertura = bets.filter((b) => rawOddValida(b.openingRawOdd));
  // Fechamento só CONFIRMADO (`fechamentoConfirmado`): o snapshot provisório
  // pré-kickoff ainda se move, e `closingFetchedAt` sozinho não basta porque há
  // escritor que congela sem odd. Abertura usa openingRawOdd, que é estável.
  const comFechamento = bets.filter(
    (b) => rawOddValida(b.closingRawOdd) && fechamentoConfirmado(b),
  );

  const deltasAbertura = comAbertura
    .map((b) => ({ bet: b, delta: rawPriceDeltaPct(b.odds, b.openingRawOdd) }))
    .filter((x): x is { bet: BetRowData; delta: number } => x.delta !== null);
  const deltasFechamento = comFechamento
    .map((b) => ({ bet: b, delta: rawPriceDeltaPct(b.odds, b.closingRawOdd) }))
    .filter((x): x is { bet: BetRowData; delta: number } => x.delta !== null);

  // Grupos pela odd de ENTRADA contra a abertura (`steam` = 2% ou mais acima,
  // `reverseLine` = abaixo); a tela os chama assim. Não é o movimento do
  // mercado da abertura ao fechamento, que é o `tipoDeMovimento`.
  const steamBets = deltasAbertura.filter((x) => x.delta >= 2).map((x) => x.bet);
  const reverseBets = deltasAbertura.filter((x) => x.delta < 0).map((x) => x.bet);
  const neutroBets = deltasAbertura.filter((x) => x.delta >= 0 && x.delta < 2).map((x) => x.bet);

  const dist = (deltas: number[]) =>
    DELTA_FAIXAS.map(([label, test]) => ({ label, count: deltas.filter(test).length }));

  const porFaixa = (lista: Array<{ bet: BetRowData; delta: number }>) =>
    DELTA_FAIXAS.map(([label, test]) => ({
      label,
      ...agregaGrupo(lista.filter((x) => test(x.delta)).map((x) => x.bet)),
    })).filter((b) => b.bets > 0);

  const pricePaths = ordenaPorData(bets)
    .filter(
      (b) => rawOddValida(b.openingRawOdd)
        || (rawOddValida(b.closingRawOdd) && fechamentoConfirmado(b)),
    )
    .slice(-20)
    .reverse()
    .map((b) => ({
      dayKey: spDayKey(b.data),
      evento: b.evento,
      opening: rawOddValida(b.openingRawOdd) ? b.openingRawOdd : null,
      taken: b.odds,
      closing: fechamentoConfirmado(b) && rawOddValida(b.closingRawOdd)
        ? b.closingRawOdd
        : null, // provisório ou inválido não vaza
      lucro: b.status === "PENDING" ? null : b.lucro,
    }));

  return {
    totalBets: bets.length,
    withOpening: comAbertura.length,
    withClosing: comFechamento.length,
    avgOpeningToEntry: media(deltasAbertura.map((x) => x.delta)),
    avgEntryToClosing: media(deltasFechamento.map((x) => x.delta)),
    steam: agregaGrupo(steamBets),
    noSteam: agregaGrupo(neutroBets),
    reverseLine: agregaGrupo(reverseBets),
    openingDeltaDist: dist(deltasAbertura.map((x) => x.delta)),
    closingDeltaDist: dist(deltasFechamento.map((x) => x.delta)),
    byOpeningDelta: porFaixa(deltasAbertura),
    byClosingDelta: porFaixa(deltasFechamento),
    pricePaths,
  };
}
