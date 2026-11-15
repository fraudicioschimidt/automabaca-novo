"use client";

import { useRouter } from "next/navigation";
import { ContasScreen } from "@/app/_design/screens/ContasScreen";
import { DesignScreen } from "@/app/_design/DesignScreen";
import type { ContaActions, ContasData } from "@/app/_design/action-contracts";

export function ContasClient({
  data,
  accId,
  initialMode,
  onMovimentar,
  onCriar,
  onEditar,
  onStatus,
  onRemover,
  canManage = true,
}: {
  data: ContasData;
  accId: string | null;
  initialMode: "light" | "dark";
  canManage?: boolean;
} & ContaActions) {
  const router = useRouter();

  return (
    <DesignScreen initialMode={initialMode}>
      <ContasScreen
        data={data}
        accId={accId}
        canManage={canManage}
        onRefresh={() => router.refresh()}
        onMovimentar={onMovimentar}
        onCriar={onCriar}
        onEditar={onEditar}
        onStatus={onStatus}
        onRemover={onRemover}
      />
    </DesignScreen>
  );
}
