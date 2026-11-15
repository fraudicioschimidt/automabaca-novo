import { useMemo } from "react";
import type { FerramentasScreenProps } from "../../screen-types";
import { uiSmooth } from "../../utils";
import { useChartId, useResponsiveChartWidth } from "../../lib/responsive-chart";
import { escala, faixaVertical } from "../../lib/eixo-secundario";
import { ChartCrosshair, ChartReadout, useChartHover } from "../../lib/chart-hover";
import { parseDecimalInput } from "@/src/domain/decimal-input";
import { fmtPct, fmtUnit } from "@/src/domain/formato-de-resultado";
import { analyzeKelly, kellyStake } from "@/src/domain/kelly";
import { ICONS } from "../../kit/icons";
import { contagem } from "../../lib/plural";
import { useDesign } from "../../kit/context";
import { Cap } from "../../kit/primitives";
import { porFaixa } from "../../kit/faixas";
import { ToolCard, ToolField, ToolHead } from "./ui-primitives";

/**
 * Cap de stake: campo VAZIO = sem teto, mas texto e negativo são erro de
 * digitação, não "sem teto" (senão a stake sairia acima do cap anunciado).
 */
export function lerCapDeStake(valorCru: string | null | undefined) {
  const emBranco = String(valorCru ?? "").trim() === "";
  if (emBranco) return { cap: null, semTeto: true, invalido: false };
  const cap = parseDecimalInput(valorCru);
  if (cap === null || cap < 0) return { cap: null, semTeto: false, invalido: true };
  return { cap, semTeto: cap === 0, invalido: false };
}

/**
 * Margem lateral do gráfico de sensibilidade, uma fonte só: o hover indexa pela
 * mesma margem que o desenho usa, ou a leitura abre com o ponto vizinho.
 */
const SENS_PAD_L = 8;
const SENS_PAD_R = 8;

/** Os campos da calculadora, como o operador digitou. */
export type CamposKelly = { odd: string; vantagem: string; frac: string; bank: string; cap: string };

/** O cálculo pronto, ou por que não há cálculo (campo inválido). */
type KellyValido = {
  ok: true;
  capInvalido?: undefined;
  odd: number;
  vantagem: number;
  frac: number;
  bank: number;
  cap: number | null;
  b: number;
  pImp: number;
  p: number;
  full: number;
  fr: number;
  stake: number;
  capped: boolean;
};
type Kelly = KellyValido | { ok: false; capInvalido: boolean; capped?: undefined };

type PontoDeSensibilidade = { e: number; st: number };

/** Stake sugerida em função da vantagem, com a vantagem atual marcada e leitura no hover. */
function SensChart({ K, sens, chartRef, chartWidth, gradientId, iSens, sensHandlers }: {
  K: Kelly;
  sens: readonly PontoDeSensibilidade[];
  chartRef: (node: Element | null) => void;
  chartWidth: number;
  gradientId: string;
  iSens: number | null;
  sensHandlers: ReturnType<typeof useChartHover>["handlers"];
}) {
  const { T, mode } = useDesign();
  const displayAccent = T.brandAccent || T.accent;
  const W = chartWidth;
  const H = 120, padL = SENS_PAD_L, padR = SENS_PAD_R, padT = 10, padB = 24;
  // `sens` só tem pontos com o cálculo válido.
  if (!sens.length || !K.ok) return null;
  const maxSt = Math.max(K.cap || 0, ...sens.map((s) => s.st), 0.5);
  const X = escala(-2, 16, { inicio: padL, fim: W - padR }).px;
  const Y = escala(0, maxSt, faixaVertical(H, padT, padB)).px;
  const pts = sens.map((s) => ({ x: X(s.e), y: Y(s.st) }));
  const line = uiSmooth(pts);
  const area = line + ` L${pts[pts.length - 1]!.x},${Y(0)} L${pts[0]!.x},${Y(0)} Z`;
  const markerVantagem = Math.max(-2, Math.min(16, K.vantagem));
  const marker = sens.reduce((best, point) => Math.abs(point.e - markerVantagem) < Math.abs(best.e - markerVantagem) ? point : best);
  const cx = X(markerVantagem);
  const alvo = iSens != null && sens[iSens] != null ? sens[iSens] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg ref={chartRef} data-responsive-chart="true" role="img" aria-label={`Sensibilidade da stake Kelly para vantagem de ${fmtPct(K.vantagem)}`} width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }} {...sensHandlers}>
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={displayAccent} stopOpacity={mode === 'dark' ? 0.3 : 0.2} /><stop offset="100%" stopColor={displayAccent} stopOpacity="0" /></linearGradient></defs>
        {K.cap != null && K.cap > 0 && K.cap <= maxSt && <line x1={padL} x2={W - padR} y1={Y(K.cap)} y2={Y(K.cap)} stroke={T.border} strokeDasharray="3 3" />}
        {K.cap != null && K.cap > 0 && K.cap <= maxSt && <text x={W - padR} y={Y(K.cap) - 5} textAnchor="end" fontFamily={T.font.num} fontSize="9.5" fill={T.textFaint}>cap {K.cap}u</text>}
        <line x1={X(0)} x2={X(0)} y1={padT} y2={H - padB} stroke={T.borderSoft} />
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke={displayAccent} strokeWidth="2.4" strokeLinecap="round" />
        <line x1={cx} x2={cx} y1={padT} y2={H - padB} stroke={T.text} strokeDasharray="2 3" opacity="0.4" />
        <circle cx={cx} cy={Y(marker.st)} r="4" fill={displayAccent} stroke={T.surface} strokeWidth="2" />
        {[-2, 2, 6, 10, 14].map((e) => <text key={e} x={X(e)} y={H - 6} textAnchor="middle" fontFamily={T.font.num} fontSize="9.5" fill={T.textFaint}>{e}%</text>)}
        {alvo && <ChartCrosshair x={X(alvo.e)} topo={padT} base={H - padB} pontos={[{ y: Y(alvo.st), cor: displayAccent, r: 4 }]} />}
      </svg>
      {alvo && (
        <ChartReadout x={X(alvo.e)} largura={W} titulo={`Vantagem ${fmtPct(alvo.e)}`} larguraCaixa={146}
          linhas={[{ rotulo: 'Stake', cor: displayAccent, valor: fmtUnit(alvo.st) }]} />
      )}
    </div>
  );
}

