"use client";

import { ApostaScreen } from "@/app/_design/screens/ApostaScreen";
import { DesignScreen } from "@/app/_design/DesignScreen";
import type { BetRemovalView, CapturaDaFicha, SettlementCard, getApostaBet } from "@/app/_design/adapters/aposta";
import type { TrilhaDaAposta } from "@/src/services/painel/aposta/trilha";
import type {
  deleteBetAction,
  editBetAction,
  restoreBetsAction,
} from "@/app/(painel)/tipsters/[slug]/manual-actions";
import { useRouter } from "next/navigation";
import { unwrapAction } from "@/app/_design/action-contracts";

type ApostaData = Awaited<ReturnType<typeof getApostaBet>>;

export function ApostaClient({
  bet,
  trilha,
  captura,
  settlement,
  removal,
  initialMode,
  onEditBet,
  onDeleteBet,
  onRestoreBets,
}: {
  bet: NonNullable<ApostaData>;
  trilha: TrilhaDaAposta | null;
  captura: CapturaDaFicha | null;
  settlement: SettlementCard | null;
  removal: BetRemovalView | null;
  initialMode: "light" | "dark";
  onEditBet: typeof editBetAction | null;
  onDeleteBet: typeof deleteBetAction | null;
  onRestoreBets: typeof restoreBetsAction | null;
}) {
  const router = useRouter();
  // As actions revalidam /aposta e as telas da banca: a edição volta com a
  // ficha nova na própria resposta, e a banca de destino já está invalidada.
  // Um `router.refresh()` a mais leria tudo de novo.
  const deleteBet = onDeleteBet && unwrapAction(onDeleteBet);
  const remove = deleteBet
    ? async (...args: Parameters<typeof deleteBetAction>) => {
        const deleted = await deleteBet(...args);
        router.replace(`/tipsters/${args[0]}`);
        return deleted;
      }
    : null;
  return (
    <DesignScreen initialMode={initialMode}>
      <ApostaScreen
        bet={bet}
        trilha={trilha}
        captura={captura}
        settlement={settlement}
        removal={removal}
        onEditBet={onEditBet && unwrapAction(onEditBet)}
        onDeleteBet={remove}
        onRestoreBets={onRestoreBets && unwrapAction(onRestoreBets)}
      />
    </DesignScreen>
  );
}
