import { lazy, Suspense, type CSSProperties, type Dispatch, type MouseEvent, type SetStateAction } from "react";
import { sportIconSrc } from "../../lib/sport-icon";
import { ICONS, Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { SEM_COMPACTO, SO_COMPACTO } from "../../kit/faixas";
import { fmtOdds, fmtPct, fmtU, fmtUnit } from "@/src/domain/formato-de-resultado";
import type { BankrollBet, ResultMenuState } from "./types";
import { HISTORY_GRID_COLUMNS } from "./constants";

const BetDetail = lazy(() => import("./bet-expanded").then((module) => ({ default: module.BetDetail })));

export function StatusPill({ b }: { b: Pick<BankrollBet, "status" | "reliq"> }) {
  const { T } = useDesign();
  const map = {
    pending: ['Pendente', T.textMuted, T.surface2],
    won: ['Ganha', T.pos, T.posSoft], halfwon: ['½ Ganha', T.pos, T.posSoft],
    lost: ['Perdida', T.neg, T.negSoft], half: ['½ Perdida', T.neg, T.negSoft],
    void: ['Reembolso', T.textMuted, T.surface2], cashout: ['Cashout', T.accent, T.accentSoft],
  };
  const [txt, col, bg] = map[b.status] || ['—', T.textMuted, T.surface2];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.font.body,
      fontSize: 12, fontWeight: 600, color: col, background: bg, padding: '4px 10px', borderRadius: T.pill }}>
      <span style={{ width: 6, height: 6, borderRadius: 6, background: col }} />{txt}
      {/* Asterisco, não segunda pílula: a linha já é densa, e basta dizer que
          este resultado não é o primeiro — o detalhe fica no histórico da ficha. */}
      {b.reliq ? <span title="Resultado alterado depois de liquidada — ver histórico na ficha"
        aria-label="resultado alterado depois de liquidada"
        style={{ fontWeight: 700, opacity: 0.75 }}>*</span> : null}
    </span>
  );
}

/** Marca da aposta na remoção em lote; não abre a ficha ao clicar. */
function SelectBox({ b, selection }: { b: BankrollBet; selection: RowSelection }) {
  const { T } = useDesign();
  const label = `${selection.on ? 'Desmarcar' : 'Marcar'} ${b.home} contra ${b.away}`;
  return (
    <button type="button" role="checkbox" aria-checked={selection.on} aria-label={label} title={label}
      onClick={(event) => { event.stopPropagation(); selection.toggle(); }}
      style={{ minWidth: 32, minHeight: 32, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
        display: 'grid', placeItems: 'center', flexShrink: 0 }}>
      <span style={{ width: 18, height: 18, borderRadius: 5, display: 'grid', placeItems: 'center',
        border: `1.5px solid ${selection.on ? T.neg : T.border}`, background: selection.on ? T.neg : 'transparent', color: T.negText }}>
        {selection.on ? <Icon d={ICONS.check} s={12} w={2.4} /> : null}
      </span>
    </button>
  );
}

export type RowSelection = { on: boolean; toggle: () => void };

