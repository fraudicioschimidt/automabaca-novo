import { themeMode } from "@/app/_lib/theme-mode";
import { notFound } from "next/navigation";
import { getBankrollData } from "@/app/_design/adapters/bankroll";
import { mockFixture } from "@/app/(painel)/_mock";
import {
  buscarFechamentoAction,
  exportBankrollCsvAction,
  settleBetAction,
  updateBankrollSharpModeAction,
} from "./actions";
import {
  deleteBetAction,
  previewBetRemovalAction,
  registerManualBetAction,
  removeBetsAction,
  restoreBetsAction,
} from "./manual-actions";
import { BankrollClient } from "./BankrollClient";
import { canManage as sessionCanManage } from "../../_auth";

export const dynamic = "force-dynamic";

/**
 * Bankroll (detalhe) — `BankrollScreen`.
 * `?mock=1` injeta o fixture serializável do design; sem isso, o detalhe
 * REAL da banca via adaptador (BETS/METRICS/CHART/bk/tips — dado puro, sem
 * funções; os formatadores ficam no runtime leve do client). A tela recomputa
 * mês/calendário/stats/filtros a partir do BETS[].
 */
export default async function BankrollDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ empty?: string; mock?: string }>;
}) {
  const [{ slug }, sp, mode] = await Promise.all([params, searchParams, themeMode()]);
  const fixture = await mockFixture(sp.mock, () => import("@/app/_design/mock/bankroll-data"));
  if (fixture) {
    const { BANKROLL_MOCK_DATA } = fixture;
    return <BankrollClient data={BANKROLL_MOCK_DATA} emptyState={sp.empty === "1"} initialMode={mode} />;
  }
  const [canManage, data] = await Promise.all([sessionCanManage(), getBankrollData(slug)]);
  if (!data) notFound();
  // Banca que só tem removidas não é banca nova: a lista fica, porque a aba
  // Removidas (com o Restaurar) mora nela.
  const emptyState = data.BETS.length === 0 && data.removed.total === 0;
  return (
    <BankrollClient
      data={data}
      canManage={canManage}
      liveUpdates
      emptyState={emptyState}
      initialMode={mode}
      onFetchClosing={canManage ? buscarFechamentoAction : undefined}
      onSettleBet={canManage ? settleBetAction : undefined}
      onDeleteBet={canManage ? deleteBetAction : undefined}
      onPreviewRemoval={canManage ? previewBetRemovalAction : undefined}
      onRemoveBets={canManage ? removeBetsAction : undefined}
      onRestoreBets={canManage ? restoreBetsAction : undefined}
      onExportCsv={exportBankrollCsvAction}
      onRegisterBet={canManage ? registerManualBetAction : undefined}
      onChangeSharpMode={canManage ? updateBankrollSharpModeAction : undefined}
    />
  );
}
