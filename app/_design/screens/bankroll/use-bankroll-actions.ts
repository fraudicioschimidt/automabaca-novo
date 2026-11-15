import { useState, type Dispatch, type SetStateAction } from "react";
import type { BankrollActions } from "../../action-contracts";
import { contagem } from "../../lib/plural";
import { errorMessage, toast } from "../../toast";
import type { SettlementOverride } from "./settlement-view";
import type { BankrollBet, BankrollView, LocalBet, Overlay } from "./types";
import { useAddBet } from "./use-add-bet";
import { useBetExport } from "./use-bet-export";
import { useManualSettlement } from "./use-manual-settlement";
import { useSharpMode } from "./use-sharp-mode";

type BankrollActionsProps = BankrollActions & {
  AB: BankrollView;
  todayKey: string;
  allBets: readonly BankrollBet[];
  filtered: readonly BankrollBet[];
  overlay: Overlay | null;
  setOverlay: (overlay: Overlay | null) => void;
  setExtraBets: Dispatch<SetStateAction<LocalBet[]>>;
  setResultMenu: (menu: null) => void;
  setResultOverrides: Dispatch<SetStateAction<Record<string, SettlementOverride>>>;
  setDeletedBetIds: Dispatch<SetStateAction<Set<string>>>;
  resultLabel: Record<string, string>;
};

/** Ações da banca sobre o servidor (ou só locais, sem banca real / no mock). */
export function useBankrollActions({
  AB, todayKey, allBets, filtered, overlay, setOverlay, setExtraBets,
  setResultMenu, setResultOverrides, setDeletedBetIds, resultLabel,
  onFetchClosing, onSettleBet, onDeleteBet, onExportCsv, onRegisterBet, onChangeSharpMode,
}: BankrollActionsProps) {
  const slug = AB.bk?.slug;
  const [fetchingClosing, setFetchingClosing] = useState(false);
  const [settling, setSettling] = useState<string | null>(null);

  const betExport = useBetExport({ slug, allBets, filtered, onExportCsv });
  const addBetForm = useAddBet({ slug, todayKey, overlay, setOverlay, setExtraBets, onRegisterBet });
  const sharpMode = useSharpMode({ bk: AB.bk, onChangeSharpMode });
  const manualSettlement = useManualSettlement<BankrollBet>({ slug, onSettleBet,
    setSettling, setResultMenu, setResultOverrides, resultLabel });

  const handleFetchClosing = () => {
    if (fetchingClosing) return;
    if (!onFetchClosing || !slug) {
      toast("Odds de fechamento — em breve", "info");
      return;
    }
    setFetchingClosing(true);
    toast("Buscando o fechamento das apostas com o jogo já começado…", "info");
    return onFetchClosing(slug)
      .then((result) => {
        if (result.processed === 0) {
          toast("Nenhuma aposta com o jogo começado esperando fechamento", "ok");
          return;
        }
        // O que não coube no teto de espera volta como adiada, não como falha:
        // o ciclo automático pega depois, e a frase precisa dizer isso.
        const parts = [
          `Fechamento de ${contagem(result.processed, "aposta")}: ${contagem(result.closed, "fechada")}`,
          result.adiadas > 0 ? `${contagem(result.adiadas, "ficou", "ficaram")} para o ciclo automático` : null,
          result.failures > 0 ? contagem(result.failures, "falha") : null,
        ];
        toast(parts.filter(Boolean).join(" · "), result.failures ? "warn" : result.adiadas ? "info" : "ok");
      })
      .catch((error: unknown) => {
        toast(errorMessage(error, "Falha ao buscar fechamento"), "warn");
      })
      .finally(() => setFetchingClosing(false));
  };

  const doDelete = (bet: BankrollBet) => {
    if (settling) return;
    setResultMenu(null);
    const apply = () => {
      setDeletedBetIds((current) => new Set(current).add(bet.id));
      toast("Aposta excluída", "ok");
    };
    if (!onDeleteBet || !slug) {
      apply();
      return;
    }
    setSettling(bet.id);
    return onDeleteBet(slug, bet.id)
      .then(apply)
      .catch((error: unknown) => {
        toast(errorMessage(error, "Falha ao excluir aposta"), "warn");
      })
      .finally(() => setSettling(null));
  };

  return {
    fetchingClosing,
    settling,
    ...betExport,
    ...addBetForm,
    ...sharpMode,
    handleFetchClosing,
    ...manualSettlement,
    doDelete,
  };
}
