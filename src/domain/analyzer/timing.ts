import { instanteDaEntrada } from "@/src/domain/instante-da-entrada";
import { utcToSpParts } from "@/src/domain/dates";
import type { BetRowData } from "@/src/domain/bet-read-model";
import {
  agregaGrupo,
  clvConfiavel,
  media,
  RESOLVIDOS,
  type GrupoAgg,
} from "./shared";

/** Aba Timing: janelas de antecedência (post → kickoff),
 * melhor/pior janela e heatmap dia-da-semana × hora do post (SP). */

export type TimingBucketV1 = GrupoAgg & { label: string };

export type HeatCell = {
  dow: number; // 0=Dom … 6=Sáb (em SP)
  slot: number; // 0..5 (faixas de 4h)
  count: number;
  lucro: number;
  roi: number | null;
};

export type TimingV1 = {
  coveredBets: number;
  avgAntecedenciaHours: number | null;
  coveragePct: number | null;
  byAntecedencia: TimingBucketV1[];
  bestWindow: TimingBucketV1 | null;
  worstWindow: TimingBucketV1 | null;
  heatmap: HeatCell[];
};

const JANELAS: Array<[string, (h: number) => boolean]> = [
  ["Pós-kickoff", (h) => h < 0],
  ["0–1h", (h) => h >= 0 && h < 1],
  ["1–3h", (h) => h >= 1 && h < 3],
  ["3–6h", (h) => h >= 3 && h < 6],
  ["6–12h", (h) => h >= 6 && h < 12],
  ["12–24h", (h) => h >= 12 && h < 24],
  ["24–48h", (h) => h >= 24 && h < 48],
  ["≥ 48h", (h) => h >= 48],
];

export function computeTimingV1(bets: BetRowData[]): TimingV1 {
  const comJanela = bets
    .map((b) => ({ bet: b, horas: (b.data.getTime() - instanteDaEntrada(b).getTime()) / 3_600_000 }))
    .filter((x) => !x.bet.kickoffInferido && Number.isFinite(x.horas));

  const grupos = JANELAS.map(([label, test]) => ({
    label,
    bets: comJanela.filter((x) => test(x.horas)).map((x) => x.bet),
  }));
  const byAntecedencia = grupos
    .map(({ label, bets: grupo }) => ({ label, ...agregaGrupo(grupo) }))
    .filter((b) => b.bets > 0);

  // Score da janela: ROI + CLV (apenas janelas com ≥2 resolvidas e CLV medido).
  // Tratar CLV ausente como zero permitiria que uma janela sem qualquer dado de
  // fechamento vencesse uma comparação que explicitamente promete ROI + CLV.
  const elegiveis = grupos
    .map(({ label, bets: grupo }) => ({
      label,
      ...agregaGrupo(
        grupo.filter(
          (b) => RESOLVIDOS.has(b.status) && clvConfiavel(b) !== null,
        ),
      ),
    }))
    .filter((b) => b.roi !== null && b.avgClv !== null && b.resolvedBets >= 2);
  const score = (b: TimingBucketV1) => (b.roi as number) + (b.avgClv as number);
  const bestWindow = elegiveis.length
    ? elegiveis.reduce((a, b) => (score(b) > score(a) ? b : a))
    : null;
  const worstWindow = elegiveis.length
    ? elegiveis.reduce((a, b) => (score(b) < score(a) ? b : a))
    : null;

  // Heatmap: dia × faixa de 4h do post, em horário de SP.
  const porCelula = new Map<string, BetRowData[]>();
  for (const b of bets) {
    const sp = utcToSpParts(instanteDaEntrada(b));
    const dow = sp.getUTCDay();
    const slot = Math.floor(sp.getUTCHours() / 4);
    const k = `${dow}:${slot}`;
    const cur = porCelula.get(k);
    if (cur) cur.push(b);
    else porCelula.set(k, [b]);
  }
  const heatmap: HeatCell[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let slot = 0; slot < 6; slot++) {
      const grupo = porCelula.get(`${dow}:${slot}`) ?? [];
      const agg = agregaGrupo(grupo);
      heatmap.push({ dow, slot, count: grupo.length, lucro: agg.lucro, roi: agg.roi });
    }
  }

  return {
    coveredBets: comJanela.length,
    avgAntecedenciaHours: media(comJanela.map((x) => x.horas)),
    coveragePct: bets.length ? (comJanela.length / bets.length) * 100 : null,
    byAntecedencia,
    bestWindow,
    worstWindow,
    heatmap,
  };
}
