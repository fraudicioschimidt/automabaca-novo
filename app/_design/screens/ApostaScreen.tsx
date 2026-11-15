"use client";
// Ficha de uma aposta: preço (trajetória e CLV), procedência e histórico.
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { fmtOdds, fmtPct, fmtU, fmtUnit } from "@/src/domain/formato-de-resultado";
import type { StatusDeTela } from "@/src/domain/status-de-aposta";
import { AppSidebar } from "../AppSidebar";
import { useDesign } from "../kit/context";
import { ICONS, Icon } from "../kit/icons";
import { AppShell, Btn, Cap, Panel } from "../kit/primitives";
import { porFaixa } from "../kit/faixas";
import { copyText } from "../lib/clipboard";
import type { ApostaScreenProps } from "../screen-types";
import { toast } from "../toast";
import { uiDisplayColor } from "../utils";
import { BetActions } from "./aposta/bet-actions";
import { ClvOrigem } from "./aposta/clv-origem";
import { OddsTrajectory, type TrajectoryStep } from "./aposta/odds-trajectory";
import { TrilhaDaAposta } from "./aposta/trilha";
import { SettlementPanel } from "./aposta/liquidacao";
import { RemovedNotice } from "./aposta/removed-notice";
import styles from "./aposta/bet-actions.module.css";

type Kpi = { k: string; v: string; c: string; sub: string; origem?: boolean };

const QUATRO_OU_DUAS = { largo: 'repeat(4,1fr)', medio: 'repeat(2,1fr)' };

