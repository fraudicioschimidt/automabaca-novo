import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { errorMessage, toast } from "../../toast";
import type { OperacoesActions, OperacoesData } from "../../action-contracts";

type Result = Parameters<NonNullable<OperacoesActions["onSettle"]>>[1];
type Settlement = OperacoesData["settlement"][number] & { result: Result | null };
type Candidate = { index?: number; label?: string; candidateHash?: string };
type Match = OperacoesData["matching"][number] & { resolved: Candidate | "ignored" | null };
type QueueData = Pick<OperacoesData, "settlement" | "matching" | "sharp" | "iaJudgeSuggestions" | "iaJudgeSuggestionTotal" | "matchingTotal"> & {
  sharpSemMatchTotal?: number; matchingSharpSobrepostos?: number;
};

const RESULTADO_NO_TOAST: Record<string, string> = {
  won: 'ganhou', half_won: 'meia ganha', lost: 'perdeu', half_lost: 'meia perdida', void: 'reembolso', pending: 'pendente',
};

/** Fila do IA-Judge: a lista e o total andam juntos quando o operador decide. */
function useFilaIaJudge(O: QueueData) {
  const iaJudgeSuggestions = O.iaJudgeSuggestions;
  const [iajList, setIajList] = useState(() => iaJudgeSuggestions);
  const [iajTotal, setIajTotal] = useState(() => O.iaJudgeSuggestionTotal ?? iaJudgeSuggestions.length);
  useEffect(() => {
    setIajList(iaJudgeSuggestions);
    setIajTotal(O.iaJudgeSuggestionTotal ?? iaJudgeSuggestions.length);
  }, [iaJudgeSuggestions, O.iaJudgeSuggestionTotal]);

  /** Resolve true quando a sugestão saiu da fila; a falha já vem avisada no toast. Sem a ação (o `?mock=1`), decide só na tela. */
  const handleIajAction = async (id: string, actionFn: OperacoesActions["onApproveIaJudge"]) => {
    try {
      await actionFn?.(id);
      setIajList((arr) => arr.filter((s) => s.id !== id));
      setIajTotal((total) => Math.max(0, total - 1));
      toast('Ação registrada', 'ok');
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'warn');
      return false;
    }
  };

  return { iajList, iajTotal, handleIajAction };
}

/**
 * Liquidação manual, uma aposta por vez, com desfazer no toast. Resolve true
 * quando a aposta saiu da fila de pendentes; a falha já vem avisada no toast.
 */
