import { useState, type ReactNode } from "react";
import { useDesign } from "../../kit/context";
import { ModalForm } from "../../kit/ModalForm";
import { Match } from "./ui-primitives";
import { ICONS, Icon } from "../../kit/icons";
import { FocusOption, FocusQueue, useFocusQueue } from "./focus-queue";
import foco from "./focus-queue.module.css";
import type { useOperacoesState } from "./use-operacoes-state";
import { fmtOdds, fmtUnit } from "@/src/domain/formato-de-resultado";

type OperacoesState = ReturnType<typeof useOperacoesState>;
type Bet = OperacoesState["pendingSettle"][number];
type Outcome = Parameters<OperacoesState["resolveSettle"]>[1];

/**
 * Os resultados, na ordem das opções. `meia` só vale na linha asiática
 * fracionária (a liquidação recusa ½ fora dela).
 */
const RESULTADOS: ReadonlyArray<{
  result: Outcome;
  rotulo: string;
  meia: boolean;
  /** Cor do ponto da opção, dos `--ops-*` da tela. */
  tone: string;
  /** O sinal na caixa da opção: sem tecla, a caixa diz o resultado. */
  marker: ReactNode;
}> = [
  { result: "won", rotulo: "Ganhou", meia: false, tone: "var(--ops-pos)", marker: <Icon d={ICONS.check} s={13} w={2} /> },
  { result: "half_won", rotulo: "½ ganha", meia: true, tone: "color-mix(in srgb, var(--ops-pos) 50%, transparent)", marker: "½" },
  { result: "lost", rotulo: "Perdeu", meia: false, tone: "var(--ops-neg)", marker: <Icon d={ICONS.close} s={12} w={2} /> },
  { result: "half_lost", rotulo: "½ perda", meia: true, tone: "color-mix(in srgb, var(--ops-neg) 50%, transparent)", marker: "½" },
  { result: "void", rotulo: "Reembolso", meia: false, tone: "var(--ops-faint)", marker: <Icon d={ICONS.replay} s={13} w={1.8} /> },
];

const rotuloDe = (result: Outcome) => RESULTADOS.find((r) => r.result === result)!.rotulo.toLowerCase();
const optionsFor = (s: Bet) => RESULTADOS.filter((r) => s.allowsHalfResult || !r.meia);

/**
 * Fila Liquidar em modo foco: os resultados que o mercado permite são as
 * opções. Liquidar é só no clique, e pede a confirmação porque mexe no ledger; confirmado, o caso sai e o próximo entra. O desfazer do toast o traz
 * de volta.
 */
export function SettlementCard({ pendingSettle, resolveSettle, canManage }: Pick<OperacoesState, "pendingSettle" | "resolveSettle"> & {
  canManage: boolean;
}) {
  const { T } = useDesign();
  const queue = useFocusQueue(pendingSettle);
  const [request, setRequest] = useState<{ bet: Bet; result: Outcome } | null>(null);
  const confirm = () => {
    if (!request) return;
    const { bet, result } = request;
    setRequest(null);
    queue.resolve(bet, () => resolveSettle(bet.id, result, () => queue.restore(bet.id)));
  };

  return (
    <>
      <FocusQueue
        queue={queue}
        title="Liquidação manual"
        subtitle="O automático não liquidou estas apostas. Marque o resultado de cada uma."
        emptyText="Nenhuma aposta esperando liquidação manual."
        announce={(s) => `${s.home} contra ${s.away}`}
        // Sem tecla de resultado, por decisão do dono: liquidar é só no clique.
        hints={() => []}
        onKey={() => undefined}
        renderCase={(s) => (
          <>
            <span className={foco.reason}><span className={foco.reasonDot} aria-hidden="true" />{s.reason}</span>
            <h4 className={foco.event}><Match home={s.home} away={s.away} /></h4>
            {/* A APOSTA primeiro (mercado, seleção, preço), a procedência depois
                em tom menor; tipster e autor da tip iguais aparecem uma vez só. */}
            <div className={foco.bet}>
              <b className={foco.market}>{s.market}</b>
              <span className={foco.sep}>·</span>{s.pick}
              <span className={foco.sep}>·</span><span className={foco.figure}>{fmtOdds(s.odds)}</span>
              <span className={foco.sep}>·</span><span className={foco.figure}>{fmtUnit(s.stake)}</span>
            </div>
            <div className={foco.context}>
              {[s.when, s.bankrollNome, s.bankrollNome === s.tipster ? null : s.tipster, s.region].filter(Boolean).join(" · ")}
            </div>
          </>
        )}
        renderOptions={(s) => optionsFor(s).map((r) => (
          <FocusOption key={r.result} marker={r.marker} tone={r.tone}
            title={r.rotulo} disabled={!canManage} onChoose={() => setRequest({ bet: s, result: r.result })} />
        ))}
      />
      {canManage && request ? (
        <ModalForm
          onClose={() => setRequest(null)}
          title="Liquidar aposta"
          sub={`${request.bet.home} vs ${request.bet.away} · ${rotuloDe(request.result)}`}
          submitLabel={`Confirmar ${rotuloDe(request.result)}`}
          submitTone={request.result === "lost" || request.result === "half_lost" ? "neg" : undefined}
          onSubmit={confirm}
        >
          <div style={{ fontSize: 13.5, lineHeight: 1.6, color: T.textMuted }}>
            Esta ação marca a aposta como <b>{rotuloDe(request.result)}</b> e altera o ledger da conta vinculada. O resultado poderá ser corrigido depois pelo histórico do tipster.
          </div>
        </ModalForm>
      ) : null}
    </>
  );
}