export function ApostaScreen({
  bet: b, trilha = null, captura = null, settlement = null, removal = null, onEditBet = null, onDeleteBet = null, onRestoreBets = null,
}: ApostaScreenProps) {
  const { T, numFont, ink } = useDesign();

  const d = b.d;
  const [betAction, setBetAction] = useState<"edit" | "delete" | null>(null);
  const [origemAberta, setOrigemAberta] = useState(false);
  // A removida é só de leitura: editar ou excluir mexeria no que está fora da banca.
  const canManage = Boolean(b.bkSlug && onEditBet && onDeleteBet) && !removal;

  const statusMap: Record<StatusDeTela, [string, string, string]> = {
    pending: ['Pendente', T.textMuted, T.surface2], won: ['Ganha', T.pos, T.posSoft], halfwon: ['½ Ganha', T.pos, T.posSoft],
    lost: ['Perdida', T.neg, T.negSoft], half: ['½ Perdida', T.neg, T.negSoft], void: ['Reembolso', T.textMuted, T.surface2],
    cashout: ['Cashout', T.accent, T.accentSoft],
  };
  const [stxt, scol, sbg] = removal ? ['Removida', T.neg, T.negSoft] : statusMap[b.status] ?? ['—', T.textMuted, T.surface2];

  const steps: TrajectoryStep[] = [
    ...(d.open != null ? [{ key: 'open', label: 'Abertura', odd: d.open, liq: d.liqOpen }] : []),
    { key: 'entry', label: 'Sua odd', odd: b.odds, liq: null, here: true },
    ...(d.close != null ? [{ key: 'close', label: 'Fechamento', odd: d.close, liq: d.liqClose }] : []),
  ];
  const trajectoryColor = uiDisplayColor(T, d.moveType === 'steam' ? T.pos : d.moveType === 'drift' ? T.neg : T.accent);

  const result = b.profit != null ? fmtU(b.profit) : '—';
  // Abertura (Bridge) × fechamento (justas): quanto a linha andou, medido no
  // adapter, o mesmo número do moveType. Queda = o mercado passou a acreditar
  // mais na seleção.
  const aberturaSub = d.open == null
    ? 'ainda não coletada'
    : d.close == null ? 'fechamento ainda não capturado'
    : b.movimento == null ? 'movimento não medido' : `linha ${fmtPct(b.movimento)} até o fechamento`;
  const kpis: Kpi[] = [
    { k: 'Odd de entrada', v: fmtOdds(b.odds), c: T.text, sub: d.close != null ? `fechou ${fmtOdds(d.close)}` : 'linha ainda aberta' },
    { k: 'Abertura (justa)', v: d.open == null ? '—' : fmtOdds(d.open), c: d.open == null ? T.textFaint : T.text, sub: aberturaSub },
    // O CLV é contra a fair devigada, não contra a odd bruta que fechou: o cartão abre a conta.
    { k: 'CLV', v: b.clv == null ? '—' : fmtPct(b.clv), c: ink(b.clv, T.textFaint),
      sub: origemAberta ? 'ocultar a procedência' : 'ver de onde veio', origem: true },
    // Removida: o CANCELED de lucro zero é o estado de fora da banca, não um resultado.
    removal
      ? { k: 'Resultado', v: '—', c: T.textFaint, sub: removal.previous?.profit != null ? `era ${fmtU(removal.previous.profit)}, estornado` : `stake ${fmtUnit(b.stake)}` }
      : { k: b.profit != null ? 'Resultado' : 'Stake', v: b.profit != null ? result : fmtUnit(b.stake), c: b.profit != null ? ink(b.profit) : T.text, sub: `stake ${fmtUnit(b.stake)}` },
  ];

  const moveTxt = d.moveType === 'steam' ? 'A linha caiu da abertura ao fechamento (steam a favor) — o mercado passou a acreditar mais na seleção.'
    : d.moveType === 'drift' ? 'A linha subiu da abertura ao fechamento (drift contra) — o mercado foi na direção oposta; zona de atenção.'
    : d.moveType === 'estavel' ? 'A linha ficou estável da abertura ao fechamento — sem movimento relevante.'
    : 'Sem abertura e fechamento confirmados, o movimento da linha não foi medido.';

  // O texto que vai para a casa: jogo, seleção @odd e a stake do tipster.
  const copy = async () => {
    try {
      await copyText(`${b.home} vs ${b.away} · ${b.market} ${b.line} @ ${fmtOdds(b.odds)} · ${fmtUnit(b.stake)}`);
      toast('Aposta copiada', 'ok');
    } catch {
      toast('Não foi possível copiar a aposta', 'warn');
    }
  };

  const ficha: Array<{ l: string; v: ReactNode }> = [
    { l: 'Origem', v: <span><Icon d={ICONS.tg} s={13} style={{ display: 'inline', color: T.accent, verticalAlign: '-1px' }} /> {d.origin}{captura?.link ? <> · <a href={captura.link} target="_blank" rel="noreferrer" style={{ color: T.accent, fontWeight: 600, textDecoration: 'none' }}>abrir o post</a></> : null}</span> },
    ...(captura?.leitura ? [{ l: 'Leitura', v: captura.leitura }] : []),
    { l: 'Capturada', v: <span style={numFont}>{d.capturedAt} <span style={{ color: T.textFaint }}>· {d.before}</span></span> },
    ...(d.takenAt ? [{ l: 'Peguei', v: <span><span style={numFont}>{d.takenAt}</span> <span style={{ color: T.textFaint }}>· 👍 no post do canal</span></span> }] : []),
    { l: 'Placar na tip', v: d.liveScoreAtTip ? <span style={numFont}>{d.liveScoreAtTip}</span> : <span style={{ color: T.textFaint }}>— não registrado</span> },
    { l: 'Evento', v: <span style={numFont}>{d.eventAt}</span> },
    { l: 'Casa', v: d.casa || <span style={{ color: T.textFaint }}>— não marcada</span> },
    { l: 'Liquidez (abertura)', v: d.liqOpen != null ? <span style={numFont}>${d.liqOpen}</span> : '—' },
    { l: 'Liquidez (fechamento)', v: d.liqClose != null ? <span style={numFont}>${d.liqClose}</span> : '—' },
    { l: 'Retorno potencial', v: <span style={numFont}>{fmtUnit(b.stake * b.odds)}</span> },
  ];

  return (
    <AppShell sidebar={<AppSidebar active="Tipsters" />}>
      <div {...porFaixa({ flex: 1, minWidth: 0, maxWidth: 1180, margin: '0 auto' }, { padding: { largo: 46, medio: 26 } }, 'app-main')}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, rowGap: 12, flexWrap: 'wrap', marginBottom: 26 }}>
          <Link href={b.bkSlug ? ('/tipsters/' + b.bkSlug) : '/tipsters'} aria-label="Voltar para o tipster" title="Voltar para o tipster" {...porFaixa({ marginTop: 4, display: 'grid', placeItems: 'center', borderRadius: T.radiusSm, border: `1px solid ${T.border}`, color: T.textMuted, textDecoration: 'none', flexShrink: 0 }, { width: { largo: 38, compacto: 44 }, height: { largo: 38, compacto: 44 } })}><Icon d={ICONS.back} s={18} /></Link>
          <div {...porFaixa({ minWidth: 0 }, { flex: { largo: '0 1 auto', compacto: 1 } })}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
              <h1 {...porFaixa({ margin: 0, fontFamily: T.font.display, fontWeight: T.displayWeight, letterSpacing: T.displaySpacing, color: T.text, lineHeight: 1.1 }, { fontSize: { largo: 27, compacto: 22 } })}>{b.home} <span style={{ color: T.textFaint, fontWeight: 400 }}>vs</span> {b.away}</h1>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.font.body, fontSize: 12.5, fontWeight: 600, color: scol, background: sbg, padding: '4px 11px', borderRadius: 999 }}><span style={{ width: 6, height: 6, borderRadius: 6, background: scol }} />{stxt}</span>
              {/* O status sozinho afirma o resultado atual como se sempre tivesse
                  sido esse; a marca leva ao histórico quando ele já foi trocado. */}
              {trilha?.reliquidada ? (
                <a href="#historico-da-aposta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.font.body, fontSize: 12, fontWeight: 600, color: T.textMuted, background: T.surface2, border: `1px solid ${T.border}`, padding: '3px 10px', borderRadius: 999, textDecoration: 'none' }}>
                  <Icon d={ICONS.clock} s={12} />resultado alterado
                </a>
              ) : null}
            </div>
            <div style={{ fontFamily: T.font.body, fontSize: 13.5, color: T.textMuted, marginTop: 6 }}>
              {b.region}{b.league ? ` · ${b.league}` : ''} <span style={{ color: T.textFaint }}>·</span> <span style={{ color: T.accent, fontWeight: 600 }}>{b.market}</span> <b>{b.line}</b>{b.liveScoreAtTip ? <> <span style={{ color: T.textFaint }}>·</span> <b style={{ color: T.accent }}>tip {b.liveScoreAtTip}</b></> : null} <span style={{ color: T.textFaint }}>·</span> <span style={numFont}>{d.eventAt}</span></div>
          </div>
          <div className={styles.headerActions}>
            {canManage ? <Btn icon={ICONS.pencil} onClick={() => setBetAction('edit')}>Editar</Btn> : null}
            {canManage ? <Btn icon={ICONS.trashLines} kind="neg" onClick={() => setBetAction('delete')}>Excluir</Btn> : null}
            <Btn icon={ICONS.copy} onClick={copy}>Copiar</Btn>
          </div>
        </div>
        {removal ? <RemovedNotice removal={removal} betId={b.id} slug={b.bkSlug} onRestore={onRestoreBets} /> : null}
        {/* kpis */}
        <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: QUATRO_OU_DUAS })}>
          {kpis.map((m) => {
            const corpo = (
              <>
                <Cap style={{ marginBottom: 12 }}>{m.k}</Cap>
                <div style={{ ...numFont, fontSize: 28, fontWeight: 600, color: uiDisplayColor(T, m.c), letterSpacing: '-0.02em', lineHeight: 1 }}>{m.v}</div>
                <div style={{ fontSize: 11.5, color: m.origem ? T.accent : T.textFaint, marginTop: 9, fontWeight: m.origem ? 600 : 400 }}>{m.sub}</div>
              </>
            );
            // O CLV é `<button>` de verdade: alvo de teclado, não div com onClick.
            return m.origem ? (
              <Panel key={m.k} pad={0} style={{ overflow: 'hidden' }}>
                <button
                  type="button"
                  aria-expanded={origemAberta}
                  onClick={() => setOrigemAberta((v) => !v)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: 20, border: 'none',
                    background: 'transparent', cursor: 'pointer', font: 'inherit', color: 'inherit',
                    transition: `background ${T.motion.fast}` }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = T.surface2; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {corpo}
                </button>
              </Panel>
            ) : (
              <Panel key={m.k} pad={20}>{corpo}</Panel>
            );
          })}
          {origemAberta && (
            // A grade é do chamador: aqui o painel ocupa a linha inteira de KPIs.
            <div style={{ gridColumn: '1 / -1' }}>
              <ClvOrigem origem={d.clvOrigem} aposApito={d.aposApito ?? null} onFechar={() => setOrigemAberta(false)} />
            </div>
          )}
        </div>
        <div {...porFaixa({ display: 'grid', gap: 16, marginBottom: 22 }, { gridTemplateColumns: { largo: '1.5fr 1fr', medio: '1fr' } })}>
          <Panel>
            <h3 style={{ margin: '0 0 4px', fontFamily: T.font.display, fontSize: 17, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>Trajetória de preço</h3>
            <div style={{ fontSize: 12.5, color: T.textFaint }}>Sua odd comparada à linha da Pinnacle ao longo do mercado</div>
            <OddsTrajectory steps={steps} lineColor={trajectoryColor} />
          </Panel>
          <Panel style={{ display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ margin: '0 0 14px', fontFamily: T.font.display, fontSize: 17, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>Movimento</h3>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, alignSelf: 'flex-start', fontFamily: T.font.body, fontSize: 13.5, fontWeight: 600, color: d.moveType === 'steam' ? T.pos : d.moveType === 'drift' ? T.neg : T.textMuted, background: d.moveType === 'steam' ? T.posSoft : d.moveType === 'drift' ? T.negSoft : T.surface2, padding: '6px 12px', borderRadius: 999, marginBottom: 14 }}>
              {d.moveType && <Icon d={d.moveType === 'steam' ? ICONS.arrowDownShort : ICONS.arrowUpShort} s={15} w={2} />}{d.moveType === 'steam' ? 'Steam (a favor)' : d.moveType === 'drift' ? 'Drift (contra)' : d.moveType === 'estavel' ? 'Linha estável' : 'Sem medição'}</div>
            <div style={{ fontFamily: T.font.body, fontSize: 13.5, color: T.textMuted, lineHeight: 1.55 }}>{moveTxt}</div>
            {d.open != null && d.close != null && <div style={{ marginTop: 'auto', paddingTop: 16, borderTop: `1px solid ${T.borderSoft}`, fontSize: 12.5, color: T.textMuted }}>Abertura <b style={numFont}>{fmtOdds(d.open)}</b> → fechamento <b style={numFont}>{fmtOdds(d.close)}</b> (justas)</div>}
          </Panel>
        </div>
        {/* origem / ficha */}
        <Panel>
          <h3 style={{ margin: '0 0 16px', fontFamily: T.font.display, fontSize: 17, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>Ficha da aposta</h3>
          <div {...porFaixa({ display: 'grid', gap: 20 }, { gridTemplateColumns: QUATRO_OU_DUAS })}>
            {ficha.map(({ l, v }) => (
              <div key={l}><Cap style={{ fontSize: 9.5, marginBottom: 7 }}>{l}</Cap><div style={{ fontFamily: T.font.body, fontSize: 13.5, color: T.text }}>{v}</div></div>
            ))}
          </div>
          {captura?.texto ? (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.borderSoft}` }}>
              <Cap style={{ fontSize: 9.5, marginBottom: 7 }}>Post original</Cap>
              <p style={{ margin: 0, fontFamily: T.font.body, fontSize: 13.5, color: T.text, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{captura.texto}</p>
            </div>
          ) : null}
        </Panel>
        {settlement ? (
          <>
            <div style={{ height: 16 }} />
            <SettlementPanel card={settlement} />
          </>
        ) : null}
        {trilha ? (
          <>
            <div style={{ height: 16 }} />
            <Panel>
              <TrilhaDaAposta trilha={trilha} />
            </Panel>
          </>
        ) : null}
        <div style={{ height: 20 }} />
      </div>
      {betAction ? (
        <BetActions
          b={b}
          action={betAction}
          onClose={() => setBetAction(null)}
          onEdit={onEditBet}
          onDelete={onDeleteBet}
        />
      ) : null}
    </AppShell>
  );
}