function useManualSettlement(
  settle: readonly Settlement[],
  setSettle: Dispatch<SetStateAction<Settlement[]>>,
  onSettle: OperacoesActions["onSettle"],
) {
  // Aposta com liquidação (ou desfazer) em voo não aceita outro envio até o
  // servidor responder, senão o segundo volta como "já liquidada".
  const inFlight = useRef(new Set<string>());

  /** A versão gravada acompanha o resultado: é a que o próximo envio (o desfazer, ou liquidar de novo) confirma. */
  const setResult = (id: string, result: Result | null, version?: number) =>
    setSettle((arr) => arr.map((s) => s.id === id ? { ...s, result, version: version ?? s.version } : s));

  /** A versão exibida e o id deste clique: o servidor recusa se a aposta mudou desde então. */
  const request = (id: string, expectedVersion: number) => [{ betId: id, expectedVersion, requestId: crypto.randomUUID() }];

  /** Volta a pendente só se o servidor confirmou, e diz quando não voltou. */
  const undo = (id: string, settledVersion: number, onUndone?: () => void) => {
    if (!onSettle || inFlight.current.has(id)) return;
    inFlight.current.add(id);
    onSettle(request(id, settledVersion), 'pending')
      .then((r) => {
        if (r.mutadas.includes(id)) {
          setResult(id, null, r.versions[id]);
          onUndone?.();
          toast('Aposta de volta a pendente', 'info');
        } else {
          const motivo = r.failures ? 'o servidor recusou' : 'o resultado mudou antes';
          toast(`A aposta não voltou a pendente (${motivo}) — confira pela ficha.`, 'warn');
        }
      })
      .catch((err: unknown) => {
        toast(`Não foi possível desfazer: ${errorMessage(err, 'sem resposta do servidor')}. Recarregue para ver o estado atual.`, 'warn');
      })
      .finally(() => inFlight.current.delete(id));
  };

  /** `onUndone` avisa quem mostra a fila que o desfazer trouxe a aposta de volta. */
  const resolveSettle = (id: string, result: Exclude<Result, 'pending'>, onUndone?: () => void): Promise<boolean> => {
    if (!onSettle) {
      setResult(id, result);
      return Promise.resolve(true);
    }
    const shown = settle.find((s) => s.id === id);
    if (!shown || inFlight.current.has(id)) return Promise.resolve(false);
    inFlight.current.add(id);
    return onSettle(request(id, shown.version), result)
      .then((r) => {
        const settledVersion = r.versions[id];
        if (r.mutadas.includes(id) && settledVersion !== undefined) {
          setResult(id, result, settledVersion);
          toast(`Aposta marcada como ${RESULTADO_NO_TOAST[result] || result}`, result === 'won' || result === 'half_won' ? 'ok' : result === 'void' ? 'info' : 'warn',
            { onUndo: () => undo(id, settledVersion, onUndone) });
          return true;
        }
        // A borda recusa a aposta que o liquidador automático resolveu entre o
        // clique e o commit. Não é falha, mas o dono precisa saber por que o
        // resultado dele não entrou; a aposta já não é pendente e sai da fila.
        if (r.ignoradas) {
          setSettle((arr) => arr.filter((s) => s.id !== id));
          toast('A aposta já estava liquidada e ficou de fora — troque o resultado pela ficha, se precisar.', 'info');
          return true;
        }
        if (r.halfRefused) {
          toast('Aposta sem linha asiática fracionária não aceita ½ — marque ganhou, perdeu ou reembolso.', 'warn');
        } else if (r.conflicts) {
          toast('A aposta mudou depois que esta página abriu e não foi liquidada — confira os dados e marque de novo.', 'warn');
        } else {
          toast('A aposta não foi liquidada e voltou à fila; confira.', 'warn');
        }
        return false;
      })
      .catch((err: unknown) => {
        toast(`Liquidação não confirmada: ${errorMessage(err, 'sem resposta do servidor')}. Recarregue para ver o estado atual.`, 'warn');
        return false;
      })
      .finally(() => inFlight.current.delete(id));
  };

  return { resolveSettle };
}

