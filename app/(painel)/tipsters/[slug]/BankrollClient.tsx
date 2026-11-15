"use client";

import type {
  buscarFechamentoAction,
  exportBankrollCsvAction,
  settleBetAction,
  updateBankrollSharpModeAction,
} from "./actions";
import { BankrollScreen } from "@/app/_design/screens/BankrollScreen";
import { DesignScreen } from "@/app/_design/DesignScreen";
import type { getBankrollData } from "@/app/_design/adapters/bankroll";
import type {
  deleteBetAction,
  previewBetRemovalAction,
  registerManualBetAction,
  removeBetsAction,
  restoreBetsAction,
} from "./manual-actions";
import { usePendingBetsRefresh } from "./use-pending-bets-refresh";
import { unwrapAction } from "@/app/_design/action-contracts";

type BankrollData = Awaited<ReturnType<typeof getBankrollData>>;

export function BankrollClient({
  data,
  emptyState = false,
  initialMode,
  onFetchClosing,
  onSettleBet,
  onDeleteBet,
  onExportCsv,
  onRegisterBet,
  onChangeSharpMode,
  onPreviewRemoval,
  onRemoveBets,
  onRestoreBets,
  canManage = true,
  liveUpdates = false,
}: {
  data: BankrollData;
  emptyState?: boolean;
  initialMode: "light" | "dark";
  canManage?: boolean;
  liveUpdates?: boolean;
  // Ausente no ?mock=1: o botão "Odds fechamento" cai em "em breve" (nunca opera fake).
  onFetchClosing?: typeof buscarFechamentoAction;
  // Ausente no ?mock=1: "Alterar resultado" só faz otimismo local (não persiste).
  onSettleBet?: typeof settleBetAction;
  // Ausente no ?mock=1: a exclusão rápida remove apenas o item do fixture local.
  onDeleteBet?: typeof deleteBetAction;
  // Ausente no ?mock=1: export cai no fallback local (só apostas carregadas).
  onExportCsv?: typeof exportBankrollCsvAction;
  // Ausente no ?mock=1: "Adicionar aposta" só faz mock local.
  onRegisterBet?: typeof registerManualBetAction;
  onChangeSharpMode?: typeof updateBankrollSharpModeAction;
  // Ausentes no ?mock=1 e sem sessão: a lista não oferece a remoção em lote.
  onPreviewRemoval?: typeof previewBetRemovalAction;
  onRemoveBets?: typeof removeBetsAction;
  onRestoreBets?: typeof restoreBetsAction;
}) {
  usePendingBetsRefresh(liveUpdates, data?.bk.slug, data?.liveVersion);
  // As actions revalidam a rota da banca (`revalidateFinancialViews`), e a
  // resposta delas já traz a página nova; um `router.refresh()` depois
  // leria a banca inteira uma segunda vez. Mudança concorrente chega pelo
  // `usePendingBetsRefresh`.
  const settleBet = onSettleBet
    ? async (...args: Parameters<typeof settleBetAction>) => {
        const settled = await onSettleBet(...args);
        if ("erro" in settled) throw new Error(settled.erro);
        return settled;
      }
    : undefined;

  // `data` real ou fixture serializável no ?mock=1; formatadores ficam no runtime leve.
  // emptyState = banca sem apostas (mostra o estado "Sua banca está pronta").
  return (
    <DesignScreen initialMode={initialMode}>
      <BankrollScreen
        emptyState={emptyState}
        data={data}
        canManage={canManage}
        onFetchClosing={onFetchClosing && unwrapAction(onFetchClosing)}
        onSettleBet={settleBet}
        onDeleteBet={onDeleteBet && unwrapAction(onDeleteBet)}
        onExportCsv={onExportCsv && unwrapAction(onExportCsv)}
        onRegisterBet={onRegisterBet && unwrapAction(onRegisterBet)}
        onChangeSharpMode={onChangeSharpMode && unwrapAction(onChangeSharpMode)}
        onPreviewRemoval={onPreviewRemoval && unwrapAction(onPreviewRemoval)}
        onRemoveBets={onRemoveBets && unwrapAction(onRemoveBets)}
        onRestoreBets={onRestoreBets && unwrapAction(onRestoreBets)}
      />
    </DesignScreen>
  );
}
