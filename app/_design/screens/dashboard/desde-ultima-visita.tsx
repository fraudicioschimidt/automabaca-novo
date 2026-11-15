import { useDesign } from "../../kit/context";
import { Cap } from "../../kit/primitives";
import { contagem } from "../../lib/plural";
import { fmtBrl, fmtPct } from "@/src/domain/formato-de-resultado";
import type { DashboardScreenProps } from "../../screen-types";

type Since = NonNullable<DashboardScreenProps["data"]["visit"]["since"]>;

/** Nada mudou: não há o que resumir, e o cartão não aparece. */
export function nothingChanged(s: Since): boolean {
  return s.newBets === 0 && s.settled === 0 && s.closings === 0 && s.openAlerts === 0;
}

/**
 * O que mudou desde a última visita do operador. Sem visita anterior ou sem
 * mudança, nada aparece.
 */
export function DesdeUltimaVisita({ since }: { since: Since | null }) {
  const { T, numFont, ink } = useDesign();
  if (!since || nothingChanged(since)) return null;
  const itens = [
    { k: contagem(since.newBets, 'aposta nova', 'apostas novas'), detalhe: null, cor: T.text },
    {
      k: contagem(since.settled, 'liquidada', 'liquidadas'),
      detalhe: since.settled > 0 ? fmtBrl(since.lucroReais, true) : null,
      cor: ink(since.lucroReais),
    },
    {
      k: contagem(since.closings, 'fechamento com CLV', 'fechamentos com CLV'),
      detalhe: since.clvMean != null ? `média ${fmtPct(since.clvMean)}` : null,
      cor: since.clvMean == null ? T.textFaint : ink(since.clvMean),
    },
    {
      k: contagem(since.openAlerts, 'alerta aberto', 'alertas abertos'),
      detalhe: since.openAlerts > 0 ? 'ver em Monitoramento' : null,
      cor: since.openAlerts > 0 ? T.neg : T.text,
    },
  ];
  return (
    <section aria-label="Desde a sua última visita" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18, rowGap: 14,
      padding: '16px 24px', marginBottom: 22, borderRadius: T.radius, background: T.surface, border: `1px solid ${T.border}`, boxShadow: T.cardShadow }}>
      <div>
        <Cap style={{ color: T.accent }}>Desde a sua última visita</Cap>
        <div style={{ ...numFont, fontSize: 13, color: T.textMuted, marginTop: 3 }}>{since.sinceLabel}</div>
      </div>
      <ul style={{ marginLeft: 'auto', display: 'flex', gap: 26, rowGap: 10, flexWrap: 'wrap', listStyle: 'none', padding: 0, margin: 0 }}>
        {itens.map((item) => (
          <li key={item.k} style={{ fontFamily: T.font.body, fontSize: 13.5, color: T.text }}>
            <b style={{ fontWeight: 600 }}>{item.k}</b>
            {item.detalhe ? <div style={{ ...numFont, fontSize: 12, color: item.cor, marginTop: 3 }}>{item.detalhe}</div> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