export function useOperacoesState(O: QueueData, {
  onSettle,
  onResolveMatch,
  onIgnoreMatch,
  onRetrySharp,
}: OperacoesActions) {
  const [settle, setSettle] = useState<Settlement[]>(() => O.settlement.map((s) => ({ ...s, result: null })));
  const [matches, setMatches] = useState<Match[]>(() => O.matching.map((m) => ({ ...m, resolved: null })));

  // Props novos são o snapshot persistido; estado de protótipo não o substitui.
  useEffect(() => {
    setSettle(O.settlement.map((s) => ({ ...s, result: null })));
    setMatches(O.matching.map((m) => ({ ...m, resolved: null })));
  }, [O.settlement, O.matching]);

  const pendingSettle = settle.filter((s) => s.result == null);
  const pendingMatch = matches.filter((m) => m.resolved == null);
  // O reprocessamento não tira a aposta da fila no servidor: quem a esconde
  // depois do clique é a fila em foco.
  const pendingSharp = O.sharp;

  const { iajList, iajTotal, handleIajAction } = useFilaIaJudge(O);
  const { resolveSettle } = useManualSettlement(settle, setSettle, onSettle);

  // "Precisa de você" é o TAMANHO DA FILA do operador, então conta ITENS DE
  // TRABALHO distintos: uma aposta sem match na Pinnacle costuma abrir caso de
  // treino E ficar pendente de sharp. A interseção vem do servidor, onde as
  // duas filas têm o total completo; o fallback para a página visível vale
  // enquanto o backlog couber nela.
  const semMatchNaPagina = pendingSharp.filter(
    (p) => p.state === "sem par" || p.identityStatus === "UNMATCHED",
  ).length;
  const semMatchTotal = Math.max(semMatchNaPagina, O.sharpSemMatchTotal ?? 0);
  const sobrepostos = Math.min(O.matchingSharpSobrepostos ?? 0, semMatchTotal);
  const nLiquidar = pendingSettle.length;
  const nVincular = Math.max(pendingMatch.length, O.matchingTotal ?? 0);
  const nHomologar = Math.max(iajList.length, iajTotal);
  const nSharp = Math.max(0, semMatchTotal - sobrepostos);
  const actionCount = nLiquidar + nVincular + nHomologar + nSharp;

  /**
   * As MESMAS quatro filas que o cabeçalho soma, cada uma com o seu número:
   * são as abas da tela. Uma fila por vez, e o primeiro destino é a fila com
   * backlog: abrir sempre em "liquidar" mandaria para um card vazio nos dias em
   * que ele está em dia.
   */
  const filas = [
    { id: 'liquidar', cap: 'A liquidar', n: nLiquidar, nota: 'o automático não liquidou' },
    { id: 'vincular', cap: 'A vincular', n: nVincular, nota: 'sem identidade na Pinnacle' },
    { id: 'homologar', cap: 'A homologar', n: nHomologar, nota: 'sugestão do IA-Judge' },
    { id: 'sharp', cap: 'Sharp sem par', n: nSharp, nota: 'sem par na Pinnacle para medir CLV' },
  ] as const;
  const [filaAtiva, setFilaAtiva] = useState<string>(
    () => (filas.find((f) => f.n > 0) ?? filas[0]).id,
  );

  const applyMatch = (id: string, cand: Candidate | "ignored") => {
    setMatches((arr) => arr.map((m) => m.id === id ? { ...m, resolved: cand } : m));
    toast(cand === 'ignored' ? 'Vínculo ignorado' : 'Vínculo resolvido', 'ok');
  };

  /** Resolve true quando o caso saiu da fila; a falha já foi avisada no toast. */
  const resolveMatch = (id: string, cand: Candidate | "ignored"): Promise<boolean> => {
    const apply = () => {
      applyMatch(id, cand);
      return true;
    };
    if (cand === 'ignored') {
      if (!onIgnoreMatch) return Promise.resolve(apply());
      return onIgnoreMatch(id).then(apply).catch((err: unknown) => {
        toast(errorMessage(err, 'Falha ao ignorar'), 'warn');
        return false;
      });
    }
    if (!onResolveMatch) return Promise.resolve(apply());
    if (typeof cand.index !== 'number' || !cand.candidateHash) {
      toast('Candidato inválido', 'warn');
      return Promise.resolve(false);
    }
    return onResolveMatch(id, cand.index, cand.candidateHash)
      .then((result) => {
        apply();
        // O nome do tipster que o Vincular não pôde ensinar à ficha: o dono precisa saber.
        if (result.notice) toast(result.notice, 'warn');
        return true;
      })
      .catch((err: unknown) => {
        toast(errorMessage(err, 'Falha ao resolver o vínculo'), 'warn');
        return false;
      });
  };

  /** Resolve true quando o reprocessamento foi enfileirado; a falha já vem avisada no toast. */
  const retrySharp = (id: string): Promise<boolean> => {
    toast('Enfileirando reprocessamento sharp…', 'info');
    const succeed = () => {
      toast('Reprocessamento enfileirado', 'info');
      return true;
    };
    if (!onRetrySharp) return Promise.resolve(succeed());
    return Promise.resolve()
      .then(() => onRetrySharp(id))
      .then(succeed)
      .catch((err: unknown) => {
        toast(errorMessage(err, 'Falha ao reprocessar'), 'warn');
        return false;
      });
  };

  return {
    settle,
    matches,
    pendingSettle,
    pendingMatch,
    pendingSharp,
    iajList,
    iajTotal,
    handleIajAction,
    actionCount,
    filas,
    filaAtiva,
    setFilaAtiva,
    resolveSettle,
    resolveMatch,
    retrySharp,
  };
}
