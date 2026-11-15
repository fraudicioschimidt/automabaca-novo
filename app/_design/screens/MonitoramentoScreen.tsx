"use client";

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useDesign } from "../kit/context";
import { AppSidebar } from "../AppSidebar";
import { AppShell } from "../kit/primitives";
import { Skeleton, SkeletonRegiao } from "../kit/Skeleton";
import { EngineStrip } from "./operacoes/engine-strip";
import { MonitoramentoHeader } from "./operacoes/monitoramento-header";
import { opsThemeStyle } from "./operacoes/theme-style";
import styles from "./operacoes/operacoes.module.css";
import { errorMessage, toast } from "../toast";
import type { MonitoramentoScreenProps } from "../screen-types";
import type { JobNaTela } from "./operacoes/jobs-card";

// `dynamic` sem `loading` deixa um vazio até o chunk chegar, e o Monitoramento
// é a tela em que o vazio mente mais: nada na tela lê como "está tudo em ordem"
// justamente onde se procura o que quebrou.
const HealthSection = dynamic(() => import("./operacoes/health-section").then((module) => module.HealthSection), {
  loading: () => (
    <SkeletonRegiao rotulo="Carregando a saúde do sistema…">
      <Skeleton altura={38} raio={10} />
      <div style={{ height: 16 }} />
      <Skeleton altura={190} raio={20} />
    </SkeletonRegiao>
  ),
});

/** A rota só monta a tela com os dados carregados. */
export function MonitoramentoScreen({ data, onReplayJob = null, onAcknowledgeAction = null, onResolveAction = null, onRetryChannelTransient = null, onCaptureDiscardedPost = null }: MonitoramentoScreenProps) {
  const { T } = useDesign();

  const [jobs, setJobs] = useState<JobNaTela[]>(() => data.jobs.map((job) => ({ ...job, replayed: false, replaying: false })));

  useEffect(() => {
    setJobs(data.jobs.map((job) => ({ ...job, replayed: false, replaying: false })));
  }, [data]);

  const setReplayState = (id: string, patch: Partial<Pick<JobNaTela, "replayed" | "replaying">>) => setJobs((current) => current.map((job) => (
    job.id === id ? { ...job, ...patch } : job
  )));

  const replayJob = async (grupoId: string, jobIds: string[]) => {
    if (!Array.isArray(jobIds) || jobIds.length === 0) return;
    setReplayState(grupoId, { replaying: true });
    try {
      const result = onReplayJob
        ? await onReplayJob(jobIds)
        : { replayed: jobIds.length, alreadyGone: 0, failures: 0 };
      if (result.failures > 0) {
        setReplayState(grupoId, { replaying: false });
        toast(`Replay parcial: ${result.replayed} reenfileirado${result.replayed === 1 ? '' : 's'}, ${result.alreadyGone} já ausente${result.alreadyGone === 1 ? '' : 's'}, ${result.failures} falha${result.failures === 1 ? '' : 's'}`, 'warn');
        return;
      }
      setReplayState(grupoId, { replayed: true, replaying: false });
      if (result.replayed === 0 && result.alreadyGone > 0) {
        toast(`${result.alreadyGone} job${result.alreadyGone === 1 ? '' : 's'} já não estava${result.alreadyGone === 1 ? '' : 'm'} na fila`, 'ok');
      } else if (result.alreadyGone > 0) {
        toast(`${result.replayed} reenfileirado${result.replayed === 1 ? '' : 's'} · ${result.alreadyGone} já ausente${result.alreadyGone === 1 ? '' : 's'}`, 'ok');
      } else {
        toast(`${result.replayed} job${result.replayed === 1 ? '' : 's'} reenfileirado${result.replayed === 1 ? '' : 's'}`, 'ok');
      }
    } catch (error) {
      setReplayState(grupoId, { replayed: false, replaying: false });
      toast(errorMessage(error, 'Falha no replay'), 'warn');
    }
  };

  const themeStyle = opsThemeStyle(T);
  const sidebar = <AppSidebar active="Monitoramento" />;

  return (
    <AppShell sidebar={sidebar} style={themeStyle}>
      <div className={`app-main ${styles.main}`}>
        <MonitoramentoHeader summary={data.summary} />
        <EngineStrip engine={data.engine} summary={data.summary} backup={data.backup} />
        <HealthSection
          data={data}
          jobs={jobs}
          replayJob={replayJob}
          onAcknowledgeAction={onAcknowledgeAction}
          onResolveAction={onResolveAction}
          onRetryChannelTransient={onRetryChannelTransient}
          onCaptureDiscardedPost={onCaptureDiscardedPost}
        />
      </div>
    </AppShell>
  );
}
