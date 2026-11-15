import type { Theme } from "../../theme";
import { fmtPct, fmtRate } from "@/src/domain/formato-de-resultado";
import { useDesign } from "../../kit/context";
import { Cap } from "../../kit/primitives";
import { contagem } from "../../lib/plural";
import styles from "./tables.module.css";
import type { CssVarsStyle } from "../../kit/css-vars";
import type { LinhaAgregada } from "./use-analise-do-recorte";
import { useMoneyFormat } from "./ui-primitives";

/**
 * `aoAbrir` é opcional e, quando vem, TODA linha da tabela abre a gaveta com as
 * apostas que produziram aquela linha — a regra que o operador aprende uma vez:
 * se está numa tabela do Analyzer, abre.
 *
 * A gaveta recebe `r.membros`, o array que `agregaGrupo` agregou. Não existe
 * filtro re-derivado aqui, que é como a linha diria 12 e a gaveta abriria 11.
 *
 * Uma coluna extra de 16px carrega a seta quando a linha é clicável: sobrepor a
 * última coluna esconderia número, e a última é sempre alinhada à direita.
 */
const COLUNA_DA_SETA = "16px";

function varsDaTabela(T: Theme): CssVarsStyle {
  return {
    '--tb-border': T.borderSoft,
    '--tb-hover': T.surface2,
    '--tb-faint': T.textFaint,
    '--tb-accent': T.accent,
    '--tb-fast': T.motion.fast,
  };
}

const rotuloDeAbertura = (nome: string | number, n: number) => `Ver as ${contagem(n, 'aposta')} de ${nome}`;

export type ColunaDaTabela<R> = {
  h: string;
  a?: 'left' | 'right';
  w?: string;
  bold?: boolean;
  color?: (r: R) => string;
  fmt: (r: R) => string | number;
};

/** A linha só precisa dizer quantas apostas abre; o resto as colunas leem. */
type LinhaDaTabela = { membros?: readonly unknown[] | null; n?: number | null };

