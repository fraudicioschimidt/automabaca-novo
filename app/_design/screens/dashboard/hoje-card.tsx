import { uiHexA } from "../../utils";
import { contagem, plural } from "../../lib/plural";
import { useDesign } from "../../kit/context";
import { Cap } from "../../kit/primitives";
import { fmtBrl } from "@/src/domain/formato-de-resultado";
import type { DashboardScreenProps } from "../../screen-types";

type DashboardData = DashboardScreenProps["data"];

export function HojeCard({ TIP, A }: { TIP: Pick<DashboardData, "todayLabel" | "todayTile">; A: Pick<DashboardData, "today"> }) {
  const { T, numFont, ink } = useDesign();
  const hj = A.today;
  // Régua para o lucro do dia. Só aparece quando existe: sem histórico ela
  // viraria "média R$ 0,00", que é pior que nenhuma referência. "operado" passa
  // pelo `plural` mesmo com o guarda de 1 dia morando em outro arquivo.
  const media = hj.mediaDiaria != null
    ? `média ${fmtBrl(hj.mediaDiaria, true)} em ${contagem(hj.diasOperados, 'dia')} ${plural(hj.diasOperados, 'operado')}`
    : null;
  const hojeStats = [
    { k: 'Lucro do dia', el: fmtBrl(hj.lucroDia, true), c: ink(hj.lucroDia), nota: media },
    { k: 'Resolvidas hoje', el: String(Math.round(hj.resolvidas)), c: T.text },
    { k: 'Apostas novas', el: String(Math.round(hj.tips)), c: T.text },
    { k: 'A resolver', el: String(Math.round(hj.aResolver)), c: hj.aResolver ? T.accent : T.text },
  ];

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18, rowGap: 16, padding: '18px 24px', marginBottom: 22, borderRadius: T.radius, background: T.surface, border: `1px solid ${uiHexA(T.accent, 0.25)}`, boxShadow: T.cardShadow }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
        {/* Folhinha de calendário: o dia de hoje no lugar de um ícone de relógio. */}
        <span aria-hidden="true" style={{ width: 42, height: 46, borderRadius: 12, flexShrink: 0, overflow: 'hidden', display: 'grid', gridTemplateRows: '15px 1fr', textAlign: 'center', background: T.surface, boxShadow: `inset 0 0 0 1px ${T.border}, 0 6px 14px -10px rgba(20,18,14,.35)` }}>
          <span style={{ background: T.accent, color: T.accentText, fontFamily: T.font.body, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', lineHeight: '15px', textTransform: 'uppercase' }}>{TIP.todayTile.weekday}</span>
          <span style={{ ...numFont, fontSize: 18, fontWeight: 600, lineHeight: '31px', color: T.text }}>{TIP.todayTile.day}</span>
        </span>
        <div>
          <Cap style={{ color: T.accent }}>Resumo de hoje</Cap>
          <div style={{ fontFamily: T.font.display, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', color: T.text, marginTop: 2 }}>{TIP.todayLabel || 'Sábado, 13 de junho'}</div>
        </div>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 30, flexWrap: 'wrap' }}>
        {hojeStats.map((s) => (
          <div key={s.k}>
            <Cap style={{ fontSize: 9.5, marginBottom: 6 }}>{s.k}</Cap>
            <div style={{ ...numFont, fontSize: 22, fontWeight: 600, color: s.c, letterSpacing: '-0.02em', lineHeight: 1 }}>{s.el}</div>
            {/* Sem `nowrap`: a nota é mais larga que a coluna e, presa numa
                linha, invadia o número vizinho. */}
            {s.nota && <div style={{ fontSize: 10.5, color: T.textFaint, marginTop: 6 }}>{s.nota}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
