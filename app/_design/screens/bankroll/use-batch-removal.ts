import { useState, type Dispatch, type SetStateAction } from "react";
import type { BankrollActions } from "../../action-contracts";
import { contagem, plural } from "../../lib/plural";
import { errorMessage, toast } from "../../toast";
import type { BatchRemovalBet, BatchRemovalPlan } from "@/src/services/bets/remove";
import type { BankrollBet } from "./types";

// A aposta criada na tela e ainda não gravada não tem id do servidor: não entra no lote.
const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BatchRemovalActions = Pick<BankrollActions, "onPreviewRemoval" | "onRemoveBets" | "onRestoreBets">;

/** A confirmação aberta: a prévia do servidor e, se ele recusou a anterior, o porquê. */
type Confirmation = { plan: BatchRemovalPlan; ids: string[]; changed: string | null };

/**
 * Remoção em lote da lista da banca: marcar, ver a prévia do servidor (as do
 * mesmo post entram juntas, e a liquidada há mais de 7 dias fica de fora) e
 * confirmar. A remoção leva o lote que a prévia mostrou; se ele mudou, o
 * servidor recusa e a confirmação reabre com a prévia de agora. Restaurar é o
 * mesmo caminho no Desfazer do toast e na aba "Removidas".
 */
export function useBatchRemoval({ slug, visibleBets, setDeletedBetIds, onPreviewRemoval, onRemoveBets, onRestoreBets }: BatchRemovalActions & {
  slug: string | undefined;
  visibleBets: readonly BankrollBet[];
  setDeletedBetIds: Dispatch<SetStateAction<Set<string>>>;
}) {
  const available = Boolean(slug && onPreviewRemoval && onRemoveBets);
  const canRestore = Boolean(slug && onRestoreBets);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set<string>());
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  // As que ficaram de fora do último lote: o aviso fica até o operador fechar.
  const [leftOut, setLeftOut] = useState<BatchRemovalBet[]>([]);
  // Restauradas nesta tela: saem de "Removidas" antes de a banca recarregar.
  const [restoredIds, setRestoredIds] = useState<ReadonlySet<string>>(() => new Set());
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set());

  // O lote é o que está marcado E visível: filtro que esconde uma aposta a tira do lote.
  const selectedIds = visibleBets.filter((bet) => selected.has(bet.id)).map((bet) => bet.id);

  const toggleSelecting = () => {
    setSelecting((current) => !current);
    setSelected(new Set());
  };
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const canSelect = (bet: Pick<BankrollBet, "id">) => SERVER_ID.test(bet.id);

  const requestRemoval = async () => {
    if (!available || selectedIds.length === 0 || busy) return;
    setBusy(true);
    try {
      const { plan } = await onPreviewRemoval!(slug!, selectedIds);
      setConfirm({ plan, ids: selectedIds, changed: null });
    } catch (error) {
      toast(errorMessage(error, "Falha ao preparar a remoção"), "warn");
    } finally {
      setBusy(false);
    }
  };

  const withRestoring = (ids: readonly string[], on: boolean) => setRestoring((current) => {
    const next = new Set(current);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    return next;
  });

  const restore = async (ids: string[]) => {
    if (!canRestore) return;
    withRestoring(ids, true);
    try {
      const { restored, blocked } = await onRestoreBets!(slug!, ids);
      setDeletedBetIds((current) => {
        const next = new Set(current);
        restored.forEach((id) => next.delete(id));
        return next;
      });
      setRestoredIds((current) => new Set([...current, ...restored]));
      if (blocked.length) {
        toast(`${contagem(blocked.length, "aposta")} não ${plural(blocked.length, "voltou", "voltaram")}: falta o estado financeiro anterior, e ${plural(blocked.length, "ficou", "ficaram")} para revisão.`, "warn");
      } else if (restored.length) {
        toast(`${contagem(restored.length, "aposta")} de volta ao tipster`, "info");
      } else {
        toast(ids.length === 1 ? "A aposta já tinha voltado ao tipster." : "As apostas já tinham voltado ao tipster.", "info");
      }
    } catch (error) {
      toast(`Não foi possível restaurar: ${errorMessage(error, "sem resposta do servidor")}`, "warn");
    } finally {
      withRestoring(ids, false);
    }
  };

  const confirmRemoval = async () => {
    if (!confirm || busy || !onRemoveBets) return;
    setBusy(true);
    const shown = confirm.plan.remove.map(({ id, status, lucro }) => ({ id, status, lucro }));
    try {
      const { plan } = await onRemoveBets(slug!, confirm.ids, shown);
      const removed = plan.remove.map((bet) => bet.id);
      setDeletedBetIds((current) => {
        const next = new Set(current);
        removed.forEach((id) => next.add(id));
        return next;
      });
      setConfirm(null);
      setSelecting(false);
      setSelected(new Set());
      setLeftOut(plan.review);
      if (removed.length) {
        toast(`${contagem(removed.length, "aposta")} ${plural(removed.length, "removida")}`, "ok",
          canRestore ? { onUndo: () => restore(removed) } : {});
      }
    } catch (error) {
      // Recusa (o lote mudou depois da prévia) ou falha: a confirmação fica
      // aberta com a prévia de agora e o motivo, para conferir de novo.
      const reason = errorMessage(error, "Falha ao remover as apostas");
      try {
        const { plan } = await onPreviewRemoval!(slug!, confirm.ids);
        setConfirm({ plan, ids: confirm.ids, changed: reason });
      } catch (previewError) {
        setConfirm(null);
        toast(errorMessage(previewError, reason), "warn");
      }
    } finally {
      setBusy(false);
    }
  };

  return {
    available,
    canRestore,
    selecting,
    toggleSelecting,
    selected,
    toggle,
    canSelect,
    selectedCount: selectedIds.length,
    requestRemoval,
    confirm,
    closeConfirm: () => { if (!busy) setConfirm(null); },
    confirmRemoval,
    busy,
    leftOut,
    dismissLeftOut: () => setLeftOut([]),
    restore,
    restoredIds,
    restoring,
  };
}

export type BatchRemovalState = ReturnType<typeof useBatchRemoval>;
