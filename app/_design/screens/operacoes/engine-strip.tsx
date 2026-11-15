import { useDesign } from "../../kit/context";
import { OpsCard } from "./ui-primitives";
import styles from "./operacoes.module.css";
import { ICONS, Icon } from "../../kit/icons";
import { Cap } from "../../kit/primitives";
import type { MonitoramentoData } from "../../adapters/operacoes";
import type { CssVarsStyle } from "../../kit/css-vars";

export function EngineStrip({ engine, summary, backup }: {
  engine: MonitoramentoData["engine"];
  summary: MonitoramentoData["summary"];
  backup: MonitoramentoData["backup"];
}) {
  const { T } = useDesign();
  const engineTiles: Array<{
    k: string; icon: string; v: string; sub: string;
    ok?: boolean; live?: boolean; mono?: boolean; accentN?: boolean;
  }> = [
    { k: 'Motor', icon: ICONS.heart, v: engine.worker.status, sub: engine.worker.since, ok: engine.worker.ok, live: true },
    { k: 'Banco', icon: ICONS.db, v: engine.banco.status, sub: engine.banco.note, ok: engine.banco.ok },
    { k: 'Último fechamento', icon: ICONS.clock, v: engine.closing.at, sub: engine.closing.note, ok: engine.closing.ok, mono: true },
    { k: 'Sharp pendentes', icon: ICONS.inbox, v: summary?.available === false ? '—' : String(engine.pending.n), sub: engine.pending.note, accentN: true },
  ];

  return (
    <div className={styles.engineGrid}>
      {engineTiles.map((t) => {
        const stateOk = summary?.available === false ? null : t.ok;
        const tone = stateOk ? T.pos : T.neg;
        const tileStyle: CssVarsStyle = {
          '--ops-tone': tone,
          '--ops-value-color': t.accentN ? T.accent : T.text,
        };
        return <OpsCard key={t.k} pad={20} style={tileStyle}>
          <div className={styles.engineLabel}>
            <Icon d={t.icon} s={15} /><Cap>{t.k}</Cap></div>
          <div className={styles.engineValueRow}>
            {(stateOk != null) && <span className={styles.engineState}>
              <span className={styles.engineStateDot} />
              {t.live && <span className={styles.engineStateRing} />}
            </span>}
            <div className={`${styles.engineValue} ${t.mono || t.accentN ? styles.engineValueMono : ''}`}>{t.v}</div>
          </div>
          <div className={styles.engineSub}>{t.sub}</div>
        </OpsCard>
      })}
      <BackupRow backup={backup} />
    </div>
  );
}

/**
 * Faixa que atravessa a grade, e não um quinto cartão: na largura média o
 * valor não caberia. O estado vem escrito além da cor; sem leitura, sem ponto.
 */
function BackupRow({ backup }: { backup: MonitoramentoData["backup"] }) {
  const { T } = useDesign();
  const rowStyle: CssVarsStyle = { '--ops-tone': backup.ok ? T.pos : T.neg };
  return (
    <OpsCard pad={16} className={styles.backupRow} style={rowStyle}>
      <div className={styles.backupLabel}><Icon d={ICONS.export} s={15} /><Cap>Backup do banco</Cap></div>
      <div className={styles.engineValueRow}>
        {backup.ok != null && <span className={styles.engineState}><span className={styles.engineStateDot} /></span>}
        <span className={styles.backupStatus}>{backup.status}</span>
      </div>
      <span className={styles.backupNote}>{backup.note}</span>
    </OpsCard>
  );
}
