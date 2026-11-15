import { themeMode } from "@/app/_lib/theme-mode";
import { mockFixture } from "@/app/(painel)/_mock";
import { getMonitoramentoData } from "@/app/_design/adapters/operacoes";
import {
  acknowledgeOperationalActionAction,
  captureDiscardedPostAction,
  replayJobAction,
  resolveOperationalActionAction,
  retryChannelTransientAction,
} from "../operacoes/actions";
import { MonitoramentoClient } from "./MonitoramentoClient";
import { canManage as sessionCanManage } from "../_auth";

export const dynamic = "force-dynamic";

export default async function MonitoramentoPage({
  searchParams,
}: {
  searchParams: Promise<{ mock?: string }>;
}) {
  const params = await searchParams;
  const mode = await themeMode();
  const fixture = await mockFixture(params.mock, () => import("@/app/_design/mock/operacoes"));
  if (fixture) {
    const { MONITORAMENTO_MOCK } = fixture;
    return <MonitoramentoClient data={MONITORAMENTO_MOCK} initialMode={mode} />;
  }

  const [canManage, data] = await Promise.all([sessionCanManage(), getMonitoramentoData()]);
  return (
    <MonitoramentoClient
      data={data}
      onReplayJob={canManage ? replayJobAction : undefined}
      onAcknowledgeAction={canManage ? acknowledgeOperationalActionAction : undefined}
      onResolveAction={canManage ? resolveOperationalActionAction : undefined}
      onRetryChannelTransient={canManage ? retryChannelTransientAction : undefined}
      onCaptureDiscardedPost={canManage ? captureDiscardedPostAction : undefined}
      initialMode={mode}
    />
  );
}
