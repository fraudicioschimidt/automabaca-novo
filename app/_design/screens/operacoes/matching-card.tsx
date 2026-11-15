import Link from "next/link";
import { useDesign } from "../../kit/context";
import { Match } from "./ui-primitives";
import { TECLA_MATCHING } from "../../lib/atalhos";
import { Tecla } from "../../kit/Tecla";
import { FocusOption, FocusQueue, useFocusQueue } from "./focus-queue";
import foco from "./focus-queue.module.css";
import { ICONS, Icon } from "../../kit/icons";
import type { useOperacoesState } from "./use-operacoes-state";
import type { CssVarsStyle } from "../../kit/css-vars";

type OperacoesState = ReturnType<typeof useOperacoesState>;
type Caso = OperacoesState["pendingMatch"][number];
type Candidato = Caso["candidates"][number];

/**
 * Fila Vincular em modo foco: os candidatos são as opções numeradas. Resolver
 * (clique ou tecla) sai do caso e passa ao próximo; o resultado continua com
 * `resolveMatch`, e o caso volta à fila se ele falhar.
 */
export function MatchingCard({ pendingMatch, matchingTotal = null, resolveMatch, canManage }: {
  pendingMatch: OperacoesState["pendingMatch"];
  matchingTotal?: number | null;
  /** Resolve true quando o caso saiu da fila; a falha já vem avisada no toast. */
  resolveMatch: (id: string, cand: Candidato | "ignored") => unknown;
  canManage: boolean;
}) {
  const queue = useFocusQueue(pendingMatch, matchingTotal);
  const resolver = (m: Caso, escolha: Candidato | "ignored") => queue.resolve(m, () => resolveMatch(m.id, escolha));
  const ignorar = TECLA_MATCHING.ignorar.toUpperCase();

  return (
    <FocusQueue
      queue={queue}
      title="Vincular ao jogo"
      emptyText="Nada mais para vincular agora."
      announce={(m) => `${m.home} contra ${m.away}`}
      hints={(m) => {
        if (!canManage) return [];
        // Só as teclas que o caso em foco escuta: "1–3" com três candidatos.
        const teclas = Math.min(m.candidates.length, TECLA_MATCHING.candidatoAte);
        const numeros = teclas > 0
          ? [{ keys: teclas > 1 ? [String(TECLA_MATCHING.candidatoDe), String(teclas)] : [String(TECLA_MATCHING.candidatoDe)], range: true, label: "vincular" }]
          : [];
        return [...numeros, { keys: [ignorar], label: "depois" }];
      }}
      onKey={(m, key) => {
        if (!canManage) return undefined;
        // Teclas do registro (`lib/atalhos`), não literais: a dica do cabeçalho e
        // a folha do `?` leem as MESMAS constantes.
        if (key.toLowerCase() === TECLA_MATCHING.ignorar) return () => resolver(m, "ignored");
        const n = Number(key);
        const candidato = Number.isInteger(n) && n >= TECLA_MATCHING.candidatoDe && n <= TECLA_MATCHING.candidatoAte
          ? m.candidates[n - 1]
          : undefined;
        return candidato ? () => resolver(m, candidato) : undefined;
      }}
      renderCase={(m) => <CasoEmFoco caso={m} />}
      renderOptions={(m) => (m.candidates.length > 0 ? m.candidates.map((c, idx) => (
        <OpcaoCandidato key={c.id} candidato={c} numero={idx + 1} canManage={canManage}
          onEscolher={() => resolver(m, c)} />
      )) : <SemCandidato caso={m} />)}
      navAction={(m) => (canManage ? (
        <button type="button" className={`${foco.ghost} ${foco.ghostMain}`} onClick={() => resolver(m, "ignored")}
          aria-keyshortcuts={ignorar}>
          Tentar mais tarde <Tecla>{ignorar}</Tecla>
        </button>
      ) : null)}
    />
  );
}

function CasoEmFoco({ caso }: { caso: Caso }) {
  const { T } = useDesign();
  const semCandidato = caso.candidates.length === 0;
  const motivo = caso.motivo ?? (semCandidato ? "nenhum candidato" : null);
  // Vermelho quando não há o que escolher; azul quando foi o juiz de IA; dourado na busca automática.
  const tom: CssVarsStyle = { "--mc-tone": semCandidato ? T.neg : caso.llmReason ? T.chartClv : T.brandAccent || T.accent };
  const contexto = [caso.region, caso.kickoff !== "—" ? `kickoff ${caso.kickoff}` : null].filter(Boolean).join(" · ");
  return (
    <>
      {motivo ? <span className={foco.reason} style={tom}><span className={foco.reasonDot} aria-hidden="true" />{motivo}</span> : null}
      <h4 className={foco.event}><Match home={caso.home} away={caso.away} /></h4>
      {contexto ? <div className={foco.context}>{contexto}</div> : null}
      {caso.llmReason ? <div className={foco.explain}>Juiz LLM: {caso.llmReason}</div> : null}
      {caso.matchingReason ? <div className={foco.explain}>Busca automática: {caso.matchingReason}</div> : null}
    </>
  );
}

function OpcaoCandidato({ candidato: c, numero, canManage, onEscolher }: {
  candidato: Candidato; numero: number; canManage: boolean; onEscolher: () => void;
}) {
  const { T } = useDesign();
  const scoreStyle: CssVarsStyle = {
    "--mc-score": `${c.score * 100}%`,
    "--mc-tone": c.score >= 0.85 ? T.pos : T.accent,
  };
  // O horário do candidato vira o da aposta: noutro dia, a diferença vem em destaque.
  const detalhes = [c.league, c.kickoff, c.swapped ? "mando invertido" : null].filter(Boolean).join(" · ");
  return (
    // Com permissão, o número É a tecla; sem ela, é só a posição.
    <FocusOption shortcut={canManage && numero <= TECLA_MATCHING.candidatoAte ? String(numero) : undefined} marker={numero}
      title={c.label} disabled={!canManage} onChoose={onEscolher}
      sub={c.dayShift ? <>{detalhes} · <b className={foco.optionWarn}>{c.dayShift}</b></> : detalhes}
      trailing={(
        <span className={foco.score} style={scoreStyle}>
          <span className={foco.scoreTrack}><span className={foco.scoreBar} /></span>
          <span className={foco.scoreValue}>{Math.round(c.score * 100)}%</span>
        </span>
      )} />
  );
}

/** Sem candidato, a única saída de hoje: corrigir o nome do evento na ficha, e a busca roda de novo. */
function SemCandidato({ caso }: { caso: Caso }) {
  if (!caso.betId) {
    return (
      <div className={`${foco.option} ${foco.optionStatic}`}>
        <span className={foco.num} aria-hidden="true"><Icon d={ICONS.search} s={14} /></span>
        <span className={foco.optionBody}>
          <span className={foco.optionTitle}>Sem candidatos na Pinnacle</span>
          <span className={foco.optionSub}>A busca automática ainda não achou o jogo.</span>
        </span>
      </div>
    );
  }
  return (
    <Link href={`/aposta?id=${encodeURIComponent(caso.betId)}`} prefetch={false} className={foco.option}>
      <span className={foco.num} aria-hidden="true"><Icon d={ICONS.pencil} s={14} /></span>
      <span className={foco.optionBody}>
        <span className={foco.optionTitle}>Corrigir o nome do evento</span>
        <span className={foco.optionSub}>
          Sem candidatos na Pinnacle. Se o nome difere do da Pinnacle, corrija-o na ficha: a busca roda de novo.
        </span>
      </span>
      <Icon d={ICONS.chevronRight} s={15} />
    </Link>
  );
}
