import type { BetRowData } from "@/src/domain/bet-read-model";
import { comparableUsdLiquidity } from "@/src/domain/liquidity";
import { fechamentoConfirmado } from "@/src/domain/no-odds-reason";
import { agregaGrupo, media, type GrupoAgg } from "./shared";

/** Aba Liquidez: faixas por liquidez de abertura/fechamento e momentum do
 * limite (fechamento vs abertura: crescendo/estável/secando). */

export type LiqBucketV1 = GrupoAgg & { label: string };

export type MomentumRow = GrupoAgg & {
  key: "crescendo" | "estavel" | "secando";
  label: string;
  desc: string;
};

export type LiquidezV1 = {
  totalBets: number;
  totalWithOpeningLiq: number;
  totalWithClosingLiq: number;
  avgOpeningLiq: number | null;
  avgClosingLiq: number | null;
  byOpeningLiq: LiqBucketV1[];
  byClosingLiq: LiqBucketV1[];
  bestBucket: LiqBucketV1 | null;
  momentum: MomentumRow[];
};

const FAIXAS: Array<[string, (v: number) => boolean]> = [
  ["< $500", (v) => v < 500],
  ["$500–2k", (v) => v >= 500 && v < 2_000],
  ["$2k–5k", (v) => v >= 2_000 && v < 5_000],
  ["$5k–20k", (v) => v >= 5_000 && v < 20_000],
  ["≥ $20k", (v) => v >= 20_000],
];

export function computeLiquidezV1(bets: BetRowData[]): LiquidezV1 {
  const validLiq = (value: number | null): value is number =>
    value !== null && Number.isFinite(value) && value > 0;
  // Só fechamento confirmado: o provisório pré-kickoff ainda se move.
  const closingLiq = (bet: BetRowData) => fechamentoConfirmado(bet)
    ? comparableUsdLiquidity(bet.closingMaxBet, bet.closingMaxBetCurrency)
    : null;
  const openingLiq = (bet: BetRowData) => comparableUsdLiquidity(
    bet.openingMaxBet,
    bet.openingMaxBetCurrency,
  );
  const comAbertura = bets.filter((b) => validLiq(openingLiq(b)));
  const comFechamento = bets.filter((b) => validLiq(closingLiq(b)));

  const porFaixa = (lista: BetRowData[], valor: (b: BetRowData) => number | null) =>
    FAIXAS.map(([label, test]) => ({
      label,
      ...agregaGrupo(lista.filter((b) => {
        const v = valor(b);
        return validLiq(v) && test(v);
      })),
    })).filter((b) => b.bets > 0);

  const byOpeningLiq = porFaixa(comAbertura, openingLiq);
  const byClosingLiq = porFaixa(comFechamento, closingLiq);

  const elegiveis = byClosingLiq.filter(
    (b) => b.roi !== null && b.resolvedBets >= 2,
  );
  const bestBucket = elegiveis.length
    ? elegiveis.reduce((a, b) => ((b.roi ?? -1e9) > (a.roi ?? -1e9) ? b : a))
    : null;

  // Momentum: variação do limite; os cortes de ±15% pertencem às faixas externas.
  const comAmbas = bets.filter(
    (b) => validLiq(openingLiq(b)) && validLiq(closingLiq(b)),
  );
  const cls = (b: BetRowData): MomentumRow["key"] => {
    const razao = (closingLiq(b) as number) / (openingLiq(b) as number);
    if (razao >= 1.15) return "crescendo";
    if (razao <= 0.85) return "secando";
    return "estavel";
  };
  const META: Record<MomentumRow["key"], { label: string; desc: string }> = {
    crescendo: { label: "Crescendo", desc: "Limite no fechamento pelo menos 15% acima da abertura." },
    estavel: { label: "Estável", desc: "Limite variou menos de 15% entre abertura e fechamento." },
    secando: { label: "Secando", desc: "Limite no fechamento pelo menos 15% abaixo da abertura." },
  };
  const momentum = (Object.keys(META) as Array<MomentumRow["key"]>).map((key) => ({
    key,
    ...META[key],
    ...agregaGrupo(comAmbas.filter((b) => cls(b) === key)),
  }));

  return {
    totalBets: bets.length,
    totalWithOpeningLiq: comAbertura.length,
    totalWithClosingLiq: comFechamento.length,
    avgOpeningLiq: media(comAbertura.map(openingLiq).filter((v): v is number => v !== null)),
    avgClosingLiq: media(comFechamento.map(closingLiq).filter((v): v is number => v !== null)),
    byOpeningLiq,
    byClosingLiq,
    bestBucket,
    momentum,
  };
}
