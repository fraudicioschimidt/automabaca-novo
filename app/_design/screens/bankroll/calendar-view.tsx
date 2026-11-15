import type { Dispatch, SetStateAction } from "react";
import { uiDisplayColor, uiHexA } from "../../utils";
import { summarizeCalendarMonth, type CalendarDayAggregate } from "../../lib/bankroll-calendar";
import { calendarMonthMeta, weekdayFromDayKey } from "../../lib/calendar-date";
import { MONTH_NAMES, WEEKDAY_ABBREVIATIONS } from "@/src/domain/dates";
import { Label } from "./ui-primitives";
import styles from "./calendar-view.module.css";
import { contagem, plural } from "../../lib/plural";
import { rotuloDeStatusDeTela } from "@/src/domain/status-de-aposta";
import { Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { fmtOdds, fmtU, fmtUnit } from "@/src/domain/formato-de-resultado";
import { cssVars } from "../../kit/css-vars";
import type { BankrollBet } from "./types";

type DayAgg = Record<string, CalendarDayAggregate>;
type CalMonth = { y: number; m: number };

const pad2 = (x: number) => String(x).padStart(2, '0');

function Dot() {
  const { T } = useDesign();
  return <span className={styles.dot} style={cssVars({ '--dot-color': T.textFaint })}>·</span>;
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className={styles.legend}>
      <span className={styles.legendDot} style={cssVars({ '--legend-color': color })} />{label}</span>
  );
}

function NavBtn({ dir: d, onClick }: { dir: 'prev' | 'next'; onClick: () => void }) {
  const { T } = useDesign();
  const label = d === 'prev' ? 'Mês anterior' : 'Próximo mês';
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={styles.navButton} style={cssVars({
      '--nav-radius': `${T.radiusSm}px`, '--nav-border': T.border, '--nav-color': T.textMuted,
    })}>
      <Icon d={d === 'prev' ? 'M12 4l-6 6 6 6' : 'M8 4l6 6-6 6'} s={16} /></button>
  );
}

function CalendarCell({ d, dk, dayAgg, todayKey, selDay, setSelDay }: {
  d: number;
  dk: string;
  dayAgg: DayAgg;
  todayKey: string;
  selDay: string;
  setSelDay: Dispatch<SetStateAction<string>>;
}) {
  const { T, numFont, ink } = useDesign();
  const a = dayAgg[dk];
  const isSel = dk === selDay, isToday = dk === todayKey;
  const allPending = a && a.settledCount === 0;
  const bg = !a ? 'transparent' : allPending ? T.accentSoft : a.profit < 0 ? T.negSoft : a.profit > 0 ? T.posSoft : T.surface2;
  return (
    <button type="button" onClick={() => a && setSelDay(dk)} className={styles.cell} style={cssVars({
      '--cell-cursor': a ? 'pointer' : 'default',
      '--cell-border': isSel ? `1.5px solid ${T.accent}` : `1px solid ${T.borderSoft}`,
      '--cell-bg': bg, '--cell-radius': `${T.radiusSm}px`,
      '--cell-shadow': isSel ? `0 0 0 3px ${uiHexA(T.accent, 0.14)}` : 'none',
    })}>
      <div className={styles.cellHead}>
        <span className={styles.dayNumber} style={cssVars({ ...numFont, '--day-weight': isToday ? 700 : 500, '--day-color': a ? T.text : T.textFaint })}>{d}</span>
        {isToday && <span className={styles.today} style={cssVars({ '--today-color': T.accent })}>hoje</span>}
      </div>
      {a && (
        <div className={styles.cellAggregate}>
          <div className={styles.cellProfit} style={cssVars({ ...numFont, '--profit-color': allPending ? T.accent : ink(a.profit) })}>
            {allPending ? `${a.count}×` : fmtU(a.profit)}</div>
          <div className={styles.cellDescription} style={cssVars({ '--muted-color': T.textMuted })}>
            {allPending ? `${fmtUnit(a.units)} aberto` : contagem(a.count, 'aposta')}</div>
        </div>
      )}
    </button>
  );
}

function RailRow({ b }: { b: BankrollBet }) {
  const { T, numFont, ink } = useDesign();
  return (
    <div className={styles.railRow} style={cssVars({ '--soft-border': T.borderSoft })}>
      <div className={styles.railMain}>
        <div className={styles.railEvent} style={cssVars({ '--text-color': T.text })}>
          {b.home} <span className={styles.versus} style={cssVars({ '--faint-color': T.textFaint })}>vs</span> {b.away}</div>
        <div className={styles.railMeta} style={cssVars({ '--muted-color': T.textMuted })}>
          <span style={numFont}>{b.time}</span> <span className={styles.faint} style={cssVars({ '--faint-color': T.textFaint })}>·</span>{' '}
          <span className={styles.market} style={cssVars({ '--accent-color': T.accent })}>{b.market}</span> {b.line} <span className={styles.faint} style={cssVars({ '--faint-color': T.textFaint })}>·</span>{' '}
          <span style={numFont}>{fmtOdds(b.odds)}</span></div>
      </div>
      <div className={styles.railResult}>
        {b.profit != null
          ? <span className={styles.railProfit} style={cssVars({ ...numFont, '--result-color': ink(b.profit) })}>{fmtU(b.profit)}</span>
          : <span className={styles.railStake} style={cssVars({ ...numFont, '--result-color': T.textMuted })}>{fmtUnit(b.stake)}</span>}
        <div className={styles.railStatus} style={cssVars({ '--status-color': b.profit != null ? T.textFaint : T.textMuted })}>
          {b.profit == null ? 'pendente' : rotuloDeStatusDeTela(b.status)}</div>
      </div>
    </div>
  );
}

