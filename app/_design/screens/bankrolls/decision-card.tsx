import { uiHexA } from "../../utils";
import { BankrollLogo, Cap, DataGrid, Panel, SharpModeTag } from "../../kit/primitives";
import { useDesign } from "../../kit/context";
import { SEM_COMPACTO, SO_COMPACTO } from "../../kit/faixas";
import { fmtPct, fmtPp } from "@/src/domain/formato-de-resultado";
import {
  comparaDecisao,
  rankingDaDecisaoNaTela,
} from "@/src/domain/analyzer/decisao";
import type { BankrollsScreenProps } from "../../screen-types";
import type { Theme } from "../../theme";
import { VEREDITO_ROTULO, type VEREDITO_NA_TELA } from "@/src/domain/analyzer/shared";

/** O que o cartão lê de cada banca. */
type DecisionTipster = Pick<BankrollsScreenProps["data"]["tipsters"][number], "id" | "name" | "sharpMode" | "logoUrl" | "dec">;

function MiniDistribution({ tipster }: { tipster: DecisionTipster }) {
  const { T } = useDesign();
  const bins = tipster.dec.distClv ?? [];
  const maxCount = Math.max(0, ...bins.map((bin) => bin.count));
  if (maxCount === 0) return <span style={{ color: T.textFaint }}>—</span>;
  const summary = bins.map((bin) => `${bin.label}: ${bin.count}`).join(", ");
  return (
    <div role="img" aria-label={`Distribuição de CLV: ${summary}`} style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 22 }}>
      {bins.map((bin, index) => {
        const color = index < 2 ? (T.negDisplay || T.neg) : (T.posDisplay || T.pos);
        return (
          <span
            key={bin.label}
            title={`${bin.label}: ${bin.count}`}
            style={{
              width: 7,
              height: `${Math.max(15, (bin.count / maxCount) * 100)}%`,
              borderRadius: 2,
              background: bin.count === maxCount ? color : uiHexA(color, 0.3),
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * ROI real COM o tamanho da amostra que o sustenta: as liquidadas, base
 * diferente da amostra de CLV. Sem o `n` ao lado, um ROI de uma aposta ganha
 * parecia sinal forte.
 */
function RoiPar({ decision, fontSize }: { decision: DecisionTipster["dec"]; fontSize: number }) {
  const { T, numFont, ink } = useDesign();
  if (decision.roiReal == null) return <span style={{ ...numFont, fontSize, color: T.textFaint }}>—</span>;
  const n = decision.nRoi ?? 0;
  return (
    <span style={{ ...numFont, fontSize, color: T.textMuted }}>
      <b style={{ color: ink(decision.roiReal) }}>{fmtPct(decision.roiReal)}</b>{" "}
      <span style={{ color: T.textFaint }} title="Apostas liquidadas — base do ROI, diferente da amostra de CLV">
        (n={n})
      </span>
    </span>
  );
}

type ScreenVerdict = (typeof VEREDITO_NA_TELA)[keyof typeof VEREDITO_NA_TELA];

/** Rótulo, cor e fundo do veredito de assinatura. */
function verdictMeta(T: Theme): Record<ScreenVerdict, [label: string, color: string, background: string]> {
  return {
    forte: [VEREDITO_ROTULO.EDGE, T.pos, T.posSoft],
    monitorar: [VEREDITO_ROTULO.INCONCLUSIVO, T.accent, T.accentSoft],
    pausar: [VEREDITO_ROTULO.SEM_EDGE, T.neg, T.negSoft],
    "amostra curta": [VEREDITO_ROTULO.AMOSTRA_CURTA, T.textMuted, T.surface2],
  };
}

export function BankrollsDecisionCard({ tipsters }: { tipsters: DecisionTipster[] }) {
  const { T, numFont, ink } = useDesign();
  const verdicts = verdictMeta(T);
  const sorted = tipsters.slice().sort((left, right) =>
    comparaDecisao(rankingDaDecisaoNaTela(left.dec), rankingDaDecisaoNaTela(right.dec)),
  );
  const columns = "1.8fr 92px 96px 100px 92px 1.1fr 130px";

  return (
    <Panel pad={0} style={{ overflow: "hidden" }}>
      <div style={{ padding: "20px 24px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, fontFamily: T.font.display, fontSize: 19, fontWeight: 600, color: T.text, letterSpacing: "-0.01em" }}>Decisão de assinatura</h3>
          <div style={{ fontSize: 12.5, color: T.textFaint, marginTop: 4 }}>Vale a pena seguir cada canal? Veredito pela evidência de edge.</div>
        </div>
        <span style={{ marginLeft: "auto", fontFamily: T.font.body, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: T.textFaint }}>ordenado por evidência de edge</span>
      </div>
      <div className={SO_COMPACTO} style={{ borderTop: `1px solid ${T.borderSoft}` }}>
          {sorted.map((tipster, index) => {
            const decision = tipster.dec;
            const [verdict, verdictColor, verdictBackground] = verdicts[decision.verdict];
            return (
              <div key={tipster.id} style={{ padding: "17px 18px", borderBottom: index < sorted.length - 1 ? `1px solid ${T.borderSoft}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <BankrollLogo name={tipster.name} logoUrl={tipster.logoUrl} toneKey={tipster.id} s={36} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: T.font.body, fontSize: 14, fontWeight: 600, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tipster.name}</div>
                    <SharpModeTag mode={tipster.sharpMode} style={{ fontSize: 11.5, marginTop: 3 }} />
                  </div>
                  <span style={{ fontFamily: T.font.body, fontSize: 11, fontWeight: 700, color: verdictColor, background: verdictBackground, padding: "5px 9px", borderRadius: T.pill, whiteSpace: "nowrap" }}>{verdict}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 8, marginTop: 15, paddingTop: 13, borderTop: `1px solid ${T.borderSoft}` }}>
                  {([
                    ["Amostra", String(decision.amostra), T.text],
                    ["Beat-close", decision.beat == null ? "—" : `${decision.beat}%`, decision.beat == null ? T.textFaint : decision.beat >= 55 ? T.pos : T.textMuted],
                    ["CLV médio", decision.clv == null ? "—" : fmtPct(decision.clv), decision.clv == null ? T.textFaint : ink(decision.clv)],
                    ["Δ 30d", decision.d30 == null ? "—" : fmtPp(decision.d30), decision.d30 == null ? T.textFaint : ink(decision.d30), decision.d30Note],
                  ] satisfies Array<[string, string, string, (string | null)?]>).map(([label, value, color, nota]) => (
                    <div key={label} title={nota ?? undefined} style={{ minWidth: 0 }}>
                      <Cap style={{ fontSize: 8, marginBottom: 5 }}>{label}</Cap>
                      <div style={{ ...numFont, fontSize: 12, fontWeight: 600, color }}>{value}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 13, fontSize: 11.5, color: T.textMuted }}>
                  <MiniDistribution tipster={tipster} />
                  <span>ROI real:</span>
                  <RoiPar decision={decision} fontSize={11.5} />
                  {decision.faltam > 0 && <span style={{ marginLeft: "auto", color: T.textFaint }}>faltam {decision.faltam} CLVs</span>}
                </div>
              </div>
            );
          })}
      </div>
      <div className={`no-scrollbar ${SEM_COMPACTO}`} style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 780 }}>
            <DataGrid columns={columns} style={{ gap: 12, padding: "11px 24px", borderTop: `1px solid ${T.borderSoft}`, borderBottom: `1px solid ${T.border}`, background: "transparent" }}>
              {([["Canal", "left"], ["Amostra", "right"], ["Beat-close", "right"], ["CLV médio", "right"], ["Δ 30d", "right"], ["ROI real", "left"], ["Veredito", "right"]] satisfies [string, "left" | "right"][]).map(([column, align], index) => <Cap key={index} style={{ fontSize: 9.5, textAlign: align }}>{column}</Cap>)}
            </DataGrid>
            {sorted.map((tipster, index) => {
              const decision = tipster.dec;
              const [verdict, verdictColor, verdictBackground] = verdicts[decision.verdict];
              return (
                <DataGrid key={tipster.id} columns={columns} style={{ gap: 12, padding: "14px 24px", borderBottom: index < sorted.length - 1 ? `1px solid ${T.borderSoft}` : "none", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
                    <BankrollLogo name={tipster.name} logoUrl={tipster.logoUrl} toneKey={tipster.id} s={32} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: T.font.body, fontSize: 14, fontWeight: 600, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tipster.name}</div>
                      <SharpModeTag mode={tipster.sharpMode} style={{ fontSize: 11.5, marginTop: 2 }} />
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}><span style={{ ...numFont, fontSize: 13.5, fontWeight: 600, color: T.text }}>{decision.amostra}</span><div style={{ fontSize: 10, color: T.textFaint, marginTop: 1 }}>CLVs</div></div>
                  <span style={{ ...numFont, fontSize: 13.5, fontWeight: 600, color: decision.beat == null ? T.textFaint : decision.beat >= 55 ? T.pos : T.textMuted, textAlign: "right" }}>{decision.beat == null ? "—" : `${decision.beat}%`}</span>
                  <span style={{ ...numFont, fontSize: 13.5, fontWeight: 600, color: decision.clv == null ? T.textFaint : ink(decision.clv), textAlign: "right" }}>{decision.clv == null ? "—" : fmtPct(decision.clv)}</span>
                  <span title={decision.d30Note ?? undefined} style={{ ...numFont, fontSize: 13, fontWeight: 600, color: decision.d30 == null ? T.textFaint : ink(decision.d30), textAlign: "right" }}>{decision.d30 == null ? "—" : fmtPp(decision.d30)}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <MiniDistribution tipster={tipster} />
                    <RoiPar decision={decision} fontSize={12.5} />
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontFamily: T.font.body, fontSize: 11.5, fontWeight: 700, color: verdictColor, background: verdictBackground, padding: "4px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>{verdict}</span>
                    {decision.faltam > 0 && <div style={{ fontSize: 10, color: T.textFaint, marginTop: 4 }}>faltam {decision.faltam} CLVs</div>}
                  </div>
                </DataGrid>
              );
            })}
          </div>
        </div>
      <div style={{ padding: "14px 24px", borderTop: `1px solid ${T.borderSoft}`, fontSize: 11.5, color: T.textFaint, lineHeight: 1.5 }}>
        Veredito por teste individual do CLV médio (95% · amostra mínima 30 CLVs), que pressupõe observações independentes.
        Apostas do mesmo jogo podem ser correlacionadas; sem ajuste para múltiplas comparações.
        CLVs constantes usam o sinal, sem teste t calculável. Beat-close = % de apostas que fecharam melhor que a linha. O ROI sai das liquidadas (n ao lado), base diferente da amostra de CLV. Δ 30d = CLV dos jogos dos últimos 30 dias menos o dos 30 dias anteriores (variação descritiva, sem teste de mudança).
      </div>
    </Panel>
  );
}
