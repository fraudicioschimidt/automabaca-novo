import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { HISTORY_COLS, HISTORY_GRID_COLUMNS, HISTORY_TABS, type HistorySortKey } from "./constants";
import { MONTH_NAMES, WEEKDAY_NAMES } from "@/src/domain/dates";
import { BetRow } from "./bet-detail";
import { Label } from "./ui-primitives";
import { contagem, plural } from "../../lib/plural";
import { sumMoneyBy } from "@/src/domain/money";
import { ICONS, Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { porFaixa, SEM_COMPACTO } from "../../kit/faixas";
import { fmtU } from "@/src/domain/formato-de-resultado";
import type { DayGroup } from "../../lib/bankroll-runtime";
import type { selectBankrollHistory } from "../../lib/bankroll-filters";
import type { BankrollBet, BankrollView, RemovedBet, ResultMenuState } from "./types";
import type { BatchRemovalState } from "./use-batch-removal";
import { RemovedBets } from "./removed-bets";

const HISTORY_RENDER_BATCH = 50;
/** Botão de texto: alvo de toque de 44px no compacto. */
const ALVO_DE_TOQUE = { largo: 24, compacto: 44 };

type HistoryCounts = ReturnType<typeof selectBankrollHistory>["counts"];
type MonthGroup = {
  key: string;
  label: string;
  days: DayGroup<BankrollBet>[];
  count: number;
  profits: number[];
  settled: number;
};

/**
 * Ordenar é um modo de visão: a lista nasce agrupada por mês e dia, e
 * ordenar por uma coluna atravessa esse agrupamento ("as piores do mês" não
 * existe dentro de um dia). Com ordenação ativa a lista vira plana, e um
 * botão devolve o agrupamento.
 */
function ordenar(bets: readonly BankrollBet[], chave: HistorySortKey, desc: boolean) {
  const valor = (b: BankrollBet) => {
    if (chave === "profit") return b.profit;
    if (chave === "movimento") return b.movimento;
    if (chave === "clv") return b.clv;
    if (chave === "stake") return b.stake;
    return b.odds;
  };
  return bets.slice().sort((a, bb) => {
    const va = valor(a);
    const vb = valor(bb);
    // Ausente vai SEMPRE para o fim, nos dois sentidos: pendente sem lucro no
    // topo de "piores" seria mentira.
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return desc ? vb - va : va - vb;
  });
}

function matchesSearch(bet: RemovedBet, search: string) {
  return !search || [bet.home, bet.away, bet.market, bet.line].join(' ').toLowerCase().includes(search);
}

/**
 * As liquidadas há mais de 7 dias que ficaram fora do último lote: o aviso
 * fica até o operador fechar, porque cada uma pede revisão em Monitoramento.
 */
function LeftOutNotice({ bets, onClose }: { bets: BatchRemovalState["leftOut"]; onClose: () => void }) {
  const { T } = useDesign();
  const n = bets.length;
  return (
    <div role="status" aria-label="Apostas que ficaram de fora" style={{ display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '11px 14px', marginBottom: 16, borderRadius: T.radiusMd, background: T.surface2, border: `1px solid ${T.border}`,
      fontFamily: T.font.body, fontSize: 13, lineHeight: 1.55, color: T.text }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{contagem(n, 'aposta')} {plural(n, 'ficou', 'ficaram')} de fora</b>: liquidada{n === 1 ? '' : 's'} há mais de 7 dias, como no 👎,{' '}
        {plural(n, 'virou', 'viraram')} revisão em <Link href="/monitoramento" style={{ color: T.accent, fontWeight: 600 }}>Monitoramento</Link>.
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {bets.map((bet) => <li key={bet.id}>{bet.evento} — {bet.selecao}</li>)}
        </ul>
      </div>
      <button type="button" aria-label="Fechar aviso" onClick={onClose} {...porFaixa({ flexShrink: 0, display: 'grid', placeItems: 'center',
        borderRadius: T.radiusSm, border: 'none', background: 'transparent', color: T.textMuted, cursor: 'pointer' },
        { width: { largo: 32, compacto: 44 }, height: { largo: 32, compacto: 44 } })}>
        <Icon d={ICONS.close} s={16} />
      </button>
    </div>
  );
}

function prettyDay(ymd: string) {
  const p = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(p[0]!, p[1]! - 1, p[2]!));
  return { wd: WEEKDAY_NAMES[dt.getUTCDay()], date: String(p[2]).padStart(2, '0') + '/' + String(p[1]).padStart(2, '0') };
}

export function BetHistory({
  AB,
  q, setQ, tab, setTab, counts, filtered, groups, filterKey = "",
  open, setOpen, setResultMenu, settling, copyVisible,
  openMonths, setOpenMonths, canManage = true, removal = null,
}: {
  AB: BankrollView;
  q: string;
  setQ: Dispatch<SetStateAction<string>>;
  tab: string;
  setTab: Dispatch<SetStateAction<string>>;
  counts: HistoryCounts;
  filtered: BankrollBet[];
  groups: DayGroup<BankrollBet>[];
  filterKey?: string;
  open: Record<string, boolean>;
  setOpen: Dispatch<SetStateAction<Record<string, boolean>>>;
  setResultMenu: Dispatch<SetStateAction<ResultMenuState | null>>;
  settling: string | null;
  copyVisible: () => void;
  openMonths: Set<string> | null;
  setOpenMonths: Dispatch<SetStateAction<Set<string> | null>>;
  canManage?: boolean;
  /** Remoção em lote; ausente no mock e sem sessão. */
  removal?: BatchRemovalState | null;
}) {
  const { T, numFont, ink } = useDesign();
  const monthGroups = useMemo(() => {
    const m: Record<string, MonthGroup> = {};
    groups.forEach((g) => {
      const key = g.day.slice(0, 7);
      if (!m[key]) m[key] = { key, label: MONTH_NAMES[+g.day.slice(5, 7) - 1] + ' ' + g.day.slice(0, 4), days: [], count: 0, profits: [], settled: 0 };
      m[key]!.days.push(g);
      g.bets.forEach((b) => { m[key]!.count++; if (b.profit != null) { m[key]!.profits.push(b.profit); m[key]!.settled++; } });
    });
    return Object.values(m).map((entry) => ({ ...entry, profit: sumMoneyBy(entry.profits, (v) => v) })).sort((a, b) => a.key < b.key ? 1 : -1);
  }, [groups]);
  // `null` = agrupado por mês/dia (padrão). Com chave, a lista vira plana.
  const [ordem, setOrdem] = useState<{ chave: HistorySortKey; desc: boolean } | null>(null);
  const alternarOrdem = (chave: HistorySortKey) => setOrdem((atual) => {
    if (!atual || atual.chave !== chave) return { chave, desc: true }; // maior primeiro
    if (atual.desc) return { chave, desc: false };
    return null; // terceiro clique devolve o agrupamento
  });
  const ordenadas = useMemo(() => ordem ? ordenar(filtered, ordem.chave, ordem.desc) : null, [filtered, ordem]);
  const renderContext = JSON.stringify([q, tab, filterKey]);
  const [windows, setWindows] = useState<{ context: string; limits: Record<string, number> }>({ context: renderContext, limits: {} });
  const limitOf = (key: string) => windows.context === renderContext ? windows.limits[key] ?? HISTORY_RENDER_BATCH : HISTORY_RENDER_BATCH;
  const showMore = (key: string) => setWindows((current) => {
    const limits = current.context === renderContext ? current.limits : {};
    return { context: renderContext, limits: { ...limits, [key]: (limits[key] ?? HISTORY_RENDER_BATCH) + HISTORY_RENDER_BATCH } };
  });
  const sortWindow = `sort:${ordem?.chave}:${ordem?.desc}`;
  const moreRows = (key: string, total: number) => total > limitOf(key) ? (
    <div style={{ padding: '14px var(--bk-pad)', textAlign: 'center', fontFamily: T.font.body, color: T.textMuted, fontSize: 12.5 }}>
      <span>{limitOf(key)} de {contagem(total, 'aposta')} exibidas · </span>
      <button type="button" onClick={() => showMore(key)} style={{ minHeight: 44, padding: '8px 12px', cursor: 'pointer',
        border: `1px solid ${T.border}`, borderRadius: T.radiusSm, background: T.surface2, color: T.accent, font: 'inherit' }}>
        Mostrar mais apostas
      </button>
    </div>
  ) : null;

  // "Removidas" troca a lista: as que saíram da banca, sem seleção, ordenação nem cópia.
  const removedTab = tab === 'removidas';
  const removing = canManage && removal?.available && !removedTab ? removal : null;
  const selectionOf = (b: BankrollBet) => removing?.selecting && removing.canSelect(b)
    ? { on: removing.selected.has(b.id), toggle: () => removing.toggle(b.id) }
    : null;
  const restored = removal?.restoredIds ?? new Set<string>();
  const removedShown = (AB.removed?.bets ?? []).filter((b) => !restored.has(b.id));
  const removedTotal = Math.max(0, (AB.removed?.total ?? 0) - ((AB.removed?.bets.length ?? 0) - removedShown.length));
  const search = q.trim().toLowerCase();
  const removedFiltered = removedShown.filter((b) => matchesSearch(b, search));
  const restoreRemoved = canManage && removal?.canRestore ? (b: RemovedBet) => removal.restore([b.id]) : null;
  const tabCount = (k: typeof HISTORY_TABS[number][0]) => k === 'removidas' ? removedTotal : counts[k];

  const latestMonthKey = monthGroups.length ? monthGroups[0]!.key : null;
  const effOpenMonths = openMonths || new Set(latestMonthKey ? [latestMonthKey] : []);
  const toggleMonth = (key: string) => setOpenMonths(() => {
    const base = openMonths || new Set(latestMonthKey ? [latestMonthKey] : []);
    const n = new Set(base);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius,
      boxShadow: T.cardShadow, overflow: 'hidden' }}>
      <div style={{ padding: 'var(--bk-pad) var(--bk-pad) 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontFamily: T.font.display, fontSize: 18,
            fontWeight: 600, color: T.text, letterSpacing: '-0.01em',
            whiteSpace: 'nowrap', flexShrink: 0 }}>Histórico de apostas</h3>
          {removedTab ? null : <button type="button" {...porFaixa({ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 7,
            fontFamily: T.font.body, fontSize: 12.5, fontWeight: 500, color: T.textMuted, background: 'transparent',
            border: 'none', cursor: 'pointer' }, { minHeight: ALVO_DE_TOQUE, padding: { largo: '3px 2px', compacto: 0 } })} onClick={copyVisible}>
            <Icon d={ICONS.copy} s={15} />Copiar apostas filtradas ({filtered.length})</button>}
          {removing ? <button type="button" aria-pressed={removing.selecting} onClick={removing.toggleSelecting}
            {...porFaixa({ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: T.font.body, fontSize: 12.5,
              fontWeight: 500, color: removing.selecting ? T.accent : T.textMuted, background: 'transparent', border: 'none',
              cursor: 'pointer' }, { minHeight: ALVO_DE_TOQUE, padding: { largo: '3px 2px', compacto: 0 } })}>
            <Icon d={ICONS.check} s={15} />{removing.selecting ? 'Cancelar seleção' : 'Selecionar'}</button> : null}
        </div>
        {removal?.leftOut.length ? <LeftOutNotice bets={removal.leftOut} onClose={removal.dismissLeftOut} /> : null}
        {removing?.selecting ? (
          <div role="region" aria-label="Remoção em lote" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            padding: '10px 14px', marginBottom: 16, borderRadius: T.radiusMd, background: T.surface2, border: `1px solid ${T.border}` }}>
            <span style={{ fontFamily: T.font.body, fontSize: 13, color: T.textMuted }}>
              {removing.selectedCount === 0
                ? 'Marque as apostas a remover. As do mesmo post saem juntas.'
                : <><b style={{ color: T.text }}>{contagem(removing.selectedCount, 'aposta')}</b> {plural(removing.selectedCount, 'marcada')}</>}
            </span>
            <button type="button" onClick={removing.requestRemoval} disabled={removing.selectedCount === 0 || removing.busy}
              style={{ marginLeft: 'auto', minHeight: 36, padding: '7px 14px', borderRadius: T.radiusSm, border: 'none',
                cursor: removing.selectedCount === 0 || removing.busy ? 'default' : 'pointer', fontFamily: T.font.body, fontSize: 13,
                fontWeight: 600, background: T.neg, color: T.negText, opacity: removing.selectedCount === 0 || removing.busy ? 0.5 : 1 }}>
              {removing.busy ? 'Preparando…' : 'Remover'}</button>
          </div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, background: T.surface2,
          border: `1px solid ${T.border}`, borderRadius: T.radiusMd, padding: '0 14px', marginBottom: 16 }}>
          <Icon d={ICONS.search} s={17} style={{ color: T.textFaint }} />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Buscar no histórico de apostas"
            placeholder="Buscar evento, liga, mercado, seleção, casa…"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', padding: '13px 0',
              fontFamily: T.font.body, fontSize: 14, color: T.text }} />
          <span className={SEM_COMPACTO} style={{ fontFamily: T.font.body, fontSize: 12.5, color: T.textFaint, whiteSpace: 'nowrap' }}>
            {removedTab
              ? `${removedFiltered.length} ${plural(removedFiltered.length, 'removida')}`
              : tab === 'todas' && !q.trim() && (AB.historyTotal ?? 0) > AB.BETS.length
                ? `${filtered.length} de ${AB.historyTotal} resultados`
                : `${filtered.length} resultados`}
          </span>
        </div>
        <div role="tablist" aria-label="Situação das apostas" {...porFaixa({ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4, maxWidth: '100%' }, { overflowX: { largo: 'visible', compacto: 'auto' } }, 'no-scrollbar')}>
          {HISTORY_TABS.map(([k, l]) => {
            const active = tab === k;
            return (
              <button type="button" key={k} role="tab" aria-selected={active} onClick={() => setTab(k)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0,
                fontFamily: T.font.body, fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
                padding: '8px 13px', borderRadius: T.radiusSm, border: 'none',
                background: active ? T.text : 'transparent',
                color: active ? T.surface : T.textMuted, letterSpacing: '-0.01em' }}>
                {l}<span style={{ ...numFont, fontSize: 11.5 }}>{tabCount(k)}</span></button>
            );
          })}
        </div>
      </div>
      {removedTab ? (
        <RemovedBets bets={removedFiltered} total={removedTotal} shown={removedShown.length} searching={search !== ''}
          restoring={removal?.restoring ?? new Set()} onRestore={restoreRemoved} />
      ) : <>
        {(AB.historyTotal ?? 0) > AB.BETS.length && (
          <p role="note" aria-label="Base do histórico" style={{ margin: 0, padding: '12px var(--bk-pad)',
            color: T.textMuted, fontFamily: T.font.body, fontSize: 12.5, lineHeight: 1.5 }}>
            Busca e filtros atuam nas {contagem(AB.BETS.length, 'aposta')} {plural(AB.BETS.length, 'carregada')} de {AB.historyTotal}.
            {' '}<Link href={AB.bk ? `/tipsters/${AB.bk.slug}/analyzer?periodo=tudo` : '/analyzer?periodo=tudo'} style={{ color: T.accent }}>
              Ver histórico completo no Analyzer.
            </Link>
          </p>
        )}
        <div className={SEM_COMPACTO} style={{ display: 'grid', gridTemplateColumns: HISTORY_GRID_COLUMNS, gap: 10,
          padding: '12px var(--bk-pad)', borderTop: `1px solid ${T.borderSoft}`, borderBottom: `1px solid ${T.border}`,
          background: 'transparent' }}>
          {HISTORY_COLS.map(([c, a, chave], i) => {
            if (!chave) return <Label key={i} style={{ fontSize: 10, textAlign: a }}>{c}</Label>;
            const ativa = ordem?.chave === chave;
            return (
              <button key={i} type="button" onClick={() => alternarOrdem(chave)}
                // Sem `aria-sort`: o cabeçalho é um grid de divs, e o atributo num
                // `button` é ARIA inválida. O estado vai no rótulo.
                aria-label={ativa
                  ? `Ordenar por ${c} — atual: ${ordem.desc ? "maior primeiro" : "menor primeiro"}`
                  : `Ordenar por ${c}`}
                style={{ display: 'flex', alignItems: 'center', justifyContent: a === 'right' ? 'flex-end' : 'flex-start',
                  gap: 4, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
                  font: 'inherit', color: ativa ? T.accent : T.textFaint,
                  fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                  fontFamily: T.font.body, transition: `color ${T.motion.fast}` }}>
                {c}
                {/* Seta só na coluna ativa: indicador em toda coluna vira ruído. */}
                <span style={{ ...numFont, fontSize: 9, opacity: ativa ? 1 : 0 }}>{ativa && !ordem.desc ? '▲' : '▼'}</span>
              </button>
            );
          })}
        </div>
        {monthGroups.length === 0 && (
          <div style={{ padding: '50px', textAlign: 'center', fontFamily: T.font.body, color: T.textFaint, fontSize: 14 }}>
            {(AB.historyTotal ?? 0) > AB.BETS.length
              ? `Nenhuma das ${contagem(AB.BETS.length, "aposta")} mais recentes corresponde. O histórico completo tem ${AB.historyTotal}.`
              : "Nenhuma aposta encontrada."}</div>
        )}
        {/* Ordenada: lista plana, e o aviso diz isso — sem ele a ausência dos
            meses parece dado sumido. */}
        {ordenadas && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '11px var(--bk-pad)', borderTop: `1px solid ${T.borderSoft}`, background: T.surface2 }}>
              <span style={{ fontFamily: T.font.body, fontSize: 12.5, color: T.textMuted }}>
                Ordenado por <b style={{ color: T.text }}>{HISTORY_COLS.find(([, , k]) => k === ordem!.chave)?.[0]}</b>
                {' '}({ordem!.desc ? 'maior primeiro' : 'menor primeiro'}) · {contagem(ordenadas.length, 'aposta')}, sem agrupar por mês
              </span>
              <button type="button" onClick={() => setOrdem(null)} {...porFaixa({ marginLeft: 'auto',
                border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: T.font.body,
                fontSize: 12.5, fontWeight: 600, color: T.accent, padding: '3px 2px' }, { minHeight: ALVO_DE_TOQUE })}>
                Voltar a agrupar por mês
              </button>
            </div>
            {ordenadas.slice(0, limitOf(sortWindow)).map((b) => (
              <BetRow key={b.id} b={b} open={open} setOpen={setOpen}
                setResultMenu={setResultMenu} settling={settling} canManage={canManage} selection={selectionOf(b)} />
            ))}
            {moreRows(sortWindow, ordenadas.length)}
          </>
        )}
        {!ordenadas && monthGroups.map((mg) => {
          const opened = effOpenMonths.has(mg.key);
          const allPend = mg.settled === 0;
          const visible = opened ? new Set(mg.days.flatMap((g) => g.bets).slice(0, limitOf(mg.key)).map((b) => b.id)) : new Set<string>();
          return (
            <div key={mg.key}>
              <button type="button" onClick={() => toggleMonth(mg.key)} aria-expanded={opened} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: '14px var(--bk-pad)', cursor: 'pointer', whiteSpace: 'nowrap', border: 'none', borderTop: `1px solid ${T.borderSoft}`, background: opened ? T.surface2 : 'transparent', transition: `background ${T.motion.fast}`, color: T.text, font: 'inherit', textAlign: 'left' }}
                onMouseEnter={(e) => { if (!opened) e.currentTarget.style.background = T.surface2; }} onMouseLeave={(e) => { if (!opened) e.currentTarget.style.background = 'transparent'; }}>
                <div style={{ display: 'grid', placeItems: 'center', color: opened ? T.accent : T.textFaint, transform: opened ? 'rotate(90deg)' : 'none', transition: `transform ${T.motion.base}` }}><Icon d="M8 5l5 5-5 5" s={15} /></div>
                <span style={{ fontFamily: T.font.display, fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: T.text }}>{mg.label}</span>
                <span style={{ fontFamily: T.font.body, fontSize: 12, color: T.textFaint }}>{contagem(mg.count, 'aposta')}{mg.settled > 0 ? ` · ${contagem(mg.settled, 'liquidada')}` : ''}</span>
                <span style={{ marginLeft: 'auto', ...numFont, fontSize: 12.5, fontWeight: 700, color: allPend ? T.textMuted : (mg.profit >= 0 ? T.pos : T.neg), background: allPend ? T.surface2 : (mg.profit >= 0 ? T.posSoft : T.negSoft), padding: '4px 11px', borderRadius: T.pill }}>{allPend ? 'pendente' : fmtU(mg.profit)}</span>
              </button>
              {opened && mg.days.map((g) => {
                const shown = g.bets.filter((b) => visible.has(b.id));
                if (!shown.length) return null;
                const dayProfit = sumMoneyBy(g.bets, (b) => b.profit ?? 0);
                const allPending = g.bets.every((b) => b.status === 'pending');
                return (
                  <div key={g.day}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '9px var(--bk-pad) 9px calc(var(--bk-pad) + 26px)', whiteSpace: 'nowrap', background: 'transparent', borderTop: `1px solid ${T.borderSoft}` }}>
                      <span style={{ fontFamily: T.font.body, fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: T.text }}>{prettyDay(g.day).wd}</span>
                      <span style={{ ...numFont, fontSize: 12, color: T.textFaint }}>{prettyDay(g.day).date}</span>
                      <span style={{ fontFamily: T.font.body, fontSize: 11.5, color: T.textFaint }}>· {contagem(g.bets.length, 'aposta')}</span>
                      <span style={{ marginLeft: 'auto', ...numFont, fontSize: 12, fontWeight: 600, color: allPending ? T.textMuted : ink(dayProfit) }}>{allPending ? 'pendente' : fmtU(dayProfit)}</span>
                    </div>
                    {shown.map((b) => (
                      <BetRow key={b.id} b={b} open={open} setOpen={setOpen}
                        setResultMenu={setResultMenu} settling={settling} canManage={canManage} selection={selectionOf(b)} />
                    ))}
                  </div>
                );
              })}
              {opened && moreRows(mg.key, mg.count)}
            </div>
          );
        })}
      </>}
      <div style={{ height: 'calc(var(--bk-pad) - 8px)' }} />
    </div>
  );
}
