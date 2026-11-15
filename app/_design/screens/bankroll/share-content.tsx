import { uiDisplayColor, uiHexA } from "../../utils";
import { copyText } from "../../lib/clipboard";
import { Label } from "./ui-primitives";
import styles from "./share-content.module.css";
import { contagem } from "../../lib/plural";
import { escala, faixaVertical } from "../../lib/eixo-secundario";
import { ICONS, Icon } from "../../kit/icons";
import { toast } from "../../toast";
import { useDesign } from "../../kit/context";
import { fmtPct, fmtRate, fmtU } from "@/src/domain/formato-de-resultado";
import { cssVars } from "../../kit/css-vars";

function ShareCurve({ shEq, mLucro }: { shEq: readonly number[]; mLucro: number }) {
  const { T } = useDesign();
  const W = 520, H = 120, padT = 10, padB = 10;
  const values = shEq.length ? shEq : [0];
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values), rng = (hi - lo) || 1;
  const X = (i: number) => values.length === 1 ? W / 2 : 6 + (W - 12) * (i / (values.length - 1));
  const Y = escala(lo, lo + rng, faixaVertical(H, padT, padB)).px;
  const pts = values.map((v, i) => ({ x: X(i), y: Y(v) }));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  const c = mLucro >= 0 ? (T.posDisplay || T.pos) : (T.negDisplay || T.neg);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.curve}>
      <defs><linearGradient id="shg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c} stopOpacity="0.22" /><stop offset="100%" stopColor={c} stopOpacity="0" /></linearGradient></defs>
      <path d={`${line} L${pts[pts.length - 1]!.x},${H} L${pts[0]!.x},${H} Z`} fill="url(#shg)" />
      <path d={line} fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1]!.x} cy={pts[pts.length - 1]!.y} r="4" fill={c} />
    </svg>
  );
}

export function ShareContent({
  bkName, bkSeg, mLucro, mRoi, mClv, mOpen,
  hasRoi, hasClv, hasAcerto, shN, shAcerto, shEq,
}: {
  bkName: string;
  bkSeg: string;
  mLucro: number;
  mRoi: number;
  mClv: number;
  mOpen: number;
  hasRoi: boolean;
  hasClv: boolean;
  hasAcerto: boolean;
  shN: number;
  shAcerto: number;
  shEq: readonly number[];
}) {
  const { T, numFont, ink } = useDesign();
  const copySummary = async () => {
    const summary = `${bkName} · ${fmtU(mLucro)} (${hasRoi ? fmtPct(mRoi) : 'ROI —'}) · CLV ${hasClv ? fmtPct(mClv) : '—'} · ${contagem(shN, 'aposta')} — via AutomaBACA`;
    try {
      await copyText(summary);
      toast('Resumo copiado', 'ok');
    } catch {
      toast('Não foi possível copiar o resumo', 'warn');
    }
  };
  return (
    <div className={styles.root}>
      <div className={styles.card} style={cssVars({ '--radius': `${T.radius}px`, '--border': T.border, '--surface': T.surface2 })}>
        <div className={styles.header}>
          <div className={styles.icon} style={cssVars({ '--brand': T.brandAccent || T.accent, '--on-brand': T.accentText })}>
            <Icon d="M3 14l4-5 3 2 4-6 3 4" s={19} w={1.9} /></div>
          <div className={styles.identity}>
            <div className={styles.title} style={cssVars({ '--display-font': T.font.display, '--text': T.text })}>{bkName}</div>
            <div className={styles.subtitle} style={cssVars({ '--muted': T.textMuted })}>{bkSeg} · {contagem(shN, 'aposta')}</div>
          </div>
          <div className={styles.brand} style={cssVars({ '--body-font': T.font.body, '--brand': T.brandAccent || T.accent })}>AutomaBACA</div>
        </div>
        <div className={styles.result}>
          <div className={styles.profit} style={cssVars({ ...numFont, '--profit-color': uiDisplayColor(T, ink(mLucro)) })}>{fmtU(mLucro)}</div>
          <div className={styles.roi} style={cssVars({ ...numFont, '--roi-color': hasRoi ? ink(mRoi) : T.textFaint })}>{hasRoi ? `${fmtPct(mRoi)} ROI` : 'ROI —'}</div>
        </div>
        <div className={styles.caption} style={cssVars({ '--muted': T.textMuted })}>lucro acumulado no período</div>
        <ShareCurve shEq={shEq} mLucro={mLucro} />
        <div className={styles.metrics} style={cssVars({ '--soft-border': T.borderSoft })}>
          {([['CLV médio', hasClv ? fmtPct(mClv) : '—', hasClv ? ink(mClv) : T.textFaint], ['Acerto', hasAcerto ? fmtRate(shAcerto) : '—', hasAcerto ? T.text : T.textFaint], ['Em aberto', String(mOpen), T.text]] satisfies [string, string, string][]).map(([l, v, c]) => (
            <div key={l}><Label style={{ fontSize: 9, marginBottom: 6 }}>{l}</Label><div className={styles.metricValue} style={cssVars({ ...numFont, '--metric-color': c })}>{v}</div></div>
          ))}
        </div>
      </div>
      <div className={styles.actions}>
        <div className={styles.hint} style={cssVars({ '--faint': T.textFaint })}>Tire um print deste cartão para compartilhar nas redes, ou copie o resumo em texto.</div>
        <button type="button" onClick={copySummary} className={styles.copyButton} style={cssVars({ '--body-font': T.font.body, '--button-radius': `${T.radiusMd}px`, '--accent': T.accent, '--on-accent': T.accentText, '--button-shadow': `0 8px 20px -8px ${uiHexA(T.accent, 0.55)}` })}>
          <Icon d={ICONS.copy} s={15} />Copiar resumo</button>
      </div>
    </div>
  );
}
