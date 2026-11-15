import { themeMode } from "@/app/_lib/theme-mode";
import { getOperacoesData } from "@/app/_design/adapters/operacoes";
import {
  approveIaJudgeAction,
  ignoreMatchAction,
  rejectIaJudgeAction,
  resolveMatchAction,
  retrySharpAction,
  settleBetsAction,
} from "./actions";
import { OperacoesClient } from "./OperacoesClient";
import { mockFixture } from "@/app/(painel)/_mock";
import { canManage as sessionCanManage } from "@/app/(painel)/_auth";

export const dynamic = "force-dynamic";

/**
 * Operações — `OperacoesScreen`. `?mock=1` usa
 * o dado do design e NÃO passa actions (igual Contas/Config — mutação nunca
 * roda sobre IDs fake). Sem mock, cockpit real + mutações.
 */
export default async function OperacoesPage({
  searchParams,
}: {
  searchParams: Promise<{ mock?: string }>;
}) {
  const sp = await searchParams;
  const mode = await themeMode();
  const fixture = await mockFixture(sp.mock, () => import("@/app/_design/mock/operacoes"));
  if (fixture) {
    const { OPERACOES_MOCK } = fixture;
    return <OperacoesClient data={OPERACOES_MOCK} initialMode={mode} />;
  }
  const [canManage, data] = await Promise.all([sessionCanManage(), getOperacoesData()]);
  return (
    <OperacoesClient
      data={data}
      canManage={canManage}
      onSettle={canManage ? settleBetsAction : undefined}
      onApproveIaJudge={canManage ? approveIaJudgeAction : undefined}
      onRejectIaJudge={canManage ? rejectIaJudgeAction : undefined}
      onResolveMatch={canManage ? resolveMatchAction : undefined}
      onIgnoreMatch={canManage ? ignoreMatchAction : undefined}
      onRetrySharp={canManage ? retrySharpAction : undefined}
      initialMode={mode}
    />
  );
}
