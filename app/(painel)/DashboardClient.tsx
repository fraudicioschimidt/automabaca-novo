"use client";

import { DashboardScreen } from "@/app/_design/screens/DashboardScreen";
import { DesignScreen } from "@/app/_design/DesignScreen";
import { unwrapAction } from "@/app/_design/action-contracts";
import type { getDashboardData } from "@/app/_design/adapters/dashboard";
import type { markDashboardVisitAction } from "./dashboard-actions";

type DashboardData = Awaited<ReturnType<typeof getDashboardData>>;

export function DashboardClient({
  data,
  initialMode,
  onMarkVisit,
}: {
  data: DashboardData;
  initialMode: "light" | "dark";
  // Ausente no ?mock=1: a demonstração não mexe na visita de ninguém.
  onMarkVisit?: typeof markDashboardVisitAction;
}) {
  return (
    <DesignScreen initialMode={initialMode}>
      <DashboardScreen data={data} onMarkVisit={onMarkVisit && unwrapAction(onMarkVisit)} />
    </DesignScreen>
  );
}
