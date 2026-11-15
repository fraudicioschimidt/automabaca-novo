import { useRef, useState } from "react";
import { ModalForm } from "../../kit/ModalForm";
import { useDesign } from "../../kit/context";
import { textoDoRecorte } from "@/src/domain/recorte-de-lista";
import { contagem } from "../../lib/plural";
import styles from "./security-card.module.css";
import { toast, type ToastKind } from "../../toast";
import { ConfigCard } from "./ui-primitives";
import type { ConfigData } from "./types";

type Session = ConfigData["security"]["sessions"][number];
/** O mock não informa o total: sem ele, vale o tamanho da lista. */
type Security = { username?: string; sessionsTotal?: number; sessions?: Session[] };

export function SecurityCard({ security, onRevokeSession, onRevokeOtherSessions }: {
  security?: Security | null;
  onRevokeSession?: ((id: string) => Promise<unknown>) | null;
  onRevokeOtherSessions?: (() => Promise<{ count: number }>) | null;
}) {
  const { T } = useDesign();
  const [sessions, setSessions] = useState<Session[]>(security?.sessions || []);
  const [sessionsTotal, setSessionsTotal] = useState(
    security?.sessionsTotal != null && Number.isFinite(security.sessionsTotal) ? security.sessionsTotal : sessions.length,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [confirmarOutras, setConfirmarOutras] = useState(false);
  // Mostra a atual + as mais recentes; o resto fica atrás de um clique, para
  // a lista não alongar a página.
  const [verTodas, setVerTodas] = useState(false);
  const VISIVEIS = 5;
  const visiveis = verTodas ? sessions : sessions.slice(0, VISIVEIS);
  const ocultas = sessions.length - visiveis.length;
  const outrasTotal = Math.max(0, sessionsTotal - sessions.filter((session) => session.current).length);
  const recorte = textoDoRecorte(sessions.length, sessionsTotal);

  const notify = (message: string, kind: ToastKind = 'ok') => { toast(message, kind); };
  const revoke = async (session: Session) => {
    if (!onRevokeSession || session.current || inFlight.current) return;
    inFlight.current = true;
    setBusy(session.id);
    try {
      await onRevokeSession(session.id);
      setSessions((rows) => rows.filter((row) => row.id !== session.id));
      setSessionsTotal((total) => Math.max(0, total - 1));
      notify('Sessão revogada');
    }
    catch (error) { notify(error instanceof Error ? error.message : 'Falha ao revogar sessão', 'warn'); }
    finally { inFlight.current = false; setBusy(null); }
  };
  const revokeOthers = async () => {
    if (!onRevokeOtherSessions || inFlight.current) return;
    inFlight.current = true;
    setBusy('others');
    try {
      const result = await onRevokeOtherSessions();
      setSessions((rows) => rows.filter((row) => row.current));
      setSessionsTotal((total) => Math.max(0, total - result.count));
      notify(`${result.count} ${result.count === 1 ? 'outra sessão revogada' : 'outras sessões revogadas'}`);
    } catch (error) { notify(error instanceof Error ? error.message : 'Falha ao revogar sessões', 'warn'); }
    finally { inFlight.current = false; setBusy(null); }
  };

  return (
    <ConfigCard pad={0} style={{ marginBottom: 22 }}>
      <div className={styles.header}>
        <div><h2 className={styles.title}>Segurança da conta</h2><div className={styles.subtitle}>Sessões ativas de {security?.username ?? "operador"}</div></div>
        <span className={styles.status}>Sessão por dispositivo</span>
      </div>
      <div className={styles.body}>
        <section className={styles.section}>
          <div className={styles.sessionsHeader}>
            <div><h3 className={styles.sectionTitle}>Sessões ativas</h3><div className={styles.help}>{recorte ?? `${sessionsTotal} dispositivo${sessionsTotal === 1 ? '' : 's'} autorizado${sessionsTotal === 1 ? '' : 's'}`}</div></div>
            {outrasTotal > 0 && onRevokeOtherSessions ? <button type="button" disabled={busy !== null} onClick={() => setConfirmarOutras(true)} className={`${styles.button} ${styles.danger}`}>Revogar outras</button> : null}
          </div>
          {sessions.length === 0 ? <div className={styles.empty}>A sessão atual é legada; ela será individualizada no próximo login.</div> : null}
          {visiveis.map((session, index) => (
            <div key={session.id} className={`${styles.sessionRow} ${index ? styles.withBorder : ''}`}>
              <div aria-hidden="true" className={`${styles.avatar} ${session.current ? styles.currentAvatar : ''}`}>{session.deviceName.slice(0, 1)}</div>
              <div className={styles.sessionContent}>
                <div className={styles.sessionTitle}>{session.deviceName}{session.current ? <span className={styles.currentBadge}>ESTA SESSÃO</span> : null}</div>
                <div className={styles.meta}>Último uso {session.lastSeenAt} · criada {session.createdAt}</div>
              </div>
              {!session.current && onRevokeSession ? <button type="button" disabled={busy !== null} onClick={() => revoke(session)} className={`${styles.button} ${styles.danger}`}>Revogar</button> : null}
            </div>
          ))}
          {ocultas > 0 ? (
            <button type="button" onClick={() => setVerTodas(true)} className={styles.showAll}>
              Ver mais {contagem(ocultas, 'sessão', 'sessões')}
            </button>
          ) : null}
          {verTodas && sessions.length > VISIVEIS ? (
            <button type="button" onClick={() => setVerTodas(false)} className={styles.showAll}>
              Mostrar menos
            </button>
          ) : null}
        </section>
      </div>
      {confirmarOutras ? (
        <ModalForm
          onClose={() => setConfirmarOutras(false)}
          title="Revogar outras sessões"
          sub={`${contagem(outrasTotal, 'sessão', 'sessões')} fora desta`}
          submitLabel="Confirmar revogação"
          submitTone="neg"
          onSubmit={() => { setConfirmarOutras(false); return revokeOthers(); }}
        >
          <div style={{ fontSize: 13.5, lineHeight: 1.6, color: T.textMuted }}>
            Isto revoga {contagem(outrasTotal, 'sessão', 'sessões')} — o universo ativo, não só as linhas visíveis nesta lista. A sessão atual permanece.
          </div>
        </ModalForm>
      ) : null}
    </ConfigCard>
  );
}