export function KellyPanel({ k, kf, clvCanal = null }: {
  k: CamposKelly;
  kf: (campo: keyof CamposKelly, valor: string) => void;
  clvCanal?: FerramentasScreenProps["data"]["clvCanal"];
}) {
  const { T, ink } = useDesign();
  const displayAccent = T.brandAccent || T.accent;
  const K = useMemo((): Kelly => {
    const odd = parseDecimalInput(k.odd), vantagem = parseDecimalInput(k.vantagem), frac = parseDecimalInput(k.frac), bank = parseDecimalInput(k.bank);
    const { cap, invalido: capInvalido } = lerCapDeStake(k.cap);
    const analysis = odd === null || vantagem === null ? null : analyzeKelly(odd, vantagem);
    const ok = odd !== null && vantagem !== null && analysis && frac !== null && frac >= 0 && bank !== null && bank > 0 && !capInvalido;
    if (!ok) return { ok: false, capInvalido };
    const b = odd - 1, pImp = analysis.impliedProbability, p = analysis.estimatedProbability;
    const full = Math.max(0, analysis.fullFraction);
    const fr = full * frac;
    const stake100 = kellyStake({ odds: odd, vantagemPct: vantagem, fraction: frac, capUnits: (cap === null || cap <= 0) ? 1e9 : cap * (100 / bank) });
    let stake = stake100 * (bank / 100);
    const capped = cap !== null && cap > 0 && stake > cap - 1e-9;
    if (capped) stake = cap;
    return { ok: true, odd, vantagem, frac, bank, cap, b, pImp, p, full, fr, stake, capped };
  }, [k]);

  const sens = useMemo(() => {
    if (!K.ok) return [];
    const out: PontoDeSensibilidade[] = [];
    for (let e = -2; e <= 16.0001; e += 0.5) {
      const capUnits = (K.cap !== null && K.cap > 0) ? K.cap * (100 / K.bank) : 1e9;
      const st100 = kellyStake({ odds: K.odd, vantagemPct: e, fraction: K.frac, capUnits });
      out.push({ e, st: st100 * (K.bank / 100) });
    }
    return out;
  }, [K]);
  // Largura do primeiro desenho (a do desktop); a medida corrige no primeiro quadro.
  const { chartRef, chartWidth } = useResponsiveChartWidth(600);
  const gradientId = useChartId("kelly-sensitivity");
  // Os hooks do gráfico ficam aqui, fora do SensChart: o id do gradiente
  // (useId) depende da posição na árvore, e a medida sobrevive ao gráfico sumir.
  const { indice: iSens, handlers: sensHandlers } = useChartHover(sens.length, { largura: chartWidth, padL: SENS_PAD_L, padR: SENS_PAD_R });

  const stakePctBank = K.ok && K.bank ? K.stake / K.bank * 100 : 0;
  const breakdown = K.ok ? [
    ['Prob. estimada', (K.p * 100).toFixed(1) + '%', T.text],
    ['Prob. implícita', (K.pImp * 100).toFixed(1) + '%', T.textMuted],
    ['Edge', fmtPct((K.p - K.pImp) * 100), ink((K.p - K.pImp))],
    ['Kelly cheio', (K.full * 100).toFixed(1) + '%', T.text],
    ['Kelly × fração', (K.fr * 100).toFixed(2) + '%', T.text],
    ['da banca', stakePctBank.toFixed(2) + '%', T.accent],
  ] : [];

  return (
    <ToolCard style={{ marginBottom: 22 }}>
      {/* Só o cap VALIDADO entra no cabeçalho, nunca o `k.cap` cru. */}
      <ToolHead icon={ICONS.calc} title="Calculadora Kelly" right={`banca ${K.ok ? `${K.bank}u` : '—'} · cap ${K.ok ? (K.cap !== null && K.cap > 0 ? `${K.cap}u` : 'sem teto') : '—'}`} />
      <div {...porFaixa({ display: 'grid' }, { gridTemplateColumns: { largo: '1.5fr 1px 0.9fr', compacto: '1fr' }, gap: { largo: 28, compacto: 22 } })}>
        <div>
          <div {...porFaixa({ display: 'grid', gap: 14, marginBottom: 18 }, { gridTemplateColumns: { largo: 'repeat(3,minmax(0,1fr))', compacto: '1fr' } })}>
            <ToolField label="Odd" value={k.odd} onChange={(v) => kf('odd', v)} />
            <ToolField label="Vantagem estimada" suffix="%" value={k.vantagem} onChange={(v) => kf('vantagem', v)} />
            <ToolField label="Fração Kelly" value={k.frac} onChange={(v) => kf('frac', v)} />
          </div>
          <div {...porFaixa({ display: 'grid', gap: 14, marginBottom: 22 }, { gridTemplateColumns: { largo: 'repeat(2,minmax(0,1fr))', compacto: '1fr' } })}>
            <ToolField label="Banca" suffix="u" value={k.bank} onChange={(v) => kf('bank', v)} />
            <ToolField label="Cap de stake" suffix="u" value={k.cap} onChange={(v) => kf('cap', v)} />
          </div>
          {clvCanal && clvCanal.n > 0 ? (
            <div style={{ fontSize: 12.5, color: T.textMuted, margin: '-8px 0 18px' }}>
              CLV médio de {clvCanal.nome}: <b style={{ color: T.text }}>{fmtPct(clvCanal.media)}</b> em {contagem(clvCanal.n, 'fechamento')} · {clvCanal.verdict}.{' '}
              {clvCanal.faltam > 0
                ? <span>Faltam {contagem(clvCanal.faltam, 'fechamento')} para usar como vantagem.</span>
                : <button type="button" onClick={() => kf('vantagem', clvCanal.media.toFixed(1))} style={{ background: 'none', border: 'none', padding: 0, color: T.accent, cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>
                  usar como vantagem</button>}
            </div>
          ) : null}
          <Cap style={{ fontSize: 10, marginBottom: 10 }}>Stake sugerida × vantagem estimada</Cap>
          <SensChart K={K} sens={sens} chartRef={chartRef} chartWidth={chartWidth} gradientId={gradientId} iSens={iSens} sensHandlers={sensHandlers} />
        </div>
        <div aria-hidden="true" {...porFaixa({ background: T.borderSoft }, { height: { largo: 'auto', compacto: 1 } })} />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Cap style={{ marginBottom: 10 }}>Stake sugerida</Cap>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <div style={{ fontFamily: T.font.num, fontVariantNumeric: 'tabular-nums', fontSize: 48, fontWeight: 600, color: K.ok && K.full > 0 ? displayAccent : T.textFaint, letterSpacing: '-0.03em', lineHeight: 1 }}>
              {K.ok ? K.stake.toFixed(2) : '—'}</div>
            <div style={{ fontFamily: T.font.num, fontVariantNumeric: 'tabular-nums', fontSize: 20, fontWeight: 600, color: T.textMuted }}>u</div>
          </div>
          {K.capInvalido && <div style={{ fontSize: 12, color: T.neg, marginTop: 8 }}>Cap de stake inválido: use um número ≥ 0 ou deixe em branco para não ter teto.</div>}
          {K.ok && K.full <= 0 && <div style={{ fontSize: 12, color: T.neg, marginTop: 8 }}>Vantagem não positiva: Kelly não recomenda aposta.</div>}
          {K.capped && <div style={{ fontSize: 12, color: T.accent, marginTop: 8 }}>Limitada pelo cap de {K.cap}u.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginTop: 20, borderTop: `1px solid ${T.borderSoft}` }}>
            {breakdown.map(([l, v, c], i) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < breakdown.length - 1 ? `1px solid ${T.borderSoft}` : 'none' }}>
                <span style={{ fontFamily: T.font.body, fontSize: 13, color: T.textMuted }}>{l}</span>
                <span style={{ fontFamily: T.font.num, fontVariantNumeric: 'tabular-nums', fontSize: 14, fontWeight: 600, color: c }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 'auto', paddingTop: 16, fontSize: 11.5, color: T.textFaint, lineHeight: 1.5 }}>
            p estimada = (1 + vantagem) / odd. Kelly cheio = p − (1−p)/(odd−1). A melhor estimativa de vantagem é o CLV médio do tipster, com amostra grande.</div>
        </div>
      </div>
    </ToolCard>
  );
}
