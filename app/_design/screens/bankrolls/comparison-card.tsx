"use client";

import { useState } from "react";
import { Panel } from "../../kit/primitives";
import { TrilhoComSinal } from "../../kit/TrilhoComSinal";
import { escalaDeBarras } from "../../lib/barra-com-sinal";
import { uiHexA } from "../../utils";
import { hasTipsterMetric } from "../../lib/tipster-metrics";
import { Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { fmtPct, fmtRate, fmtU } from "@/src/domain/formato-de-resultado";
import type { BankrollsScreenProps } from "../../screen-types";

type Tipster = BankrollsScreenProps["data"]["tipsters"][number];
type MetricKey = "lucro" | "roi" | "clv" | "acerto" | "n" | "open";

const CHEVRON_DOWN = "M5 8l5 5 5-5";
const EMPTY_BANKROLL = {
  id: "", name: "—", lucro: 0, roi: 0, clv: 0, acerto: 0,
  n: 0, open: 0, staked: 0, wins: 0, losses: 0,
  hasRoi: false, hasClv: false, hasAcerto: false,
};
const METRICS: [string, MetricKey][] = [
  ["Lucro", "lucro"], ["ROI", "roi"],
  ["CLV médio", "clv"], ["Acerto", "acerto"], ["Apostas", "n"], ["Em aberto", "open"],
];

function BankrollSelect({ tipsters, value, onChange, color, label }: {
  tipsters: Tipster[];
  value: string;
  onChange: (id: string) => void;
  color: string;
  label: string;
}) {
  const { T } = useDesign();
  return (
    <div style={{ position: "relative", flex: 1 }}>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} style={{ width: "100%", appearance: "none", cursor: "pointer", fontFamily: T.font.body, fontSize: 14.5, fontWeight: 600, color: T.text, background: T.surface2, border: `1px solid ${T.border}`, borderLeft: `3px solid ${color}`, borderRadius: T.radiusSm, padding: "11px 32px 11px 13px", outline: "none" }}>
        {tipsters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: T.textFaint }}><Icon d={CHEVRON_DOWN} s={14} /></span>
    </div>
  );
}

const LARGURA_DO_TRILHO = { largo: 80, medio: 42 };

export function BankrollComparison({ tipsters }: { tipsters: Tipster[] }) {
  const { T, numFont, ink } = useDesign();
  const [firstId, setFirstId] = useState("t1");
  const [secondId, setSecondId] = useState("t5");
  const first = tipsters.find((item) => item.id === firstId) || tipsters[0] || EMPTY_BANKROLL;
  const second = tipsters.find((item) => item.id === secondId) || tipsters[1] || EMPTY_BANKROLL;
  const formatMetric = (key: MetricKey, value: number, available = true) => {
    if (!available) return "—";
    if (key === "lucro") return fmtU(value);
    if (["roi", "clv"].includes(key)) return fmtPct(value);
    if (key === "acerto") return fmtRate(value);
    return String(value);
  };

  return (
    <Panel style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
        <h3 style={{ margin: 0, fontFamily: T.font.display, fontSize: 19, fontWeight: 600, color: T.text, letterSpacing: "-0.01em" }}>Comparar tipsters</h3>
        <span style={{ marginLeft: "auto", fontFamily: T.font.body, fontSize: 12, color: T.textFaint }}>lado a lado</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <BankrollSelect tipsters={tipsters} label="Primeiro tipster da comparação" value={first.id} onChange={setFirstId} color={T.accent} />
        <span style={{ fontFamily: T.font.body, fontSize: 12, fontWeight: 600, color: T.textFaint }}>vs</span>
        <BankrollSelect tipsters={tipsters} label="Segundo tipster da comparação" value={second.id} onChange={setSecondId} color={T.chartClv} />
      </div>
      <div>
        {METRICS.map(([label, key], index) => {
          const firstValue = first[key], secondValue = second[key];
          const firstHas = hasTipsterMetric(first, key), secondHas = hasTipsterMetric(second, key);
          const firstWins = firstHas && (!secondHas || firstValue > secondValue);
          const secondWins = secondHas && (!firstHas || secondValue > firstValue);
          // Uma escala por linha, compartilhada pelos dois lados, lidos da
          // esquerda para a direita a partir do mesmo zero. Barra espelhada
          // (com `Math.abs`) só serve a grandeza sem sinal: com Lucro, ROI e CLV
          // ela desenhava o perdedor maior que o vencedor.
          const escala = escalaDeBarras([firstHas ? firstValue : null, secondHas ? secondValue : null]);
          return (
            <div key={key} {...porFaixa({ display: "grid", alignItems: "center", padding: "11px 0", borderTop: index ? `1px solid ${T.borderSoft}` : "none" }, { gridTemplateColumns: { largo: "1fr 92px 1fr", medio: "1fr 68px 1fr" }, gap: { largo: 14, medio: 6 } })}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
                <span style={{ ...numFont, fontSize: 14.5, fontWeight: 700, color: firstHas ? (firstWins ? ink(firstValue, T.text) : T.textMuted) : T.textFaint }}>{formatMetric(key, firstValue, firstHas)}</span>
                <div {...porFaixa({ display: "flex", flexShrink: 0 }, { width: LARGURA_DO_TRILHO })}><TrilhoComSinal geom={escala.barras[0]!} centrada={escala.centrada} reguaPct={null} altura={7} cor={firstWins ? (T.brandAccent || T.accent) : uiHexA(T.brandAccent || T.accent, 0.4)} /></div>
              </div>
              <div style={{ textAlign: "center", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: T.textFaint }}>{label}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div {...porFaixa({ display: "flex", flexShrink: 0 }, { width: LARGURA_DO_TRILHO })}><TrilhoComSinal geom={escala.barras[1]!} centrada={escala.centrada} reguaPct={null} altura={7} cor={secondWins ? (T.chartClvDisplay || T.chartClv) : uiHexA(T.chartClvDisplay || T.chartClv, 0.4)} /></div>
                <span style={{ ...numFont, fontSize: 14.5, fontWeight: 700, color: secondHas ? (secondWins ? ink(secondValue, T.text) : T.textMuted) : T.textFaint }}>{formatMetric(key, secondValue, secondHas)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
