"use client";

import { DesignScreen } from "@/app/_design/DesignScreen";
import { MonitoramentoScreen } from "@/app/_design/screens/MonitoramentoScreen";
import { unwrapAction } from "@/app/_design/action-contracts";
import type { MonitoramentoData } from "@/app/_design/adapters/operacoes";
import type {
  acknowledgeOperationalActionAction,
  captureDiscardedPostAction,
  replayJobAction,
  resolveOperationalActionAction,
  retryChannelTransientAction,
} from "../operacoes/actions";

export function MonitoramentoClient({
  data,
  onReplayJob,
  onAcknowledgeAction,
  onResolveAction,
  onRetryChannelTransient,
  onCaptureDiscardedPost,
  initialMode,
}: {
  data: MonitoramentoData;
  initialMode: "light" | "dark";
  // Ausentes no ?mock=1 e sem sessão de operador.
  onReplayJob?: typeof replayJobAction;
  onAcknowledgeAction?: typeof acknowledgeOperationalActionAction;
  onResolveAction?: typeof resolveOperationalActionAction;
  onRetryChannelTransient?: typeof retryChannelTransientAction;
  onCaptureDiscardedPost?: typeof captureDiscardedPostAction;
}) {
  return (
    <DesignScreen initialMode={initialMode}>
      <MonitoramentoScreen
        data={data}
        onReplayJob={onReplayJob && unwrapAction(onReplayJob)}
        onAcknowledgeAction={onAcknowledgeAction && unwrapAction(onAcknowledgeAction)}
        onResolveAction={onResolveAction && unwrapAction(onResolveAction)}
        onRetryChannelTransient={onRetryChannelTransient && unwrapAction(onRetryChannelTransient)}
        onCaptureDiscardedPost={onCaptureDiscardedPost && unwrapAction(onCaptureDiscardedPost)}
      />
    </DesignScreen>
  );
}
