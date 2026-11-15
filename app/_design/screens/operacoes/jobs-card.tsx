import Link from "next/link";
import { useState } from "react";
import { useDesign } from "../../kit/context";
import { Btn } from "../../kit/primitives";
import { ModalForm } from "../../kit/ModalForm";
import { contagem } from "../../lib/plural";
import { FALHAS_DE_JOB_JANELA_DIAS, textoDoRecorte } from "@/src/domain/recorte-de-lista";
import { OpsCard } from "./ui-primitives";
import styles from "./operacoes.module.css";
import { ICONS, Icon } from "../../kit/icons";
import type { MonitoramentoData } from "../../adapters/operacoes";
import type { CssVarsStyle } from "../../kit/css-vars";

/** O incidente com o estado do replay que a tela acompanha enquanto a ação roda. */
export type JobNaTela = MonitoramentoData["jobs"][number] & { replayed?: boolean; replaying?: boolean };

/**
 * Falhas de job agrupadas por INCIDENTE, com causa e próxima etapa: várias
 * falhas do mesmo diagnóstico são um problema só, e o Replay sem causa é tiro
 * no escuro.
 *
 * O botão obedece ao `provider_circuits` ao vivo: `circuito_aberto` que ainda
 * está aberto desabilita com o motivo ao lado; se já fechou, habilita.
 */
export function JobsCard({ jobs = [], jobsTotal, available, replayJob }: {
  jobs?: JobNaTela[];
  jobsTotal?: number;
  available: boolean;
  replayJob: (grupoId: string, jobIds: string[]) => unknown;
}) {
  const { T, numFont } = useDesign();
  const [aberto, setAberto] = useState<string | null>(null);
  const [preview, setPreview] = useState<Pick<JobNaTela, "id" | "name" | "causa" | "n" | "replayJobIds" | "bets"> | null>(null);
  const mostradas = jobs.reduce((n, j) => n + (j.n ?? 0), 0);
  const total = typeof jobsTotal === "number" && Number.isFinite(jobsTotal) ? jobsTotal : mostradas;
  const janela = `retidas e últimos ${FALHAS_DE_JOB_JANELA_DIAS} dias`;
  const recorte = textoDoRecorte(mostradas, total, janela);
  const vazio = available && total === 0;
  const confirmarReplay = () => {
    if (!preview) return;
    replayJob(preview.id, preview.replayJobIds);
    setPreview(null);
  };
  return (
    <>
    <OpsCard pad={0} className={styles.jobsCard}>
      <div className={styles.jobsHeader}>
        <h3 className={styles.cardTitle}>Falhas de jobs</h3>
        <div className={styles.cardSubtitle}>{janela} · agrupadas por causa</div>
      </div>
      <div role="region" aria-label="Falhas recentes" tabIndex={0} className={styles.jobsList}>
        {!available ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>Leitura da fila indisponível</div>
            <div className={styles.emptyText}>Não foi possível consultar as falhas agora. O estado não foi tratado como vazio.</div>
          </div>
        ) : null}
        {vazio ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>Nenhuma falha recente</div>
            <div className={styles.emptyText}>Nada retido na dead-letter, e nenhuma falha nos últimos {FALHAS_DE_JOB_JANELA_DIAS} dias.</div>
          </div>
        ) : null}
        {available && jobs.map((j) => {
          const bloqueado = j.replay && !j.replayHabilitado;
          const expansivel = j.bets?.length > 0;
          const expandido = aberto === j.id;
          const jobStyle: CssVarsStyle = { '--ops-tone': T.neg, '--ops-job-status': T.neg };
          return (
            <div key={j.id} className={styles.jobRow} style={jobStyle}>
              <div className={styles.jobHead}>
                <span className={styles.jobDot} />
                <span className={styles.jobName}>{j.name}</span>
                <span className={styles.jobStatus}>
                  {j.causa} <span className={styles.textFaint}>·</span> <span className={styles.mono} style={numFont}>{j.at}</span>
                </span>
                {j.n > 1 ? <span className={styles.jobCount}>{contagem(j.n, 'falha')}</span> : null}
                {j.replay && (j.replayed
                  ? <span className={styles.jobQueued}><Icon d={ICONS.check} s={13} w={2} />enfileirado</span>
                  : j.replaying
                    ? <span className={styles.jobQueued}>enfileirando…</span>
                  : (
                    <Btn kind="soft" size="sm" icon={ICONS.replay} disabled={bloqueado || j.replaying}
                      onClick={bloqueado ? undefined : () => setPreview({
                        id: j.id,
                        name: j.name,
                        causa: j.causa,
                        n: j.n,
                        replayJobIds: j.replayJobIds ?? [],
                        bets: j.bets ?? [],
                      })}>Replay</Btn>
                  ))}
              </div>
              {/* A próxima etapa é a razão de o cartão existir: sem ela a causa
                  vira rótulo, e o operador continua sem saber o que fazer. */}
              <div className={styles.jobNext}>{j.motivoBloqueio ?? j.proximaEtapa}</div>
              {expansivel ? (
                <>
                  <button type="button" className={styles.jobToggle}
                    aria-expanded={expandido}
                    onClick={() => setAberto(expandido ? null : j.id)}>
                    {expandido ? 'Ocultar' : 'Ver'} {contagem(j.bets.length, 'aposta')} afetada{j.bets.length === 1 ? '' : 's'}
                  </button>
                  {expandido ? (
                    <ul className={styles.jobBets}>
                      {j.bets.map((betId) => (
                        <li key={betId}><Link href={`/aposta?id=${betId}`} prefetch={false} className={styles.mono} style={numFont}>{betId.slice(0, 8)}</Link></li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      {available && recorte ? <div className={styles.backlogFooter}>{recorte}</div> : null}
    </OpsCard>
    {preview ? (
      <ModalForm
        onClose={() => setPreview(null)}
        title="Replay da falha"
        sub={`${preview.name} · ${contagem(preview.replayJobIds.length || preview.n, 'job')}`}
        submitLabel={`Reenfileirar ${contagem(preview.replayJobIds.length || preview.n, 'job')}`}
        onSubmit={confirmarReplay}
      >
        <div style={{ fontSize: 13.5, lineHeight: 1.6, color: T.textMuted }}>
          A falha permanece na dead-letter até revisão e preview do replay.
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.55, color: T.text }}>
          <div><b>Causa:</b> {preview.causa}</div>
          <div style={{ marginTop: 8, color: T.textMuted, fontFamily: T.font.num, fontSize: 12.5 }}>
            {preview.replayJobIds.slice(0, 8).join(', ')}
            {preview.replayJobIds.length > 8 ? ` · +${preview.replayJobIds.length - 8}` : ''}
          </div>
        </div>
      </ModalForm>
    ) : null}
    </>
  );
}
