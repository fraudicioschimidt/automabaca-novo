import { fmtOdds, fmtUnit } from "@/src/domain/formato-de-resultado";
import { useState } from "react";
import { useDesign } from "../../kit/context";
import { ModalForm } from "../../kit/ModalForm";
import { Match } from "./ui-primitives";
import styles from "./ia-judge-card.module.css";
import { IA_JUDGE_KEY } from "../../lib/atalhos";
import { FocusOption, FocusQueue, useFocusQueue } from "./focus-queue";
import foco from "./focus-queue.module.css";
import type { OperacoesActions } from "../../action-contracts";
import type { useOperacoesState } from "./use-operacoes-state";
import type { CssVarsStyle } from "../../kit/css-vars";

type OperacoesState = ReturnType<typeof useOperacoesState>;
type Suggestion = OperacoesState["iajList"][number];

const STATUS_LABEL: Record<string, string> = { WON: 'GANHA', LOST: 'PERDIDA', HALF_WON: 'MEIA GANHA', HALF_LOST: 'MEIA PERDIDA', VOID: 'REEMBOLSO' };
const statusLabelOf = (s: Suggestion) => STATUS_LABEL[s.suggestedStatus] || s.suggestedStatus;

/**
 * Fila Homologar em modo foco: a sugestão do IA-Judge com a evidência, e as
 * opções Aprovar e Rejeitar. Aprovar liquida a aposta, então pede a
 * confirmação; rejeitar não mexe no ledger e sai direto.
 */
export function IaJudgeCard({
  iajList, iajTotal, handleIajAction, onApproveIaJudge, onRejectIaJudge, canManage,
}: Pick<OperacoesState, "iajList" | "iajTotal" | "handleIajAction">
  & Pick<OperacoesActions, "onApproveIaJudge" | "onRejectIaJudge"> & {
  canManage: boolean;
}) {
  const { T } = useDesign();
  const queue = useFocusQueue(iajList, iajTotal);
  const [approval, setApproval] = useState<Suggestion | null>(null);
  const toneOf = (s: Suggestion) => {
    const won = s.suggestedStatus === 'WON' || s.suggestedStatus === 'HALF_WON';
    const lost = s.suggestedStatus === 'LOST' || s.suggestedStatus === 'HALF_LOST';
    return { tone: won ? T.pos : lost ? T.neg : T.accent, soft: won ? T.posSoft : lost ? T.negSoft : T.accentSoft };
  };
  const reject = (s: Suggestion) => queue.resolve(s, () => handleIajAction(s.id, onRejectIaJudge));
  const confirmApproval = () => {
    if (!approval) return;
    const s = approval;
    setApproval(null);
    queue.resolve(s, () => handleIajAction(s.id, onApproveIaJudge));
  };

  return (
    <>
      <FocusQueue
        queue={queue}
        title="Sugestões do IA-Judge"
        subtitle="Sugestões com a evidência do resultado — você confere e homologa."
        emptyText="Nenhuma sugestão do IA-Judge aguardando decisão."
        announce={(s) => `${s.home} contra ${s.away}, sugerido ${statusLabelOf(s)}`}
        hints={() => (canManage
          ? [{ keys: [IA_JUDGE_KEY.approve.toUpperCase()], label: "aprovar" }, { keys: [IA_JUDGE_KEY.reject.toUpperCase()], label: "rejeitar" }]
          : [])}
        onKey={(s, key) => {
          if (!canManage) return undefined;
          if (key.toLowerCase() === IA_JUDGE_KEY.approve) return () => setApproval(s);
          if (key.toLowerCase() === IA_JUDGE_KEY.reject) return () => reject(s);
          return undefined;
        }}
        renderCase={(s) => {
          const { tone, soft } = toneOf(s);
          const statusStyle: CssVarsStyle = { '--mc-tone': tone, '--mc-tone-soft': soft };
          return (
            <>
              <span className={`${foco.reason} ${foco.reasonToned}`} style={statusStyle}>
                <span className={foco.reasonDot} aria-hidden="true" />Sugerido: {statusLabelOf(s)} · {s.ruleBased ? "Regra sobre os dados do FlashScore" : `confiança da IA ${Math.round(s.confidence * 100)}%`}
              </span>
              <h4 className={foco.event}><Match home={s.home} away={s.away} /></h4>
              <div className={foco.bet}>
                <b className={foco.market}>{s.market}</b>
                <span className={foco.sep}>·</span>{s.pick}
                <span className={foco.sep}>·</span><span className={foco.figure}>{fmtOdds(s.odds)}</span>
                <span className={foco.sep}>·</span><span className={foco.figure}>{fmtUnit(s.stake)}</span>
              </div>
              <div className={foco.context}>{[s.region, s.started ? `começou ${s.started}` : null].filter(Boolean).join(" · ")}</div>
              <div className={foco.evidence}>
                <div className={foco.evidenceHead}>
                  <span>{s.fromFlashscore ? "Dados do FlashScore" : "Encontrado"}: &quot;{s.valueFound}&quot;</span>
                  {s.sourceUrl ? (
                    <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer" className={foco.sourceLink}>Ver fonte</a>
                  ) : null}
                </div>
                <div className={foco.evidenceText}>{s.reason}</div>
                <div className={foco.evidenceMeta}>Gerado em {s.at} · {s.ruleBased ? "regra do FlashScore" : s.provider.toUpperCase()}</div>
              </div>
            </>
          );
        }}
        renderOptions={(s) => (
          <>
            <FocusOption shortcut={canManage ? IA_JUDGE_KEY.approve : undefined} tone={toneOf(s).tone} disabled={!canManage}
              title={`Aprovar como ${statusLabelOf(s)}`} sub="Liquida a aposta com este resultado; pede confirmação."
              onChoose={() => setApproval(s)} />
            <FocusOption shortcut={canManage ? IA_JUDGE_KEY.reject : undefined} disabled={!canManage}
              title="Rejeitar a sugestão" sub="A aposta continua pendente, sem mexer no ledger."
              onChoose={() => reject(s)} />
          </>
        )}
      />
      {canManage && approval ? (
        <ModalForm
          onClose={() => setApproval(null)}
          title="Homologar resultado"
          sub={`${approval.home} vs ${approval.away}`}
          submitLabel={`Aprovar como ${statusLabelOf(approval)}`}
          submitTone={statusLabelOf(approval).includes('PERDIDA') ? 'neg' : undefined}
          onSubmit={confirmApproval}
        >
          <div className={styles.confirmCopy}>
            A sugestão será homologada como <b>{statusLabelOf(approval)}</b>. Esta ação liquida a aposta e altera o ledger da conta vinculada; o resultado poderá ser corrigido depois pelo histórico do tipster.
          </div>
        </ModalForm>
      ) : null}
    </>
  );
}