export function BetRow({
  b, open, setOpen, setResultMenu, settling, canManage = true, selection = null,
}: {
  b: BankrollBet;
  open: Record<string, boolean>;
  setOpen: Dispatch<SetStateAction<Record<string, boolean>>>;
  setResultMenu: Dispatch<SetStateAction<ResultMenuState | null>>;
  settling: string | null;
  canManage?: boolean;
  /** Com a remoção em lote ativa, a linha ganha a marca. */
  selection?: RowSelection | null;
}) {
  const { T, mode, ink, numFont } = useDesign();
  const isOpen = !!open[b.id];
  const sIcon = sportIconSrc(b.esporte);
  const capS: CSSProperties = { fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: T.textFaint, marginTop: 3, fontFamily: T.font.body };
  const sportWrap: CSSProperties = { width: 30, minWidth: 30, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 4 };
  const sportIconBox: CSSProperties = { width: 26, height: 24, display: 'grid', placeItems: 'center',
    color: T.textMuted, opacity: 0.95 };
  const sportImgStyle: CSSProperties = { width: 22, height: 22, objectFit: 'contain',
    filter: mode === 'dark' ? 'drop-shadow(0 1px 1px rgba(0,0,0,.38))' : 'drop-shadow(0 1px 1px rgba(20,18,14,.18))' };
  const openResultMenu = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setResultMenu((m) => (m && m.b.id === b.id) ? null : { b, x: r.right, y: r.bottom });
  };
  const toggleDetails = () => setOpen((current) => ({ ...current, [b.id]: !current[b.id] }));
  const toggleDetailsButton = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    toggleDetails();
  };
  const detailsId = `bet-details-${b.id}`;
  const showStatus = b.status === 'void' || b.profit == null;
  const linhaHint = b.movimento == null
    ? 'Variação da odd entre a abertura e o fechamento: precisa das duas cotações'
    : 'Variação da odd justa entre a abertura e o fechamento; negativo = odd caiu, mercado a favor da seleção; positivo = odd subiu, mercado contra a seleção';
  const clvHint = b.clv == null ? 'CLV depende da cotação de fechamento, coletada perto do início do jogo' : undefined;

  const metric = (label: string, value: string, color: string = T.text, title?: string) => (
    <div title={title} style={{ minWidth: 0 }}>
      <div style={{ ...numFont, fontSize: 13, fontWeight: 600, color, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      <div style={capS}>{label}</div>
    </div>
  );

  // Duas cabeças, uma por faixa (o CSS mostra uma): cartão no compacto, linha
  // de tabela fora dele. A expansão abaixo é uma só.
  return (
    <div style={{ position: 'relative', borderBottom: `1px solid ${T.borderSoft}`,
      background: isOpen ? T.surface2 : 'transparent', transition: `background ${T.motion.base}` }}>
      {isOpen && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: T.accent,
        zIndex: 1 }} />}
        <div onClick={toggleDetails} className={SO_COMPACTO}
          style={{ padding: 'var(--bk-row-py) var(--bk-pad)', cursor: 'pointer' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            {selection ? <SelectBox b={b} selection={selection} /> : null}
            <div style={sportWrap}>
              <div style={sportIconBox}>
                {sIcon
                  // eslint-disable-next-line @next/next/no-img-element -- ícone estático e pequeno; o next/image não ganha nada aqui.
                  ? <img src={sIcon} alt={b.esporte || ''} width={22} height={22} style={sportImgStyle} />
                  : <Icon d="M10 3a7 7 0 100 14 7 7 0 000-14M10 6l2 1.5-.8 2.3h-2.4L6 7.5z" s={17} w={1.35} />}
              </div>
              <span title={b.kickoffInferido ? 'Horário a confirmar' : undefined} style={{ ...numFont, fontSize: 9.5, color: T.textFaint }}>{b.time}</span>
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontFamily: T.font.body, fontSize: 14, fontWeight: 600, color: T.text,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {b.home} <span style={{ color: T.textFaint, fontWeight: 400 }}>vs</span> {b.away}</div>
              <div style={{ fontFamily: T.font.body, fontSize: 11.5, color: T.textMuted, marginTop: 3,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {b.sportPending
                  ? <><span style={{ color: T.accent, fontWeight: 600 }}>Esporte a confirmar</span> · {b.market} · {b.line}</>
                  : <>{b.region}{b.league ? ` · ${b.league}` : ''} · <span style={{ color: T.accent, fontWeight: 600 }}>{b.market}</span> · {b.line}</>}
                {b.kickoffInferido ? <> · Horário a confirmar</> : null}
                {b.liveScoreAtTip ? <> · <span style={{ color: T.accent, fontWeight: 600 }}>tip {b.liveScoreAtTip}</span></> : null}</div>
            </div>
            {canManage ? <button type="button" onClick={openResultMenu} aria-label={`Alterar resultado de ${b.home} contra ${b.away}`}
              style={{ minWidth: 44, minHeight: 44, border: 'none', background: 'transparent', cursor: 'pointer', padding: 4,
                borderRadius: T.radiusSm, display: 'grid', placeItems: 'center', opacity: settling === b.id ? 0.5 : 1 }}>
              {showStatus
                ? <StatusPill b={b} />
                : <span style={{ ...numFont, fontSize: 13, fontWeight: 600, color: ink(b.profit) }}>{fmtU(b.profit)}</span>}
            </button> : (showStatus
              ? <StatusPill b={b} />
              : <span style={{ ...numFont, fontSize: 13, fontWeight: 600, color: ink(b.profit) }}>{fmtU(b.profit)}</span>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8,
            marginTop: 13, padding: '11px 0 0 40px', borderTop: `1px solid ${T.borderSoft}` }}>
            {metric('Cotação', fmtOdds(b.odds))}
            {metric('Abre → fecha', fmtPct(b.movimento), b.movimento == null ? T.textFaint : T.textMuted, linhaHint)}
            {metric('CLV', fmtPct(b.clv), ink(b.clv, T.textFaint), clvHint)}
            {metric('Stake', fmtUnit(b.stake), T.textMuted)}
          </div>
          <button type="button" onClick={toggleDetailsButton} aria-expanded={isOpen} aria-controls={detailsId}
            aria-label={`${isOpen ? 'Recolher' : 'Expandir'} detalhes de ${b.home} contra ${b.away}`}
            style={{ width: '100%', minHeight: 44, border: 'none', background: 'transparent', cursor: 'pointer', display: 'grid', placeItems: 'center', color: isOpen ? T.accent : T.textFaint,
              transform: isOpen ? 'rotate(180deg)' : 'none', transition: `transform ${T.motion.base}, color ${T.motion.base}`, marginTop: 8 }}>
            <Icon d={ICONS.chevronDownWide} s={15} />
          </button>
        </div>
      <div onClick={toggleDetails} className={SEM_COMPACTO}
        style={{ display: 'grid', gridTemplateColumns: HISTORY_GRID_COLUMNS,
          alignItems: 'center', gap: 10, padding: 'var(--bk-row-py) var(--bk-pad)', cursor: 'pointer' }}
        onMouseEnter={(e) => { if (!isOpen) e.currentTarget.parentElement!.style.background = T.surface2; }}
        onMouseLeave={(e) => { if (!isOpen) e.currentTarget.parentElement!.style.background = 'transparent'; }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
          {selection ? <SelectBox b={b} selection={selection} /> : null}
          <div style={sportWrap}>
            <div style={sportIconBox}>
              {sIcon
                // eslint-disable-next-line @next/next/no-img-element -- ícone estático e pequeno; o next/image não ganha nada aqui.
                ? <img src={sIcon} alt={b.esporte || ''} width={22} height={22} style={sportImgStyle} />
                : <Icon d="M10 3a7 7 0 100 14 7 7 0 000-14M10 6l2 1.5-.8 2.3h-2.4L6 7.5z" s={17} w={1.35} />}
            </div>
            <span style={{ ...numFont, fontSize: 9.5, color: T.textFaint }}>{b.time}</span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: T.font.body, fontSize: 14.5, fontWeight: 600, color: T.text,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {b.home} <span style={{ color: T.textFaint, fontWeight: 400 }}>vs</span> {b.away}</div>
            <div style={{ fontFamily: T.font.body, fontSize: 12, color: T.textMuted, marginTop: 2,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {b.sportPending
                ? <><span style={{ color: T.accent, fontWeight: 600 }}>Esporte a confirmar</span> <span style={{ color: T.textFaint }}>·</span>{' '}
                  <span>{b.market}</span> <span style={{ color: T.textFaint }}>·</span>{' '}
                  <span style={{ fontWeight: 600 }}>{b.line}</span></>
                : <>{b.region}{b.league ? ` · ${b.league}` : ''} <span style={{ color: T.textFaint }}>·</span>{' '}
                  <span style={{ color: T.accent, fontWeight: 600 }}>{b.market}</span> <span style={{ color: T.textFaint }}>·</span>{' '}
                  <span style={{ fontWeight: 600 }}>{b.line}</span></>}
              {b.liveScoreAtTip ? <><span style={{ color: T.textFaint }}> · </span><span style={{ color: T.accent, fontWeight: 600 }}>tip {b.liveScoreAtTip}</span></> : null}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}><div style={{ ...numFont, fontSize: 14, fontWeight: 600, color: T.text }}>{fmtOdds(b.odds)}</div><div style={capS}>Cotação</div></div>
        <div title={linhaHint} style={{ textAlign: 'right' }}><div style={{ ...numFont, fontSize: 13, fontWeight: 600, color: b.movimento == null ? T.textFaint : T.textMuted }}>{fmtPct(b.movimento)}</div><div style={capS}>Abre → fecha</div></div>
        <div title={clvHint} style={{ textAlign: 'right' }}><div style={{ ...numFont, fontSize: 13, fontWeight: 600, color: ink(b.clv, T.textFaint) }}>{fmtPct(b.clv)}</div><div style={capS}>CLV</div></div>
        <div style={{ textAlign: 'right' }}><div style={{ ...numFont, fontSize: 13, color: T.textMuted }}>{fmtUnit(b.stake)}</div><div style={capS}>Stake</div></div>
        <div style={{ textAlign: 'right' }}>
          {canManage ? <button type="button" onClick={openResultMenu}
            title="Alterar resultado" aria-label={`Alterar resultado de ${b.home} contra ${b.away}`}
            onMouseEnter={(e) => { e.currentTarget.style.background = T.surface2; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '4px 6px', margin: '-4px -6px',
              borderRadius: T.radiusSm, transition: `background ${T.motion.fast}`, display: 'inline-flex', flexDirection: 'column',
              alignItems: 'flex-end', opacity: settling === b.id ? 0.5 : 1 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {showStatus
                ? <StatusPill b={b} />
                : <span style={{ ...numFont, fontSize: 14, fontWeight: 600, color: ink(b.profit) }}>{fmtU(b.profit)}</span>}
              <Icon d={ICONS.chevronDownWide} s={11} style={{ color: T.textFaint, flexShrink: 0 }} />
            </span>
            <span style={capS}>{showStatus ? 'Situação' : 'Lucro'}</span>
          </button> : <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            {showStatus
              ? <StatusPill b={b} />
              : <span style={{ ...numFont, fontSize: 14, fontWeight: 600, color: ink(b.profit) }}>{fmtU(b.profit)}</span>}
            <span style={capS}>{showStatus ? 'Situação' : 'Lucro'}</span>
          </div>}
        </div>
        <button type="button" onClick={toggleDetailsButton} aria-expanded={isOpen} aria-controls={detailsId}
          aria-label={`${isOpen ? 'Recolher' : 'Expandir'} detalhes de ${b.home} contra ${b.away}`}
          style={{ width: 32, height: 32, border: 'none', background: 'transparent', cursor: 'pointer', display: 'grid', placeItems: 'center', color: isOpen ? T.accent : T.textFaint,
            transform: isOpen ? 'rotate(180deg)' : 'none', transition: `transform ${T.motion.base}, color ${T.motion.base}` }}>
          <Icon d={ICONS.chevronDownWide} s={15} /></button>
      </div>
      <div id={detailsId} style={{ display: 'grid', gridTemplateRows: isOpen ? '1fr' : '0fr',
        transition: `grid-template-rows ${T.motion.slow} ${T.motion.standard}` }}>
        <div style={{ overflow: 'hidden' }}>
          {isOpen && <Suspense fallback={null}>
            <BetDetail b={b} />
          </Suspense>}
        </div>
      </div>
    </div>
  );
}
