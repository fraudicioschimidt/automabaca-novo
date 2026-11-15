import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { uiDisplayColor, uiHexA } from "../../utils";
import { textoDaBaseDoDestaque } from "../../lib/destaque-de-taxa";
import { Spark } from "./spark";
import { useDesign } from "../../kit/context";
import { Cap, Panel } from "../../kit/primitives";
import { fmtPct, fmtU } from "@/src/domain/formato-de-resultado";
import type { DestaqueDeTaxa } from "../../lib/tipster-metrics";
import type { DashboardScreenProps } from "../../screen-types";

type Tipster = DashboardScreenProps["data"]["tipsters"][number];
type DestaqueAlvo = Pick<Tipster, "id" | "name">;

/** Sem ninguém elegível o cartão mostra ausência, sem destino de navegação. */
const VAZIO: DestaqueAlvo = { id: '', name: '—' };

const VIZ_W = 46;
const VIZ_H = 32;

/** Sem banca elegível: uma linha tracejada no lugar da curva ou do medidor. */
function SemDado() {
  const { T } = useDesign();
  return (
    <svg width={VIZ_W} height={VIZ_H} aria-hidden="true" style={{ display: 'block' }}>
      <line x1={4} x2={VIZ_W - 4} y1={VIZ_H / 2} y2={VIZ_H / 2} stroke={T.textFaint} strokeOpacity={0.5} strokeWidth={1.6} strokeDasharray="3 4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Meia-lua de −10% a +10%, com o zero no alto: o arco colorido vai do zero ao
 * CLV médio, e o que passa dos extremos fica encostado neles.
 */
function ClvGauge({ pct, color }: { pct: number; color: string }) {
  const { T } = useDesign();
  const c = uiDisplayColor(T, color);
  const cx = VIZ_W / 2, cy = VIZ_H - 5, r = 18;
  const t = Math.max(-1, Math.min(1, pct / 10));
  const angle = Math.PI / 2 - (t * Math.PI) / 2;
  const x = cx + r * Math.cos(angle), y = cy - r * Math.sin(angle);
  return (
    <svg width={VIZ_W} height={VIZ_H} aria-hidden="true" style={{ display: 'block' }}>
      <path d={`M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={uiHexA(c, 0.18)} strokeWidth={4} strokeLinecap="round" />
      {t !== 0 && <path d={`M${cx} ${cy - r} A${r} ${r} 0 0 ${t > 0 ? 1 : 0} ${x.toFixed(2)} ${y.toFixed(2)}`} fill="none" stroke={c} strokeWidth={4} strokeLinecap="round" />}
      <circle cx={x.toFixed(2)} cy={y.toFixed(2)} r={3.4} fill={T.surface} stroke={c} strokeWidth={2} />
    </svg>
  );
}

/** Uma linha do cartão: o dado desenhado, rótulo, banca e o número que a elegeu. */
function Destaque({ visual, label, t, metric, base, color }: {
  visual: ReactNode;
  label: string;
  t: DestaqueAlvo;
  metric: string;
  base?: string | null;
  color: string;
}) {
  const { T } = useDesign();
  const style: CSSProperties = { textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 13, padding: '14px 0', borderTop: `1px solid ${T.borderSoft}` };
  const content = <>
      <div aria-hidden="true" style={{ width: VIZ_W, height: 34, display: 'grid', placeItems: 'center', flexShrink: 0 }}>{visual}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Cap style={{ fontSize: 9.5, marginBottom: 3 }}>{label}</Cap>
        <div style={{ fontFamily: T.font.body, fontSize: 14, fontWeight: 600, color: T.text }}>{t.name}</div>
      </div>
      <span style={{ display: 'grid', justifyItems: 'end', gap: 1 }}>
        <span style={{ fontFamily: T.font.num, fontVariantNumeric: 'tabular-nums', fontSize: 15, fontWeight: 600, color }}>{metric}</span>
        {base ? <span style={{ fontSize: 10.5, color: T.textFaint }}>{base}</span> : null}
      </span>
  </>;
  return t.id ? (
    <Link href={'/tipsters/' + t.id} style={style}
      onMouseEnter={(e) => e.currentTarget.style.opacity = '0.75'} onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}>{content}</Link>
  ) : <div style={style}>{content}</div>;
}

export function DestaquesCard({ A }: {
  A: {
    best: DestaqueAlvo & Pick<Tipster, "lucro" | "hasRoi" | "equity">;
    worst: DestaqueAlvo & Pick<Tipster, "lucro" | "hasRoi" | "equity">;
    bestClv: DestaqueDeTaxa<DestaqueAlvo & Pick<Tipster, "clv">>;
  };
}) {
  const { T, ink } = useDesign();
  const bestColor = A.best.hasRoi ? ink(A.best.lucro) : T.textFaint;
  const worstColor = A.worst.hasRoi ? ink(A.worst.lucro) : T.textFaint;
  const clv = A.bestClv;
  // A curva é o lucro acumulado da banca, a mesma do ranking.
  const curva = (t: { hasRoi: boolean; equity: number[] }, color: string) =>
    t.hasRoi && t.equity.length > 1 ? <Spark data={t.equity} w={VIZ_W} h={VIZ_H} color={color} /> : <SemDado />;

  return (
    <Panel style={{ display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ margin: '0 0 2px', fontFamily: T.font.display, fontSize: 17, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>Destaques</h3>
      <div style={{ fontSize: 12, color: T.textFaint, marginBottom: 6 }}>quem puxa e quem pesa</div>
      <Destaque visual={curva(A.best, bestColor)} label="Mais lucrativo" t={A.best} metric={A.best.hasRoi ? fmtU(A.best.lucro) : '—'} color={bestColor} />
      <Destaque visual={clv.estado === 'ok' ? <ClvGauge pct={clv.row.clv} color={T.accent} /> : <SemDado />} label="Melhor CLV médio"
        t={clv.estado === 'ok' ? clv.row : VAZIO}
        metric={clv.estado === 'ok' ? fmtPct(clv.row.clv) : '—'}
        base={textoDaBaseDoDestaque(clv)}
        color={T.accent} />
      <Destaque visual={curva(A.worst, worstColor)} label="Precisa de atenção" t={A.worst} metric={A.worst.hasRoi ? fmtU(A.worst.lucro) : '—'} color={worstColor} />
    </Panel>
  );
}
