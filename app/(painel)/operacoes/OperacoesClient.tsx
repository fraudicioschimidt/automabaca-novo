"use client";

import { OperacoesScreen } from "@/app/_design/screens/OperacoesScreen";
import { DesignScreen } from "@/app/_design/DesignScreen";
import { unwrapAction, type OperacoesData } from "@/app/_design/action-contracts";
import type {
  approveIaJudgeAction,
  ignoreMatchAction,
  rejectIaJudgeAction,
  resolveMatchAction,
  retrySharpAction,
  settleBetsAction,
} from "./actions";

export function OperacoesClient({
  data,
  onSettle,
  onApproveIaJudge,
  onRejectIaJudge,
  onResolveMatch,
  onIgnoreMatch,
  onRetrySharp,
  canManage = true,
  initialMode,
}: {
  data: OperacoesData;
  canManage?: boolean;
  initialMode: "light" | "dark";
  // Ausentes no ?mock=1 e sem sessão de operador.
  onSettle?: typeof settleBetsAction;
  onApproveIaJudge?: typeof approveIaJudgeAction;
  onRejectIaJudge?: typeof rejectIaJudgeAction;
  onResolveMatch?: typeof resolveMatchAction;
  onIgnoreMatch?: typeof ignoreMatchAction;
  onRetrySharp?: typeof retrySharpAction;
}) {
  return (
    <DesignScreen initialMode={initialMode}>
      <OperacoesScreen
        data={data}
        canManage={canManage}
        onSettle={onSettle}
        onApproveIaJudge={onApproveIaJudge && unwrapAction(onApproveIaJudge)}
        onRejectIaJudge={onRejectIaJudge && unwrapAction(onRejectIaJudge)}
        onResolveMatch={onResolveMatch && unwrapAction(onResolveMatch)}
        onIgnoreMatch={onIgnoreMatch && unwrapAction(onIgnoreMatch)}
        onRetrySharp={onRetrySharp && unwrapAction(onRetrySharp)}
      />
    </DesignScreen>
  );
}
