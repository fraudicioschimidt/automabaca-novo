import { themeMode } from "@/app/_lib/theme-mode";
import { getDashboardData } from "@/app/_design/adapters/dashboard";
import { DashboardClient } from "./DashboardClient";
import { mockFixture } from "@/app/(painel)/_mock";
import { operadorAtual } from "./_operador";
import { markDashboardVisitAction } from "./dashboard-actions";

export const dynamic = "force-dynamic";

/**
 * Dashboard — `DashboardScreen`. `?mock=1`
 * renderiza o dado original do design (p/ comparar com o protótipo); sem isso,
 * usa o dado real do banco via adaptador (cada bankroll = um "tipster").
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ mock?: string }>;
}) {
  const [sp, mode] = await Promise.all([searchParams, themeMode()]);
  const fixture = await mockFixture(sp.mock, () => import("@/app/_design/mock/dashboard"));
  if (fixture) {
    const { TIP } = fixture;
    return <DashboardClient data={TIP} initialMode={mode} />;
  }
  const user = await operadorAtual();
  const nome = user.charAt(0).toUpperCase() + user.slice(1);
  const data = await getDashboardData(nome, user);
  return <DashboardClient data={data} initialMode={mode} onMarkVisit={markDashboardVisitAction} />;
}
