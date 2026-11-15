import { fmtPct, fmtU, fmtUnit } from "@/src/domain/formato-de-resultado";
import type { DesignContextValue } from "../../kit/context";
import { plural } from "../../lib/plural";
import { decidirBaseDaTira, type resumirApostas } from "../../lib/resumo-de-apostas";
import type { BankrollBet, BankrollView } from "./types";

export type BankrollMetric = { k: string; v: string; c: string; sub: string; big?: boolean };

/** A banca inteira. O mock não traz `hasRoi`/`hasClv`: aí deriva de `settled`/`clvMean`. */
function wholeBankroll(M: BankrollView["METRICS"]) {
  return {
    lucro: M.lucro, roi: M.roi, clv: M.clvMean, open: M.open,
    hasRoi: M.hasRoi ?? M.settled > 0,
    hasClv: M.hasClv ?? M.clvMean != null,
  };
}

/**
 * A tira de KPI conta o recorte filtrado quando o histórico completo está em
 * mão; senão fica na banca inteira (`decidirBaseDaTira`) e a faixa avisa.
 */
export function bankrollKpis({ AB, T, ink, allBets, filtered, recorte, filtroAtivo }: {
  AB: BankrollView;
  T: DesignContextValue["T"];
  ink: DesignContextValue["ink"];
  allBets: readonly BankrollBet[];
  filtered: readonly BankrollBet[];
  /** `resumirApostas(filtered)`, memoizado por quem chama. */
  recorte: ReturnType<typeof resumirApostas>;
  filtroAtivo: boolean;
}) {
  const M = AB.METRICS;
  const decisao = decidirBaseDaTira({
    filtroAtivo, historyTotal: AB.historyTotal, carregadas: allBets.length,
  });
  const usandoRecorte = decisao.base === 'recorte';
  const recorteInfo = {
    ativo: usandoRecorte,
    n: filtered.length,
    de: AB.historyTotal || allBets.length,
    truncado: decisao.motivo === 'histórico truncado',
  };

  const whole = wholeBankroll(M);
  const mLucro = usandoRecorte ? recorte.lucro : whole.lucro;
  const mRoi = usandoRecorte ? (recorte.roi ?? 0) : whole.roi;
  const mClv = usandoRecorte ? (recorte.clvMean ?? 0) : whole.clv;
  const mShare = usandoRecorte ? recorte.clvShare : M.clvShare;
  const mOpen = usandoRecorte ? recorte.pendentes : whole.open;
  const mSettled = usandoRecorte ? recorte.liquidadas : M.settled;
  const mOpenU = usandoRecorte ? recorte.stakePendente : M.openUnits;
  const hasRoi = usandoRecorte ? recorte.roi != null : whole.hasRoi;
  const hasClv = usandoRecorte ? recorte.clvMean != null : whole.hasClv;
  const subLucro = usandoRecorte
    ? `${fmtUnit(Math.abs(recorte.ganhas))} ganhas · ${fmtUnit(Math.abs(recorte.perdidas))} perdidas`
    : `${mSettled} ${plural(mSettled, 'liquidada')}`;
  const metrics: BankrollMetric[] = [
    { k: 'Lucro', v: fmtU(mLucro), c: ink(mLucro), sub: subLucro, big: true },
    { k: 'ROI', v: hasRoi ? fmtPct(mRoi) : '—', c: hasRoi ? ink(mRoi) : T.textFaint, sub: 'lucro / stake finalizada' },
    { k: 'CLV médio', v: hasClv ? fmtPct(mClv) : '—', c: hasClv ? ink(mClv) : T.textFaint, sub: hasClv && mShare != null ? `${mShare}% das alcançáveis c/ CLV` : 'sem fechamento confiável' },
    { k: 'Em aberto', v: String(mOpen), c: T.text, sub: `${fmtUnit(mOpenU)} alocadas` },
  ];

  return { metrics, recorteInfo };
}

/**
 * Números do cartão de compartilhar: sempre a banca inteira, qualquer que seja
 * a aba ou o filtro da lista, porque o N e a curva são dela e um resumo feito
 * para postar não mistura bases. O acerto esportivo vem do resumo completo.
 */
export function shareStats(AB: BankrollView) {
  return {
    share: wholeBankroll(AB.METRICS),
    shAcerto: AB.METRICS.acerto ?? 0,
    hasAcerto: AB.METRICS.acerto != null,
    shN: AB.METRICS.ops,
    shEq: AB.CHART.map((p) => p.realized),
  };
}
