import { themeMode } from "@/app/_lib/theme-mode";
import { notFound } from "next/navigation";
import { getApostaBet, getBetRemovalView, getCapturaDaAposta, getBetSettlementCard } from "@/app/_design/adapters/aposta";
import { getTrilhaDaAposta } from "@/src/services/painel/aposta/trilha";
import { ApostaClient } from "./ApostaClient";
import { mockFixture } from "@/app/(painel)/_mock";
import {
  deleteBetAction,
  editBetAction,
  restoreBetsAction,
} from "@/app/(painel)/tipsters/[slug]/manual-actions";
import { canManage as sessionCanManage } from "@/app/(painel)/_auth";

export const dynamic = "force-dynamic";

/**
 * Ficha da aposta (`?id=<betId>`; sem id ou inexistente → 404). A removida
 * abre só para leitura, com o "Restaurar". `?mock=1`, só em desenvolvimento,
 * usa a aposta de demonstração com esse id (ou a primeira).
 */
export default async function ApostaPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; mock?: string }>;
}) {
  const sp = await searchParams;
  const mode = await themeMode();
  const fixture = await mockFixture(sp.mock, () => import("@/app/_design/mock/bet"));
  if (fixture) {
    const { BETS, CAPTURA, SETTLEMENT_CARDS, TRILHA } = fixture;
    const bet = BETS.find((b) => b.id === sp.id) ?? BETS[0];
    if (!bet) notFound();
    return <ApostaClient bet={bet} trilha={TRILHA} captura={CAPTURA} settlement={SETTLEMENT_CARDS[bet.id] ?? null} removal={null} initialMode={mode} onEditBet={null} onDeleteBet={null} onRestoreBets={null} />;
  }
  if (!sp.id) notFound();
  const [canManage, bet, trilha, captura, settlement, removal] = await Promise.all([
    sessionCanManage(),
    getApostaBet(sp.id),
    getTrilhaDaAposta(sp.id),
    getCapturaDaAposta(sp.id),
    getBetSettlementCard(sp.id),
    getBetRemovalView(sp.id),
  ]);
  if (!bet) notFound();
  return (
    <ApostaClient
      bet={bet}
      trilha={trilha}
      captura={captura}
      settlement={settlement}
      removal={removal}
      initialMode={mode}
      onEditBet={canManage && !removal ? editBetAction : null}
      onDeleteBet={canManage && !removal ? deleteBetAction : null}
      onRestoreBets={canManage && removal ? restoreBetsAction : null}
    />
  );
}