export function CalendarView({
  todayKey, calMonth, setCalMonth, selDay, setSelDay, dayAgg, allBets,
}: {
  todayKey: string;
  calMonth: CalMonth;
  setCalMonth: Dispatch<SetStateAction<CalMonth>>;
  selDay: string;
  setSelDay: Dispatch<SetStateAction<string>>;
  dayAgg: DayAgg;
  allBets: BankrollBet[];
}) {
  const { T, numFont, ink } = useDesign();
  const { startWeekday: startDow, daysInMonth: dim } = calendarMonthMeta(calMonth.y, calMonth.m);
  const cells: (number | null)[] = [...Array(startDow).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const dk = (d: number) => `${calMonth.y}-${pad2(calMonth.m + 1)}-${pad2(d)}`;
  const monthSummary = summarizeCalendarMonth(dayAgg, calMonth.y, calMonth.m);
  const selBets = allBets.filter((b) => b.day === selDay);
  const selA = dayAgg[selDay];
  const [sy, sm, sd] = selDay.split('-').map(Number);
  const selDow = weekdayFromDayKey(selDay);
  const selAllPending = selA && selA.settledCount === 0;
  const selSettled = selA && selA.settledCount === selA.count;
  return (
    <div className={`${styles.root} no-scrollbar`}>
      <div className={styles.calendarPane}>
        <div className={styles.toolbar}>
          <NavBtn dir="prev" onClick={() => setCalMonth((c) => c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 })} />
          <div className={styles.monthTitle} style={cssVars({ '--display-font': T.font.display })}>{MONTH_NAMES[calMonth.m]} {calMonth.y}</div>
          <NavBtn dir="next" onClick={() => setCalMonth((c) => c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 })} />
          <div className={styles.legends} style={cssVars({ '--muted-color': T.textMuted })}>
            <Legend color={T.pos} label="Lucro" /><Legend color={T.neg} label="Perda" /><Legend color={T.accent} label="Pendente" />
          </div>
        </div>
        <div className={styles.weekdays}>
          {WEEKDAY_ABBREVIATIONS.map((w) => <div key={w} className={styles.weekday} style={cssVars({ '--faint-color': T.textFaint })}>{w}</div>)}
        </div>
        <div className={styles.grid}>
          {cells.map((d, i) => d == null ? <div key={i} /> : <CalendarCell key={i} d={d} dk={dk(d)} dayAgg={dayAgg} todayKey={todayKey} selDay={selDay} setSelDay={setSelDay} />)}
        </div>
        <div className={styles.summary} style={cssVars({ '--soft-border': T.borderSoft, '--muted-color': T.textMuted })}>
          <b style={{ color: T.text }}>{MONTH_NAMES[calMonth.m]}</b><Dot /> {contagem(monthSummary.count, 'aposta')} <Dot /> {monthSummary.settledCount} {plural(monthSummary.settledCount, 'liquidada')}
          <Dot /> <span className={styles.summaryProfit} style={{ ...numFont, color: ink(monthSummary.profit) }}>{fmtU(monthSummary.profit)}</span> <Dot /> {monthSummary.openCount} em aberto
        </div>
      </div>
      <div className={styles.rail} style={cssVars({ '--soft-border': T.borderSoft, '--rail-bg': T.surface2 })}>
        <Label>{WEEKDAY_ABBREVIATIONS[selDow]} · {pad2(sd!)}/{pad2(sm!)}/{sy}</Label>
        <div className={styles.railHeading}>
          <span className={styles.railValue} style={cssVars({ '--display-font': T.font.display })}>
            {selA ? (selAllPending ? <span style={numFont}>{selA.count}</span> : <span style={{ ...numFont, color: uiDisplayColor(T, ink(selA.profit)) }}>{fmtU(selA.profit)}</span>) : '—'}</span>
          <span className={styles.railHeadingLabel} style={cssVars({ '--muted-color': T.textMuted })}>{selA ? (selAllPending ? plural(selA.count, 'aposta') : selSettled ? 'resultado' : 'resultado parcial') : 'sem apostas'}</span>
        </div>
        {selA && <div className={styles.railAllocation} style={cssVars({ '--faint-color': T.textFaint })}>{fmtUnit(selA.units)} alocadas · {selA.settledCount} liquidada{selA.settledCount === 1 ? '' : 's'}{selSettled ? '' : ` · ${selA.count - selA.settledCount} em aberto`}</div>}
        <div className={`${styles.railScroll} no-scrollbar`} role="region" aria-label="Apostas do dia" tabIndex={0}>
          {selBets.length === 0 && <div className={styles.emptyDay} style={cssVars({ '--faint-color': T.textFaint })}>Nenhuma aposta neste dia.</div>}
          {selBets.map((b) => <RailRow key={b.id} b={b} />)}
        </div>
      </div>
    </div>
  );
}
