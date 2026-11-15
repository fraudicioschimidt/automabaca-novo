import { useDesign } from "../../kit/context";
import { Btn } from "../../kit/primitives";
import { CADENCIA_PERTO_MS } from "@/src/domain/enrich-cadence";
import { plural } from "../../lib/plural";
import { SHARP_KEY } from "../../lib/atalhos";
import { Match } from "./ui-primitives";
import { FocusOption, FocusQueue, useFocusQueue } from "./focus-queue";
import foco from "./focus-queue.module.css";
import { ICONS, Icon } from "../../kit/icons";
import type { useOperacoesState } from "./use-operacoes-state";
import type { CssVarsStyle } from "../../kit/css-vars";

type OperacoesState = ReturnType<typeof useOperacoesState>;

function minutos(ms: number) {
  return String(ms / 60_000).replace('.', ',');
}

export function sharpCadenceLabel() {
  return `CAÇA AUTOMÁTICA PERTO DO KICKOFF: a cada ${minutos(CADENCIA_PERTO_MS)} MIN`;
}

type SharpRow = OperacoesState["pendingSharp"][number];

/**
 * A aba Sharp conta, e o "Reprocessar estas" alcança, a sem par que não está em
 * Vincular. A que aguarda a linha abrir o motor re-tenta sozinho; a sem par com
 * caso de treino não volta sozinha, e o operador a resolve em Vincular. As duas
 * ficam na fila, depois do trabalho do operador, com o motivo no caso.
 */
function isOperatorWork(p: SharpRow): boolean {
  return p.state === 'sem par' && !p.inLinkQueue;
}

function reasonOf(p: SharpRow): { label: string; note: string | null } {
  if (p.state === 'aguardando') return { label: 'aguardando a linha abrir', note: 'O motor tenta de novo sozinho quando a linha abrir.' };
  if (p.inLinkQueue) return { label: 'sem par · em Vincular', note: 'A aposta também está na fila Vincular: resolva lá.' };
  return { label: 'sem par', note: null };
}

/**
 * Fila Sharp sem par em modo foco: um caso por vez, com o reprocessamento como
 * opção. Reprocessar enfileira a busca de novo e passa ao próximo; o caso volta
 * se o pedido falhar.
 */
export function SharpCard({ pendingSharp, sharpTotal, retrySharp, canManage }: {
  pendingSharp: OperacoesState["pendingSharp"];
  sharpTotal?: number;
  retrySharp: OperacoesState["retrySharp"];
  canManage: boolean;
}) {
  const { T } = useDesign();
  const operatorQueue = pendingSharp.filter(isOperatorWork);
  const cases = [...operatorQueue, ...pendingSharp.filter((p) => !isOperatorWork(p))];
  const total = typeof sharpTotal === "number" && Number.isFinite(sharpTotal) ? sharpTotal : null;
  const queue = useFocusQueue(cases, total);
  // O "Reprocessar estas" alcança só o que ainda está na fila desta tela.
  const pendingOperatorWork = queue.cases.filter(isOperatorWork);
  const retry = (p: SharpRow) => queue.resolve(p, () => retrySharp(p.id));
  const retryKey = SHARP_KEY.retry.toUpperCase();

  return (
    <FocusQueue
      queue={queue}
      title="Identidade sharp"
      subtitle="Sem par nos provedores sharp ou aguardando a linha abrir."
      aside={(
        <>
          <span className={foco.cadence}>{sharpCadenceLabel()}</span>
          {canManage && pendingOperatorWork.length > 0 ? (
            <Btn kind="soft" size="sm" icon={ICONS.refresh}
              onClick={() => queue.resolveMany(pendingOperatorWork, (p) => retrySharp(p.id))}>
              Reprocessar {plural(pendingOperatorWork.length, 'esta', 'estas')} {pendingOperatorWork.length}
            </Btn>
          ) : null}
        </>
      )}
      emptyText="Nenhuma aposta sem par na Pinnacle agora."
      announce={(p) => `${p.home} contra ${p.away}, ${reasonOf(p).label}`}
      hints={() => (canManage ? [{ keys: [retryKey], label: "reprocessar" }] : [])}
      onKey={(p, key) => (canManage && key.toLowerCase() === SHARP_KEY.retry ? () => retry(p) : undefined)}
      renderCase={(p) => {
        const { label, note } = reasonOf(p);
        // Dourado no trabalho do operador; neutro no que o motor ou o Vincular resolvem.
        const tone: CssVarsStyle = { "--mc-tone": isOperatorWork(p) ? T.brandAccent || T.accent : T.textFaint };
        return (
          <>
            <span className={foco.reason} style={tone}><span className={foco.reasonDot} aria-hidden="true" />{label}</span>
            <h4 className={foco.event}><Match home={p.home} away={p.away} /></h4>
            <div className={foco.context}>{[p.region, `kickoff ${p.kickoff}`, `tentou ${p.tried}`].join(" · ")}</div>
            {note ? <div className={foco.explain}>{note}</div> : null}
          </>
        );
      }}
      renderOptions={(p) => (
        <FocusOption shortcut={canManage ? SHARP_KEY.retry : undefined} marker={<Icon d={ICONS.refresh} s={14} />}
          disabled={!canManage} title="Reprocessar agora" sub="Enfileira de novo a busca do par na Pinnacle."
          onChoose={() => retry(p)} />
      )}
    />
  );
}
