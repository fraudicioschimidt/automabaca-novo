import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Label } from "./ui-primitives";
import { ClvOrigem } from "../aposta/clv-origem";
import styles from "./bet-expanded.module.css";
import { ICONS, Icon } from "../../kit/icons";
import { useDesign } from "../../kit/context";
import { fmtOdds, fmtPct } from "@/src/domain/formato-de-resultado";
import { cssVars } from "../../kit/css-vars";
import type { BankrollBet } from "./types";

type TrackLeg = readonly [label: string, value: string];

function Move({ d }: { d: BankrollBet["d"] }) {
  const { T } = useDesign();
  if (!d.moveType) return <span className={styles.faint}>sem abertura e fechamento</span>;
  if (d.moveType === 'estavel') return <span className={styles.faint}>linha estável</span>;
  const steam = d.moveType === 'steam';
  return (
    <span className={styles.move} style={cssVars({ '--move-color': steam ? T.pos : T.neg })}>
      <Icon d={steam ? ICONS.arrowDownShort : ICONS.arrowUpShort} s={14} w={2} />{steam ? 'steam' : 'drift'}</span>
  );
}

function Track({ legs, active = 1 }: { legs: readonly TrackLeg[]; active?: number }) {
  const { T, numFont } = useDesign();
  return (
    <div className={styles.track}>
      <div className={styles.trackLabels}>
        {legs.map(([l], i) => (
          <div key={l} className={`${styles.leg} ${i === 0 ? styles.left : i === legs.length - 1 ? styles.right : styles.center}`}>
            <Label className={styles.trackLabel} style={{ fontSize: 9.5, color: i === active ? T.accent : T.textFaint }}>{l}</Label>
          </div>
        ))}
      </div>
      <div className={styles.trackRail}>
        <div className={styles.trackLine} />
        {legs.map((_, i) => {
          const isA = i === active;
          return (
            <div key={i} className={`${styles.marker} ${i === 0 ? styles.markerLeft : i === legs.length - 1 ? styles.markerRight : styles.markerCenter}`}
              style={cssVars({ '--marker-bg': isA ? T.accent : T.surface, '--marker-border': isA ? T.accent : T.textFaint })} />
          );
        })}
      </div>
      <div className={styles.trackValues}>
        {legs.map(([l, v], i) => (
          <div key={l} className={`${styles.leg} ${i === 0 ? styles.left : i === legs.length - 1 ? styles.right : styles.center}`}>
            <span className={styles.trackValue} style={cssVars({ ...numFont,
              '--value-color': i === active ? T.text : T.textMuted,
              '--value-bg': i === active ? T.surface2 : 'transparent',
              '--value-padding': i === active ? '3px 9px' : '3px 0' })}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div><Label className={styles.fieldLabel}>{label}</Label>
      <div className={styles.fieldValue}>{children}</div></div>
  );
}

/**
 * Expansão da linha: odds, liquidez, movimento e o CLV, para inspecionar sem
 * sair da lista (e comparar várias linhas abertas ao mesmo tempo).
 */
export function BetDetail({ b }: { b: BankrollBet }) {
  const { T, numFont, ink } = useDesign();
  const d = b.d;
  const [origemAberta, setOrigemAberta] = useState(false);
  const odLeg: TrackLeg[] = [['Abertura', fmtOdds(d.open)], ['Sua odd', fmtOdds(b.odds)], ['Fechamento', fmtOdds(d.close)]];
  const lqLeg: TrackLeg[] = [['Abertura', d.liqOpen != null ? '$' + d.liqOpen : '—'], ['Fechamento', d.liqClose != null ? '$' + d.liqClose : '—']];
  return (
    <div className={styles.root} style={cssVars({
      '--detail-bg': T.surface2,
      '--detail-soft-border': T.borderSoft, '--detail-border': T.border,
      '--detail-text': T.text, '--detail-muted': T.textMuted, '--detail-faint': T.textFaint,
      '--detail-accent': T.accent, '--detail-body': T.font.body,
      '--detail-radius-sm': `${T.radiusSm}px`,
    })}>
      <div className={styles.tracks}>
        <div className={styles.trackSection}>
          <Label className={styles.oddsLabel}>Odds</Label>
          <Track legs={odLeg} />
        </div>
        <div className={styles.trackSection}>
          <Label className={styles.liquidityLabel}>Liquidez</Label>
          <Track legs={lqLeg} active={-1} />
        </div>
      </div>
      <div className={styles.fields}>
        <Field label="Evento"><span style={numFont}>{d.eventAt}</span></Field>
        {d.liveScoreAtTip ? <Field label="Placar na tip"><span style={numFont}>{d.liveScoreAtTip}</span></Field> : null}
        <Field label="Casa">{d.casa || <span className={styles.faint}>—</span>}</Field>
        <Field label="Capturada"><span style={numFont}>{d.capturedAt}</span>
          <span className={styles.faint}> · {d.before}</span></Field>
        <Field label="Origem">{d.origin}{d.msg != null && <span className={styles.faint}> · msg #{d.msg}</span>}</Field>
      </div>
      <div className={styles.movementSection}>
        <Label className={styles.movementLabel}>Movimento</Label>
        <div className={styles.movement}>
          <span>abriu <b className={styles.movementValue} style={cssVars({ ...numFont, '--movement-color': T.text })}>{fmtOdds(d.open)}</b></span>
          <span className={styles.faint}>→</span>
          <span>{d.close ? <>fechou <b className={styles.movementValue} style={cssVars({ ...numFont, '--movement-color': T.text })}>{fmtOdds(d.close)}</b></>
            : <span className={styles.faint}>ainda aberto</span>}</span>
          <Move d={d} />
          <span className={styles.faint}>·</span>
          <span>CLV <b className={styles.movementValue} style={cssVars({ ...numFont, '--movement-color': b.clv == null ? T.textFaint : ink(b.clv) })}>{fmtPct(b.clv)}</b></span>
          <button type="button" className={styles.origemBotao} aria-expanded={origemAberta}
            onClick={(e) => { e.stopPropagation(); setOrigemAberta((v) => !v); }}>
            {origemAberta ? 'ocultar procedência' : 'de onde veio?'}
          </button>
          <Link href={'/aposta?id=' + b.id} prefetch={false} onClick={(e) => e.stopPropagation()}
            className={styles.fullLink}>
            Ver aposta completa<Icon d="M8 5l5 5-5 5" s={14} /></Link>
        </div>
        {origemAberta && (
          <div className={styles.origemPainel} onClick={(e) => e.stopPropagation()}>
            <ClvOrigem
              origem={d.clvOrigem}
              aposApito={d.aposApito ?? null}
              onFechar={() => setOrigemAberta(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
