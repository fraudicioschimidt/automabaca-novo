import type { CSSProperties } from "react";
import { uiDisplayColor } from "../../utils";
import { fmtOdds, fmtPct, fmtPp, fmtRate } from "@/src/domain/formato-de-resultado";
import { ressalvaDoComparativo, type EmCurso } from "../../lib/balde-em-curso";
import { formaDoDelta, textoDeAmostraCurta, type BaseDaComparacao } from "../../lib/comparacao-de-janelas";
import { contagem } from "../../lib/plural";
import styles from "./shared.module.css";
import { Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { Cap } from "../../kit/primitives";
import { cssVars, type CssVarsStyle } from "../../kit/css-vars";
import { AnalyzerCard, useMoneyFormat } from "./ui-primitives";
import type { AnaliseDoRecorte, LinhaAgregada } from "./use-analise-do-recorte";

/**
 * A régua do número: quanto ele mudou contra a janela anterior.
 *
 * Guardas, porque comparação é onde é mais fácil mentir:
 *  - Sem janela anterior (`range = tudo`) não renderiza nada.
 *  - Base anterior vazia vira texto: variação contra zero daria "+∞%".
 *  - Percentual varia em pontos percentuais: ROI de 2% para 4% não "subiu 100%".
 *  - A base é a DA MÉTRICA (`formaDoDelta`, piso `AMOSTRA_MINIMA_EXIBICAO`), não
 *    a contagem de apostas da janela: CLV de uma aposta só não sustenta delta.
 *  - A janela atual declara o que ainda não liquidou: janelas de mesmo tamanho
 *    não têm a mesma liquidação.
 *
 * `formato`: 'pp' para métricas que já são percentuais · 'money' para dinheiro
 * (unidades na banca, reais na carteira).
 */
export function DeltaVsAnterior({ atual, anterior, rotuloAnterior, formato = 'pp',
  base = { atual: 0, anterior: 0 }, emCursoAtual = null }: {
  atual: number | null | undefined;
  anterior: number | null | undefined;
  rotuloAnterior: string;
  formato?: 'pp' | 'money';
  base?: BaseDaComparacao;
  emCursoAtual?: EmCurso | null;
}) {
  const { T, ink } = useDesign();
  const money = useMoneyFormat();
  const forma = formaDoDelta({ rotuloAnterior, atual, anterior, base });
  if (forma === 'sem-anterior') return null;
  const apagado: CssVarsStyle = { '--dv-font': T.font.body, '--dv-cor': T.textFaint };
  if (forma === 'anterior-vazia') {
    return <div className={styles.delta} style={apagado}>sem apostas em {rotuloAnterior}</div>;
  }
  if (forma === 'sem-valor') {
    return <div className={styles.delta} style={apagado}>sem base para comparar com {rotuloAnterior}</div>;
  }
  if (forma === 'amostra-curta') {
    // Cinza e SEM número: um delta colorido é uma afirmação, e esta base não a
    // sustenta. O texto nomeia as duas contagens — "amostra curta" sozinho não
    // diz se falta 1 ou 4, nem de que lado.
    return (
      <div className={styles.delta} style={apagado}>
        {textoDeAmostraCurta(base, rotuloAnterior)}
      </div>
    );
  }
  // `formaDoDelta` só devolve 'delta' com os dois lados numéricos.
  const delta = atual! - anterior!;
  const parado = Math.abs(delta) < 0.05;
  const texto = formato === 'money' ? money.signed(delta) : fmtPp(delta);
  // Ressalva, não recusa (decisão do dono): o número ainda informa, só não pode
  // ser lido como veredito enquanto a janela atual não fechou.
  const ressalva = emCursoAtual ? ressalvaDoComparativo(emCursoAtual) : '';
  return (
    <>
      <div
        className={`${styles.delta} ${styles.deltaNumero}`}
        style={cssVars({ '--dv-font': T.font.body, '--dv-cor': parado ? T.textFaint : uiDisplayColor(T, ink(delta)) })}
      >
        {parado ? 'estável' : texto} vs {rotuloAnterior}
      </div>
      {ressalva && <div className={styles.delta} style={apagado}>{ressalva}</div>}
    </>
  );
}

/** O que o cartão de classificação lê da linha agregada (Steam, momentum de liquidez). */
export type LinhaDaClassificacao = Pick<LinhaAgregada, 'n' | 'lucro' | 'roi' | 'clv' | 'acerto' | 'membros'>;

export function ClsCard({ icon, color, title, desc, d, aoAbrir }: {
  icon: string;
  color: string;
  title: string;
  desc: string;
  d: LinhaDaClassificacao;
  aoAbrir?: (d: LinhaDaClassificacao) => void;
}) {
  const { T, numFont, ink } = useDesign();
  const money = useMoneyFormat();
  const abre = typeof aoAbrir === 'function';
  const estilo: CSSProperties = {
    background: T.surface2,
    border: `1px solid ${T.borderSoft}`,
    borderRadius: T.radiusMd,
    padding: 18,
    ...(abre ? { cursor: 'pointer', font: 'inherit', textAlign: 'inherit', color: 'inherit', width: '100%' } : {}),
  };
  const corpo = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4, color }}>
        <Icon d={icon} s={17} /><div style={{ fontFamily: T.font.display, fontSize: 15, fontWeight: 600, color: T.text }}>{title}</div></div>
      <div style={{ fontSize: 11.5, color: T.textFaint, marginBottom: 16, lineHeight: 1.45, minHeight: 32 }}>{desc}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        {[['Apostas', String(d.n), T.text], ['Lucro', money.signed(d.lucro), ink(d.lucro)], ['ROI', d.roi == null ? '—' : fmtPct(d.roi), d.roi == null ? T.textFaint : ink(d.roi)]].map(([l, v, c]) => (
          <div key={l}><Cap style={{ fontSize: 9, marginBottom: 6 }}>{l}</Cap><div style={{ ...numFont, fontSize: 18, fontWeight: 600, color: c }}>{v}</div></div>
        ))}
      </div>
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}`, fontSize: 11.5, color: T.textMuted }}>
        CLV médio <b style={{ ...numFont, color: d.clv == null ? T.textFaint : ink(d.clv) }}>{d.clv == null ? '—' : fmtPct(d.clv)}</b>
        <span style={{ color: T.textFaint }}> · </span>acerto <b style={{ ...numFont, color: T.text }}>{fmtRate(d.acerto)}</b></div>
    </>
  );
  if (aoAbrir) {
    return (
      <button type="button" onClick={() => aoAbrir(d)}
        aria-label={`Ver as ${contagem(d.n ?? d.membros?.length ?? 0, 'aposta')} de ${title}`}
        style={estilo}>
        {corpo}
      </button>
    );
  }
  return <div style={estilo}>{corpo}</div>;
}

export function Arrow({ dir }: { dir: number }) {
  const { T } = useDesign();
  return dir === 0 ? <span style={{ color: T.textFaint }}>·</span>
    : <Icon d={dir > 0 ? 'M10 5v10m0-10l-4 4m4-4l4 4' : 'M10 15V5m0 10l-4-4m4 4l4-4'} s={12} w={2} style={{ color: dir > 0 ? T.pos : T.neg, display: 'inline' }} />;
}

export function ResultCard({ icon, title, bet, color }: {
  icon: string;
  title: string;
  bet: NonNullable<AnaliseDoRecorte["D"]>["best"];
  color: string;
}) {
  const { T, numFont } = useDesign();
  const money = useMoneyFormat();
  return (
    <AnalyzerCard title={title} icon={icon}>
      {bet ? (
        <div>
          <div style={{ fontFamily: T.font.body, fontSize: 16, fontWeight: 600, color: T.text }}>{bet.home} <span style={{ color: T.textFaint, fontWeight: 400 }}>vs</span> {bet.away}</div>
          <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 4 }}>{bet.day} · Odd <span style={numFont}>{fmtOdds(bet.odds)}</span> · Stake <span style={numFont}>{money.amount(bet.stake)}</span></div>
          <div style={{ ...numFont, fontSize: 34, fontWeight: 600, color: uiDisplayColor(T, color), letterSpacing: '-0.02em', marginTop: 16 }}>{money.signed(bet.profit)}</div>
        </div>
      ) : <div style={{ fontSize: 13.5, color: T.textFaint, padding: '8px 0' }}>Sem apostas resolvidas no recorte.</div>}
    </AnalyzerCard>
  );
}

export function SegKpi({ k, icon, name, sub }: {
  k: string;
  icon: string;
  name: string | null | undefined;
  sub: string;
}) {
  const { T } = useDesign();
  return (
    <AnalyzerCard pad={20}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, color: T.textFaint }}><Icon d={icon} s={15} /><Cap>{k}</Cap></div>
      {/* Nome de canal ou de liga sem espaço não alarga o cartão no celular: quebra. */}
      <div style={{ fontFamily: T.font.display, fontSize: 22, fontWeight: 600, color: T.accent, letterSpacing: '-0.01em', overflowWrap: 'anywhere' }}>{name || '—'}</div>
      <div style={{ fontSize: 11.5, color: T.textFaint, marginTop: 7 }}>{sub}</div>
    </AnalyzerCard>
  );
}
