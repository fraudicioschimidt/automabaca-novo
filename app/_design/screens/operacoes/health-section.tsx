import { useState, type ComponentProps } from "react";
import { BudgetsCard } from "./budgets-card";
import { ChannelsCard } from "./channels-card";
import { ActionsCard } from "./actions-card";
import { JobsCard } from "./jobs-card";
import { NoOddsCard } from "./no-odds-card";
import { ReliquidacaoCard } from "./reliquidacao-card";
import { ObservabilityCard } from "./observability-card";
import { OcrModelsCard } from "./ocr-models-card";
import { ProbationCard } from "./probation-card";
import { ReleasesCard } from "./releases-card";
import { SegmentNav } from "../../kit/SegmentNav";
import { SEGMENTOS_DO_MONITORAMENTO } from "../../lib/segmentos-de-secao";
import styles from "./operacoes.module.css";
import type { MonitoramentoActions } from "../../action-contracts";
import type { MonitoramentoData } from "../../adapters/operacoes";
import type { JobNaTela } from "./jobs-card";

/**
 * Monitoramento em seções, cada uma pela PERGUNTA que responde, não pela
 * tabela de origem: o que quebrou (incidentes), quão bem está indo
 * (desempenho), o que pode faltar amanhã (providers/canais) e o insumo de
 * manutenção, fora do caminho diário porque o dono delega manutenção.
 */
export function HealthSection({
  data,
  jobs,
  replayJob,
  onAcknowledgeAction,
  onResolveAction,
  onRetryChannelTransient,
  onCaptureDiscardedPost,
}: Pick<MonitoramentoActions, "onAcknowledgeAction" | "onResolveAction" | "onRetryChannelTransient" | "onCaptureDiscardedPost"> & {
  data: MonitoramentoData;
  jobs: JobNaTela[];
  replayJob: ComponentProps<typeof JobsCard>["replayJob"];
}) {
  // Quais seções existem e o que o número de cada uma conta vive no registro
  // (`lib/segmentos-de-secao`) — aqui só chegam os números do momento.
  const segmentos = SEGMENTOS_DO_MONITORAMENTO;

  // O hook fica ANTES do retorno antecipado: quando a leitura sai de
  // "unavailable" para disponível, o número de hooks não pode mudar entre
  // renders. O inicializador preguiçoso só roda uma vez.
  // Desempenho conta o SLO violado e a release com erro novo das últimas 24 h.
  const performanceAlerts = (data.slo || []).filter((r) => r.status === "breach").length + data.releasesFlagged24h;
  const [ativo, setAtivo] = useState<string>(() => {
    const iniciais: Record<string, number> = {
      incidentes: data.summary?.actionableTotal ?? 0,
      desempenho: performanceAlerts,
      canais: data.summary?.degradedChannelTotal ?? 0,
    };
    return (segmentos.find((s) => (iniciais[s.id] ?? 0) > 0) ?? segmentos[0]).id;
  });

  if (data.summary?.state === "unavailable") {
    return <div className={styles.manutencaoNota} role="status">
      Leitura do Monitoramento indisponível. Totais vazios não representam ausência de incidentes.
    </div>;
  }
  const acionaveis = data.summary?.actionableTotal ?? 0;
  const canaisRuins = data.summary?.degradedChannelTotal ?? 0;
  const contagens = { incidentes: acionaveis, desempenho: performanceAlerts, canais: canaisRuins };

  return (
    <>
      <SegmentNav segmentos={segmentos} contagens={contagens} ativo={ativo} onSelecionar={setAtivo} rotulo="Seções do monitoramento" />
      <div
        className={styles.queuePainel}
        role="tabpanel"
        id={`segmento-painel-${ativo}`}
        aria-labelledby={`segmento-tab-${ativo}`}
      >
        {ativo === "incidentes" && (
          <ActionsCard actions={data.actions} actionTotals={data.actionTotals} available={data.summary?.available !== false} onAcknowledge={onAcknowledgeAction} onResolve={onResolveAction} />
        )}
        {ativo === "desempenho" && (
          <>
            <ObservabilityCard rows={data.slo || []} />
            <ReleasesCard releases={data.releases} />
          </>
        )}
        {ativo === "ocr" && <OcrModelsCard report={data.ocrModels} />}
        {ativo === "providers" && (
          <>
            <BudgetsCard budgets={data.budgets} />
            <ProbationCard segments={data.probation || []} />
          </>
        )}
        {ativo === "canais" && (
          <ChannelsCard channels={data.channels} orphanChannels={data.orphanChannels || []} orphanChannelsTotal={data.orphanChannelsTotal} onRetryTransient={onRetryChannelTransient} onCaptureDiscarded={onCaptureDiscardedPost} />
        )}
        {ativo === "manutencao" && (
          <>
            <p className={styles.manutencaoNota}>
              Insumo de quem conserta, não decisão de operação. Fila morta e lacuna de
              cobertura ficam aqui para você apontar quando pedir manutenção — o que exige
              a sua decisão aparece em <b>Incidentes</b>.
            </p>
            <div className={styles.healthGrid}>
              <JobsCard jobs={jobs} jobsTotal={data.jobsTotal} available={data.jobsAvailable !== false} replayJob={replayJob} />
              <NoOddsCard noOdds={data.noOdds} />
              <ReliquidacaoCard reliquidacao={data.reliquidacao} />
            </div>
          </>
        )}
      </div>
    </>
  );
}
