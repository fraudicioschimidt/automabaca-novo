import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ManualSettlementView } from "@/src/domain/manual-settlement";
import type { StatusDeTela } from "@/src/domain/status-de-aposta";
import type { BankrollActions } from "../../action-contracts";
import { errorMessage, toast } from "../../toast";
import { computeOverride } from "./settle";
import { settlementOverride, type SettlementOverride } from "./settlement-view";
import type { SettleTarget } from "./types";

type SettleAttempt<B> = {
  bet: B;
  result: StatusDeTela;
  cashoutLucro?: number;
  view?: ManualSettlementView | null;
  requestId: string;
};

export type SettlementNotice<B> = SettleAttempt<B> & (
  | { kind: "conflict"; current: ManualSettlementView }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string }
);

type ManualSettlementProps = {
  slug: string | null | undefined;
  onSettleBet: BankrollActions["onSettleBet"];
  setSettling: (betId: string | null) => void;
  setResultMenu: (menu: null) => void;
  setResultOverrides: Dispatch<SetStateAction<Record<string, SettlementOverride>>>;
  resultLabel: Record<string, string>;
};

/**
 * Liquidação manual com confirmação de versão: o servidor recusa se a aposta
 * mudou desde que o operador a abriu (conflito), e o `requestId` torna a
 * repetição após erro de transporte idempotente.
 */
export function useManualSettlement<B extends SettleTarget>({
  slug, onSettleBet, setSettling, setResultMenu, setResultOverrides, resultLabel,
}: ManualSettlementProps) {
  const busy = useRef(false);
  const epoch = useRef(0);
  const [notice, setNotice] = useState<SettlementNotice<B> | null>(null);
  useEffect(() => { epoch.current += 1; setNotice(null); }, [slug]);
  const close = () => { if (!busy.current) setNotice(null); };
  const send = async (attempt: SettleAttempt<B>) => {
    if (busy.current || !onSettleBet || !slug) return;
    busy.current = true;
    const generation = epoch.current;
    setSettling(attempt.bet.id);
    setResultMenu(null);
    try {
      // Sem versão exibida o servidor recusa a confirmação ("Atualize a página").
      const confirmation = attempt.view ? { expectedVersion: attempt.view.version, requestId: attempt.requestId } : undefined;
      const saved = await onSettleBet(slug, attempt.bet.id, attempt.result, attempt.cashoutLucro, confirmation);
      if (generation !== epoch.current) return;
      // O cliente da rota já converte a recusa em exceção; aqui só por garantia.
      if ("erro" in saved) throw new Error(saved.erro);
      if (saved.kind === "conflict") {
        setNotice({ ...attempt, kind: "conflict", current: saved.current });
        return;
      }
      if (saved.kind === "unavailable") {
        setNotice({ ...attempt, kind: "unavailable", message: saved.message });
        return;
      }
      setResultOverrides((previous) => ({ ...previous, [attempt.bet.id]: settlementOverride(saved.current) }));
      setNotice(null);
      toast(saved.duplicate ? "Esta confirmação já foi registrada. Dados atuais carregados." : `Resultado: ${resultLabel[attempt.result]}`, "ok");
    } catch (error) {
      if (generation === epoch.current) setNotice({ ...attempt, kind: "error", message: errorMessage(error, "Não foi possível confirmar o resultado. Tente novamente.") });
    } finally {
      busy.current = false;
      setSettling(null);
    }
  };
  const doSettle = (bet: B, result: StatusDeTela, cashoutLucro?: number) => {
    if (busy.current) return;
    if (!onSettleBet || !slug) {
      setResultMenu(null);
      setResultOverrides((previous) => ({ ...previous, [bet.id]: computeOverride(bet, result, cashoutLucro) }));
      return;
    }
    return send({ bet, result, cashoutLucro, view: bet.settlementView, requestId: crypto.randomUUID() });
  };
  const confirm = () => {
    if (!notice || notice.kind === "unavailable") return;
    // No conflito, a nova decisão usa exatamente os dados exibidos neste aviso.
    // Erro de transporte mantém o mesmo recibo para recuperar uma gravação concluída.
    return send(notice.kind === "conflict"
      ? { ...notice, view: notice.current, requestId: crypto.randomUUID() }
      : notice);
  };
  return { doSettle, settlementNotice: notice, confirmSettlement: confirm, closeSettlementNotice: close };
}
