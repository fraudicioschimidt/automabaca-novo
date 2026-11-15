import type { CSSProperties } from "react";
import { AMOSTRA_MINIMA_CLV, AMOSTRA_MINIMA_EXIBICAO as PISO, tCritico95 } from "@/src/domain/analyzer/shared";
import { fmtPct } from "@/src/domain/formato-de-resultado";
import { uiHexA } from "../../utils";
import { useDesign } from "../../kit/context";
import { Cap } from "../../kit/primitives";
import { porFaixa } from "../../kit/faixas";
import { cssVars } from "../../kit/css-vars";
import { contagem, plural } from "../../lib/plural";
import { recorteDaLinha } from "../../lib/recorte-de-apostas";
import { DataTable } from "./tables";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import styles from "./portfolio-cards.module.css";
import type { DadosDaCarteira, PropsDaAba } from "./use-analise-do-recorte";

/**
 * Os cartões da carteira na dimensão Canal: o que cortar e a matriz canal ×
 * mercado. Cada célula e cada corte são o mesmo objeto agregado
 * (`domain/analyzer/portfolio`), e a gaveta abre as apostas dele.
 */

type Celula = DadosDaCarteira["cuts"][number];
type Props = { carteira: DadosDaCarteira; abrirRecorte: PropsDaAba["abrirRecorte"] };

/** Nome de mercado longo quebra em até duas linhas em vez de alargar a coluna. */
const NOME_DE_MERCADO: CSSProperties = {
  fontSize: 9.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
};
const T_CRITICO_NO_MINIMO = tCritico95(AMOSTRA_MINIMA_CLV - 1).toFixed(2);
const fmtT = (t: number | null) => (t == null ? "—" : t.toFixed(1));

export function SuggestedCutsCard({ carteira, abrirRecorte }: Props) {
  const { T, numFont, ink } = useDesign();
  const money = useMoneyFormat();
  const { cuts, portfolio, withoutCuts, cut, testedPairs, totalPairs } = carteira;
  const abrir = (c: Celula) => abrirRecorte(recorteDaLinha(c, {
    money, rotulo: c.l, contexto: `Corte sugerido · ${contagem(c.membros.length, "aposta")}`,
  }));
  const partDaStake = portfolio.stake > 0 ? Math.round((cut.stake / portfolio.stake) * 100) : null;
  const impacto: Array<[rotulo: string, valor: string, cor: string, apoio: string]> = [
    ["CLV da carteira sem eles", fmtPct(withoutCuts.clv), withoutCuts.clv == null ? T.textFaint : ink(withoutCuts.clv),
      `hoje ${fmtPct(portfolio.clv)} · ${portfolio.clvN} → ${withoutCuts.clvN} fechamentos`],
    ["Resultado dos cortes", money.signed(cut.lucro), ink(cut.lucro),
      `${contagem(cut.settledN, "resolvida")} · ROI ${fmtPct(cut.roi)}`],
    ["Lucro da carteira sem eles", money.signed(withoutCuts.lucro), ink(withoutCuts.lucro),
      `hoje ${money.signed(portfolio.lucro)}`],
    ["Stake nos cortes", money.amount(cut.stake), T.text,
      partDaStake == null ? "sem stake liquidada" : `${partDaStake}% da stake liquidada`],
  ];
  return (
    <AnalyzerCard title="Cortes sugeridos" style={{ marginBottom: 22 }}
      sub={`Canal × mercado com ${AMOSTRA_MINIMA_CLV}+ fechamentos confiáveis e CLV médio abaixo de zero pelo critério individual (teste t a 95%; com ${AMOSTRA_MINIMA_CLV} fechamentos, t ≤ −${T_CRITICO_NO_MINIMO}). O ROI é contexto, não critério: nessa amostra ainda é ruído.`}>
      <p style={{ fontSize: 11.5, color: T.textMuted, lineHeight: 1.5 }}>
        O teste pressupõe observações independentes: apostas do mesmo jogo podem ser correlacionadas.
        Critérios individuais, sem ajuste para múltiplas comparações. CLVs constantes usam o sinal, sem teste t calculável.
      </p>
      {cuts.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: T.textMuted, lineHeight: 1.5 }}>
          Nenhum corte no recorte pelo critério individual.{" "}
          <span style={numFont}>{testedPairs}</span> de <span style={numFont}>{totalPairs}</span>{" "}
          {plural(totalPairs, "combinação", "combinações")} já {plural(testedPairs, "tem", "têm")} amostra para o teste.
        </p>
      ) : (
        <>
          <p role="note" style={{ margin: '0 0 16px', fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>
            Comparação retrospectiva: os cortes são escolhidos e avaliados no mesmo recorte.
            {' '}O lucro sem eles recalcula o passado e pode melhorar pela própria seleção.
            {' '}A base exclui apostas removidas e tipsters excluídos.
          </p>
          <div {...porFaixa({ display: "grid", gap: 16, marginBottom: 18 }, { gridTemplateColumns: { largo: "repeat(4, minmax(0, 1fr))", compacto: "repeat(2, minmax(0, 1fr))" } })}>
            {impacto.map(([rotulo, valor, cor, apoio]) => (
              <div key={rotulo} style={{ minWidth: 0 }}>
                <Cap style={{ fontSize: 9.5, marginBottom: 8 }}>{rotulo}</Cap>
                <div style={{ ...numFont, fontSize: 20, fontWeight: 600, color: cor, letterSpacing: "-0.02em", overflowWrap: "anywhere" }}>{valor}</div>
                <div style={{ fontSize: 11, color: T.textFaint, marginTop: 6, lineHeight: 1.4 }}>{apoio}</div>
              </div>
            ))}
          </div>
          <DataTable rows={cuts} aoAbrir={abrir} cols={[
            { h: "Canal · mercado", a: "left", w: "2.4fr", bold: true, fmt: (r) => r.l },
            { h: "Fechamentos", fmt: (r) => r.clvN },
            { h: "CLV médio", bold: true, color: (r) => (r.clv == null ? T.textFaint : ink(r.clv)), fmt: (r) => fmtPct(r.clv) },
            { h: "t", color: () => T.textMuted, fmt: (r) => fmtT(r.tStat) },
            { h: "Apostas", fmt: (r) => r.n },
            { h: "Lucro", color: (r) => ink(r.lucro), fmt: (r) => money.signed(r.lucro) },
            { h: "ROI", color: () => T.textMuted, fmt: (r) => fmtPct(r.roi) },
          ]} />
        </>
      )}
    </AnalyzerCard>
  );
}

