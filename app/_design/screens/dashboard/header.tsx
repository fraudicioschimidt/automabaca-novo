import type { Dispatch, KeyboardEvent, SetStateAction } from "react";
import Link from "next/link";
import { uiHexA } from "../../utils";
import { FrescorDosDados } from "../../kit/FrescorDosDados";
import { contagem, plural } from "../../lib/plural";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { GreetingSky } from "./greeting-sky";
import type { DashboardScreenProps } from "../../screen-types";

type DashboardData = DashboardScreenProps["data"];

/**
 * O estado do motor desenhado como um eletrocardiograma: batendo quando o
 * heartbeat está em dia, linha reta tracejada quando parou ou não há dado.
 */
function Batimento({ vivo, color }: { vivo: boolean; color: string }) {
  const d = vivo ? 'M1 9h11l2.5-5 4 10 3-8 2 3H45' : 'M1 9h44';
  return (
    <svg width={46} height={18} viewBox="0 0 46 18" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {vivo
        ? <><path d={d} strokeOpacity={0.22} /><path d={d} className="batimento-vivo" /></>
        : <path d={d} strokeDasharray="3 4" />}
    </svg>
  );
}

export function DashboardHeader({ TIP, A, alertOpen, setAlertOpen }: {
  TIP: Pick<DashboardData, "alerts" | "engine" | "greeting" | "sky">;
  A: { ts: readonly unknown[] };
  alertOpen: boolean;
  setAlertOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const { T, numFont } = useDesign();
  const alerts = (TIP.alerts || []);
  const engine = TIP.engine;
  const engineColor = !engine ? T.textMuted : engine.alive ? T.pos : T.neg;
  const alertColor = alerts.length ? T.neg : T.pos;
  const engineLabel = !engine ? 'Motor sem dados' : engine.alive ? 'Motor ativo' : engine.dbOk ? 'Motor parado' : 'Motor indisponível';
  // O desenho fica preso à última palavra, para não descer sozinho de linha no celular.
  const lastWord = TIP.greeting.lastIndexOf(' ') + 1;
  const closeAlertsOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !alertOpen) return;
    event.preventDefault();
    setAlertOpen(false);
    event.currentTarget.querySelector<HTMLElement>('[data-alert-trigger]')?.focus();
  };

  return (
    <div {...porFaixa({ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 28 }, { flexWrap: { largo: 'nowrap', compacto: 'wrap' } })}>
      <div>
        <h1 style={{ margin: 0, fontFamily: T.font.display, fontSize: 33, fontWeight: T.displayWeight, letterSpacing: T.displaySpacing, color: T.text, lineHeight: 1.05 }}>
          {TIP.greeting.slice(0, lastWord)}
          <span style={{ whiteSpace: 'nowrap' }}>{TIP.greeting.slice(lastWord)}<GreetingSky sky={TIP.sky} /></span>
        </h1>
        <div style={{ fontFamily: T.font.body, fontSize: 14, color: T.textMuted, marginTop: 6 }}>Seguindo <b style={{ color: T.text, fontWeight: 600 }}>{contagem(A.ts.length, 'tipster')}</b>.</div>
      </div>
      {/* No compacto o selo do motor desce para uma linha própria, na largura toda. */}
      <div {...porFaixa({ display: 'flex', alignItems: 'center', gap: 10 }, { marginLeft: { largo: 'auto', compacto: 0 }, width: { largo: 'auto', compacto: '100%' }, flexWrap: { largo: 'nowrap', compacto: 'wrap' } })}>
        <div data-alert-pop="" onKeyDown={closeAlertsOnEscape} style={{ position: 'relative' }}>
          {/* O número de alertas no lugar do sino: a contagem é o que o botão tem a dizer. */}
          <button data-alert-trigger="" onClick={() => setAlertOpen((o) => !o)} aria-label={`Alertas: ${alerts.length}`} aria-expanded={alertOpen} aria-controls="dashboard-alerts" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 44, padding: '0 14px 0 9px', borderRadius: 999, background: T.surface, border: `1px solid ${alertOpen ? uiHexA(T.accent, 0.5) : T.border}`, color: alerts.length ? T.text : T.textMuted, cursor: 'pointer', boxShadow: T.cardShadow, fontFamily: T.font.body, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>
            <span style={{ minWidth: 26, height: 26, padding: '0 6px', borderRadius: 999, display: 'grid', placeItems: 'center', background: uiHexA(alertColor, 0.14), color: alertColor, ...numFont, fontSize: 12.5, fontWeight: 600 }}>{alerts.length}</span>
            {alerts.length ? plural(alerts.length, 'alerta') : 'sem alertas'}
          </button>
          {alertOpen && (
            <div id="dashboard-alerts" role="region" aria-label="Alertas operacionais" onClick={(e) => e.stopPropagation()} {...porFaixa({ position: 'absolute', top: 'calc(100% + 10px)', zIndex: 80, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, boxShadow: '0 24px 60px -20px rgba(0,0,0,.5)', overflow: 'hidden' }, { left: { largo: 'auto', compacto: 0 }, right: { largo: 0, compacto: 'auto' }, width: { largo: 344, compacto: 'min(344px, calc(100vw - 28px))' } })}>
              <div style={{ padding: '15px 18px', borderBottom: `1px solid ${T.borderSoft}` }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontFamily: T.font.display, fontSize: 15, fontWeight: 600, color: T.text }}>Alertas</span>
                  <span style={{ marginLeft: 'auto', ...numFont, fontSize: 12, fontWeight: 600, color: T.accentText, background: T.accent, padding: '1px 8px', borderRadius: 999 }}>{alerts.length}</span>
                </div>
              </div>
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {alerts.length === 0 && <div style={{ padding: '26px 18px', fontFamily: T.font.body, fontSize: 13, color: T.textMuted, textAlign: 'center' }}>Nenhum alerta operacional agora.</div>}
                {alerts.map((al) => {
                  const c = al.kind === 'warn' ? T.neg : al.kind === 'ok' ? T.pos : T.accent;
                  return (
                    <div key={al.id} style={{ display: 'flex', gap: 11, padding: '13px 18px', borderTop: `1px solid ${T.borderSoft}` }}>
                      <span style={{ width: 8, height: 8, borderRadius: 8, background: c, marginTop: 5, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: T.font.body, fontSize: 13.5, fontWeight: 600, color: T.text }}>{al.title}</div>
                        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2, lineHeight: 1.4 }}>{al.desc}</div>
                        <div style={{ ...numFont, fontSize: 11, color: T.textFaint, marginTop: 4 }}>{al.time}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <Link href="/monitoramento" style={{ display: 'block', textAlign: 'center', padding: '12px', borderTop: `1px solid ${T.borderSoft}`, fontFamily: T.font.body, fontSize: 13, fontWeight: 600, color: T.accent, textDecoration: 'none', background: T.surface2 }}>Ver monitoramento</Link>
            </div>
          )}
        </div>
        {/* A idade do motor fica visível ao lado do rótulo (e não num `title=`,
            invisível no toque): "Ativo" é justamente a afirmação a checar. */}
        <div {...porFaixa({ display: 'flex', alignItems: 'center', gap: 9, minHeight: 44, padding: '9px 14px', borderRadius: 999, background: T.surface, border: `1px solid ${T.border}`, boxShadow: T.cardShadow, boxSizing: 'border-box' }, { flex: { largo: '0 1 auto', compacto: '1 1 100%' } })}>
          <Batimento vivo={Boolean(engine?.alive)} color={engineColor} />
          {/* Sem espaço na linha, o frescor desce inteiro para baixo do rótulo em vez de quebrá-lo. */}
          <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 9, rowGap: 2, minWidth: 0 }}>
            <span style={{ fontFamily: T.font.body, fontSize: 13.5, fontWeight: 600, color: T.text, whiteSpace: 'nowrap' }}>{engineLabel}</span>
            {engine?.frescor?.length ? <FrescorDosDados fontes={engine.frescor} /> : null}
          </span>
        </div>
      </div>
    </div>
  );
}