export function DataTable<R extends LinhaDaTabela>({ cols, rows, aoAbrir }: {
  cols: readonly [ColunaDaTabela<R>, ...ColunaDaTabela<R>[]];
  rows: readonly R[];
  aoAbrir?: (r: R) => void;
}) {
  const { T, numFont } = useDesign();
  const abre = typeof aoAbrir === 'function';
  const tc = [...cols.map((c) => c.w || '1fr'), ...(abre ? [COLUNA_DA_SETA] : [])].join(' ');
  // O número mais longo precisa caber na fração dele: em reais ("R$ 1.160,00")
  // o piso de 92px por coluna cortava o valor. Mono avança 7,8px por caractere
  // a 13px, com folga para o arredondamento do layout; a primeira coluna é
  // rótulo e corta com reticências.
  const maiorNumero = Math.max(0, ...rows.flatMap((r) => cols.slice(1).map((c) => String(c.fmt(r)).length))) * 7.8 + 8;
  const fracoes = cols.reduce((soma, c) => soma + (parseFloat(c.w ?? '') || 1), 0);
  const minWidth = Math.max(620, cols.length * 92, Math.ceil(fracoes * maiorNumero + 10 * cols.length + (abre ? 16 : 0)));
  const celulas = (r: R) => cols.map((c, i) => (
    <div key={i} style={{ ...numFont, fontSize: 13, textAlign: c.a || 'right', color: c.color ? c.color(r) : T.text, fontWeight: c.bold ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.fmt(r)}</div>
  ));
  const grade = { display: 'grid', gridTemplateColumns: tc, gap: 10, padding: '11px 0', alignItems: 'center' };
  return (
    <div className="no-scrollbar" role="region" aria-label="Tabela de dados" tabIndex={0} style={{ maxWidth: '100%', overflowX: 'auto', overscrollBehaviorX: 'contain', ...varsDaTabela(T) }}>
      <div style={{ minWidth }}>
      <div style={{ display: 'grid', gridTemplateColumns: tc, gap: 10, padding: '0 0 10px', borderBottom: `1px solid ${T.border}` }}>
        {cols.map((c, i) => <Cap key={i} style={{ fontSize: 9.5, textAlign: c.a || 'right' }}>{c.h}</Cap>)}
        {abre ? <span /> : null}
      </div>
      {rows.map((r, ri) => (abre ? (
        <button key={ri} type="button" className={styles.linhaAbre} style={grade}
          aria-label={rotuloDeAbertura(cols[0].fmt(r), r.membros?.length ?? r.n ?? 0)}
          onClick={() => aoAbrir(r)}>
          {celulas(r)}
          <span className={styles.seta} aria-hidden="true">›</span>
        </button>
      ) : (
        <div key={ri} style={{ ...grade, borderBottom: `1px solid ${T.borderSoft}` }}>{celulas(r)}</div>
      )))}
      </div>
    </div>
  );
}

export function PerfTable({ rows, firstHead = 'Movimento', aoAbrir }: {
  rows: readonly LinhaAgregada[];
  firstHead?: string;
  aoAbrir?: (r: LinhaAgregada) => void;
}) {
  const { T, numFont, ink } = useDesign();
  const money = useMoneyFormat();
  const abre = typeof aoAbrir === 'function';
  const tc = `1.3fr 1fr 1fr 1fr 1fr 1fr 1fr${abre ? ` ${COLUNA_DA_SETA}` : ''}`;
  const grade = { display: 'grid', gridTemplateColumns: tc, gap: 10, padding: '11px 0', alignItems: 'center' };
  const celulas = (r: LinhaAgregada) => (
    <>
      <span style={{ ...numFont, fontSize: 13, color: T.text, fontWeight: 500 }}>{r.l}</span>
      <span style={{ ...numFont, fontSize: 13, color: T.text, textAlign: 'right' }}>{r.n}</span>
      <span style={{ ...numFont, fontSize: 13, color: T.textMuted, textAlign: 'right' }}>{money.amount(r.stake)}</span>
      <span style={{ ...numFont, fontSize: 13, fontWeight: 600, color: r.lucro == null ? T.textFaint : ink(r.lucro), textAlign: 'right' }}>{r.lucro == null ? '—' : money.signed(r.lucro)}</span>
      <span style={{ ...numFont, fontSize: 13, fontWeight: 600, color: r.roi == null ? T.textFaint : ink(r.roi), textAlign: 'right' }}>{r.roi == null ? '—' : fmtPct(r.roi)}</span>
      <span style={{ ...numFont, fontSize: 13, fontWeight: 600, color: r.clv == null ? T.textFaint : ink(r.clv), textAlign: 'right' }}>{r.clv == null ? '—' : fmtPct(r.clv)}</span>
      <span style={{ ...numFont, fontSize: 13, color: r.acerto == null ? T.textFaint : T.text, textAlign: 'right' }}>{fmtRate(r.acerto)}</span>
    </>
  );
  return (
    <div className="no-scrollbar" role="region" aria-label="Tabela de desempenho" tabIndex={0} style={{ maxWidth: '100%', overflowX: 'auto', overscrollBehaviorX: 'contain', ...varsDaTabela(T) }}>
      <div style={{ minWidth: 720 }}>
      <div style={{ display: 'grid', gridTemplateColumns: tc, gap: 10, padding: '0 0 10px', borderBottom: `1px solid ${T.border}` }}>
        {[firstHead, 'Apostas', 'Stake', 'Lucro', 'ROI', 'CLV médio', 'Acerto'].map((h, i) => <Cap key={h} style={{ fontSize: 9.5, textAlign: i === 0 ? 'left' : 'right' }}>{h}</Cap>)}
        {abre ? <span /> : null}
      </div>
      {rows.map((r) => (abre ? (
        <button key={r.l} type="button" className={styles.linhaAbre} style={grade}
          aria-label={rotuloDeAbertura(r.l, r.membros?.length ?? r.n ?? 0)}
          onClick={() => aoAbrir(r)}>
          {celulas(r)}
          <span className={styles.seta} aria-hidden="true">›</span>
        </button>
      ) : (
        <div key={r.l} style={{ ...grade, borderBottom: `1px solid ${T.borderSoft}` }}>{celulas(r)}</div>
      )))}
      </div>
    </div>
  );
}
