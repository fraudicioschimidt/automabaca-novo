import { ModalForm } from "../../kit/ModalForm";
import { useDesign } from "../../kit/context";
import { contagem, plural } from "../../lib/plural";
import { fmtBrl, fmtU, fmtUnit } from "@/src/domain/formato-de-resultado";
import type { BatchRemovalPlan } from "@/src/services/bets/remove";

/** Quantas apostas a confirmação lista por nome antes de resumir o resto. */
const LISTED = 8;

/**
 * A confirmação mostra o que o servidor vai fazer, não o que foi marcado: as
 * do mesmo post entram, a liquidada há mais de 7 dias fica de fora, e o valor
 * é o da stake e do resultado que o estorno desfaz. `changed` é o motivo de o
 * servidor ter recusado a confirmação anterior (o lote mudou); a prévia já é
 * a de agora.
 */
export function BatchRemovalConfirm({ plan, changed = null, busy, onConfirm, onClose }: {
  plan: BatchRemovalPlan;
  changed?: string | null;
  busy: boolean;
  onConfirm: () => unknown;
  onClose: () => void;
}) {
  const { T } = useDesign();
  const n = plan.remove.length;
  const listed = plan.remove.slice(0, LISTED);
  const text = { fontSize: 13.5, lineHeight: 1.6, color: T.textMuted, margin: 0 } as const;
  return (
    <ModalForm
      onClose={onClose}
      onSubmit={onConfirm}
      title="Remover apostas"
      sub={`${contagem(n, "aposta")} · ${fmtUnit(plan.stakeUnits)} de stake (${fmtBrl(plan.stakeReais)})`}
      submitLabel={n > 0 ? `Remover ${n}` : "Mandar para revisão"}
      submitTone="neg"
      canSubmit={n > 0 || plan.review.length > 0}
      pending={busy}
      width={520}
    >
      {changed ? (
        <div role="alert" style={{ padding: '11px 14px', borderRadius: T.radiusSm, background: T.negSoft, fontSize: 13, lineHeight: 1.55, color: T.text }}>
          {changed}
        </div>
      ) : null}
      <p style={text}>
        Sai como no 👎: o resultado das liquidadas é estornado da conta, e as apostas voltam pelo Desfazer ou pela aba Removidas.
      </p>
      {plan.fromSamePost > 0 ? (
        <p style={text}>Inclui {contagem(plan.fromSamePost, "aposta")} do mesmo post das marcadas: o post sai inteiro.</p>
      ) : null}
      {plan.resultUnits !== 0 ? (
        <p style={text}>Resultado estornado: <b style={{ color: T.text }}>{fmtU(plan.resultUnits)}</b> ({fmtBrl(plan.resultReais, true)}).</p>
      ) : null}
      {n > 0 ? (
        <ul aria-label="Apostas que saem" style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: T.text, lineHeight: 1.6 }}>
          {listed.map((bet) => <li key={bet.id}>{bet.evento} — {bet.selecao} · {fmtUnit(bet.stake)}</li>)}
          {n > listed.length ? <li style={{ color: T.textMuted }}>e mais {n - listed.length}</li> : null}
        </ul>
      ) : null}
      {plan.review.length > 0 ? (
        <div role="note" style={{ padding: "11px 14px", borderRadius: T.radiusSm, background: T.surface2, fontSize: 13, lineHeight: 1.55, color: T.text }}>
          <b>{contagem(plan.review.length, "aposta")} {plural(plan.review.length, "fica", "ficam")} de fora</b>: liquidada{plan.review.length === 1 ? "" : "s"} há mais de 7 dias, como no 👎, {plural(plan.review.length, "vira", "viram")} revisão em Monitoramento.
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {plan.review.map((bet) => <li key={bet.id}>{bet.evento} — {bet.selecao}</li>)}
          </ul>
        </div>
      ) : null}
      {plan.missing > 0 ? (
        <p style={text}>{contagem(plan.missing, "aposta")} {plural(plan.missing, "marcada")} já não {plural(plan.missing, "está", "estão")} na lista do tipster.</p>
      ) : null}
    </ModalForm>
  );
}