export function ChannelMarketCard({ carteira, abrirRecorte }: Props) {
  const { T, numFont } = useDesign();
  const money = useMoneyFormat();
  const cortes = new Set(carteira.cuts.map((c) => JSON.stringify([c.channel, c.market])));
  const fundo = (c: Celula) => {
    if (c.clv == null || c.clvN < PISO) return T.surface2;
    const forca = Math.min(1, Math.abs(c.clv) / 5);
    return c.clv < 0 ? uiHexA(T.negDisplay || T.neg, 0.12 + 0.4 * forca) : uiHexA(T.posDisplay || T.pos, 0.1 + 0.4 * forca);
  };
  const abrir = (c: Celula) => abrirRecorte(recorteDaLinha(c, {
    money, rotulo: c.l, contexto: `Canal × mercado · ${contagem(c.membros.length, "aposta")}`,
  }));
  if (!carteira.rows.length) return null;
  return (
    <AnalyzerCard title="Canal × mercado" style={{ marginBottom: 22 }}
      sub={`CLV médio de cada combinação e, abaixo, quantos fechamentos confiáveis o sustentam (n). Com menos de ${PISO}, a célula fica cinza.${carteira.otherMarketsLabel ? ` Os mercados menos apostados se juntam em "${carteira.otherMarketsLabel}".` : ""}`}>
      <div className={`${styles.rolagem} no-scrollbar`} role="region" aria-label="Matriz canal × mercado" tabIndex={0}
        style={cssVars({
          "--cm-colunas": carteira.markets.length,
          "--cm-superficie": T.surface,
          "--cm-borda": T.borderSoft,
          "--cm-texto": T.text,
          "--cm-apagado": T.textMuted,
          "--cm-fraco": T.textFaint,
          "--cm-corte": T.neg,
          "--cm-foco": T.accent,
        })}>
        <div className={styles.grade}>
          <div className={`${styles.fixa} ${styles.cabecalho}`}><Cap style={{ fontSize: 9.5 }}>Canal</Cap></div>
          {carteira.markets.map((m) => (
            <div key={m} className={styles.cabecalho} title={m}><Cap style={NOME_DE_MERCADO}>{m}</Cap></div>
          ))}
          {carteira.rows.map((row) => (
            <div key={row.channel} className={styles.linha}>
              <div className={styles.fixa}>
                <div className={styles.canal} title={row.channel}>{row.channel}</div>
                <div className={styles.total} style={numFont}>
                  {fmtPct(row.total.clv)} · n {row.total.clvN}
                </div>
              </div>
              {row.cells.map((c, i) => {
                if (!c) return <div key={carteira.markets[i]} className={styles.vazia} aria-hidden="true" />;
                const corte = cortes.has(JSON.stringify([c.channel, c.market]));
                return (
                  <button key={c.market} type="button" onClick={() => abrir(c)}
                    className={`${styles.celula} ${corte ? styles.corte : ""}`} style={{ background: fundo(c) }}
                    aria-label={`Ver as ${contagem(c.membros.length, "aposta")} de ${c.l}: CLV médio ${fmtPct(c.clv)} em ${contagem(c.clvN, "fechamento")}, lucro ${money.signed(c.lucro)}${corte ? ", corte sugerido" : ""}`}>
                    <span className={styles.clv} style={numFont}>{fmtPct(c.clv)}</span>
                    <span className={styles.n} style={numFont}>n {c.clvN}{corte ? " · corte" : ""}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </AnalyzerCard>
  );
}
