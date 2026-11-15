"use client";
// Operações: cockpit do operador.
// "O que exige minha ação agora?" + "O motor está saudável?"
import React from "react";
import dynamic from "next/dynamic";
import { useDesign } from "../kit/context";
import { AppSidebar } from "../AppSidebar";

import { OperacoesHeader } from "./operacoes/header";
import { SettlementCard } from "./operacoes/settlement-card";
import { QueueTabs } from "./operacoes/queue-summary";
import { useOperacoesState } from "./operacoes/use-operacoes-state";
import { AppShell } from "../kit/primitives";
import { opsThemeStyle } from "./operacoes/theme-style";
import styles from "./operacoes/operacoes.module.css";
import type { OperacoesScreenProps } from "../screen-types";

const IaJudgeCard = dynamic(() => import("./operacoes/ia-judge-card").then((module) => module.IaJudgeCard));
const MatchingCard = dynamic(() => import("./operacoes/matching-card").then((module) => module.MatchingCard));
const SharpCard = dynamic(() => import("./operacoes/sharp-card").then((module) => module.SharpCard));

/** A rota só monta a tela com os dados carregados. */
export function OperacoesScreen({ data, canManage = true, onSettle = null, onApproveIaJudge = null, onRejectIaJudge = null, onResolveMatch = null, onIgnoreMatch = null, onRetrySharp = null }: OperacoesScreenProps) {
  const O = data;
  const { T } = useDesign();

  const ops = useOperacoesState(O, {
    onSettle, onApproveIaJudge, onRejectIaJudge, onResolveMatch, onIgnoreMatch, onRetrySharp,
  });

  const themeStyle = opsThemeStyle(T);

  const Sidebar = <AppSidebar active="Operações" />;

  return (
    <AppShell sidebar={Sidebar} style={themeStyle}>
      <div className={`app-main ${styles.main}`}>
        <OperacoesHeader actionCount={ops.actionCount} available={O.available !== false} />
        {O.available === false ? (
          <section className={styles.unavailable} role="alert">
            <div className={styles.unavailableEyebrow}>DADOS INDISPONÍVEIS</div>
            <h2 className={styles.unavailableTitle}>O banco não respondeu</h2>
            <p className={styles.unavailableText}>
              Filas, pendências e incidentes não foram tratados como zero. Tente novamente quando a conexão voltar.
            </p>
          </section>
        ) : (
          <>
            <QueueTabs filas={ops.filas} ativa={ops.filaAtiva} onSelecionar={ops.setFilaAtiva} />
            <div
              className={styles.queuePainel}
              role="tabpanel"
              id={`segmento-painel-${ops.filaAtiva}`}
              aria-labelledby={`segmento-tab-${ops.filaAtiva}`}
            >
              {ops.filaAtiva === 'liquidar' && (
                <SettlementCard pendingSettle={ops.pendingSettle} resolveSettle={ops.resolveSettle} canManage={canManage} />
              )}
              {ops.filaAtiva === 'vincular' && (
                <MatchingCard pendingMatch={ops.pendingMatch} matchingTotal={O.matchingTotal} resolveMatch={ops.resolveMatch} canManage={canManage} />
              )}
              {ops.filaAtiva === 'homologar' && (
                <IaJudgeCard iajList={ops.iajList} iajTotal={ops.iajTotal}
                  handleIajAction={ops.handleIajAction} onApproveIaJudge={onApproveIaJudge} onRejectIaJudge={onRejectIaJudge} canManage={canManage} />
              )}
              {ops.filaAtiva === 'sharp' && (
                <SharpCard pendingSharp={ops.pendingSharp} sharpTotal={O.engine?.pending?.n} retrySharp={ops.retrySharp} canManage={canManage} />
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
