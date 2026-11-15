import { uiDisplayColor } from "../../utils";
import { useDesign } from "../../kit/context";
import { Cap, Panel } from "../../kit/primitives";
import { porFaixa } from "../../kit/faixas";
import { ICONS, Icon } from "../../kit/icons";
import { contagem } from "../../lib/plural";
import { fmtBrl, fmtPct, fmtRate } from "@/src/domain/formato-de-resultado";
import type { aggregateTipsterMetrics } from "../../lib/tipster-metrics";

type BankrollsAgg = Pick<ReturnType<typeof aggregateTipsterMetrics>, "lucro" | "roi" | "winrate"> & {
  reg: number;
  pend: number;
  ativas: number;
};

export function BankrollsKpis({ agg }: { agg: BankrollsAgg }) {
  const { T, numFont, ink } = useDesign();
  const kpis = [
    // Conta as bancas COM APOSTAS (`t.n > 0`): a banca nova, ainda sem tip,
    // fica de fora, e o rótulo precisa dizer isso.
    { k: 'Tipsters com apostas', icon: ICONS.walletOpen, v: String(agg.ativas), c: T.text, sub: `${contagem(agg.reg, 'aposta')} no total` },
    { k: 'Lucro total', icon: ICONS.trendUp, v: fmtBrl(agg.lucro, true), c: ink(agg.lucro), sub: contagem(agg.pend, 'pendente') },
    { k: 'ROI realizado', icon: ICONS.target, v: agg.roi == null ? '—' : fmtPct(agg.roi), c: agg.roi == null ? T.textFaint : ink(agg.roi), sub: 'lucro / stake finalizada' },
    { k: 'Acerto consolidado', icon: ICONS.bars, v: fmtRate(agg.winrate), c: T.text, sub: 'vitórias ÷ decisões' },
  ];
  return (
    <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', medio: 'repeat(2,1fr)' } })}>
      {kpis.map((m) => (
        // O cartão é contêiner: o número encolhe (nunca cresce) até caber na
        // largura dele — mono avança 0,6em por caractere —, para o
        // "+25001.00u" de uma banca grande não vazar a coluna de 390px. O piso
        // de 24px mantém o número "texto grande" para o contraste da cor de
        // display (3:1); abaixo dele, quebra a linha em vez de vazar.
        <Panel key={m.k} pad={22} style={{ containerType: 'inline-size' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: T.textFaint, marginBottom: 16 }}><Icon d={m.icon} s={16} /><Cap>{m.k}</Cap></div>
          <div style={{ ...numFont, fontFamily: T.font.num, fontSize: `clamp(24px, calc(100cqi / ${(m.v.length * 0.6).toFixed(2)}), 32px)`, overflowWrap: 'anywhere', fontWeight: 600, color: uiDisplayColor(T, m.c), letterSpacing: '-0.02em', lineHeight: 1 }}>{m.v}</div>
          <div style={{ fontFamily: T.font.body, fontSize: 11.5, color: T.textFaint, marginTop: 10 }}>{m.sub}</div>
        </Panel>
      ))}
    </div>
  );
}
