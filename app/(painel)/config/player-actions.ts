"use server";
import { revalidatePath } from "next/cache";
import { revalidateFinancialViews } from "../_revalidate";
import { actor, requireSession } from "../_auth";
import { getPlayersPanel, applyPlayerPanelCommand, type PlayerPanelCommand } from "@/src/services/players/panel";
import { refusalAsResult, type ActionResult } from "@/src/services/shared/recusa";

export async function loadPlayersAction(search?: string) {
  await requireSession();
  return getPlayersPanel(search);
}

/** A recusa do comando (aposta já liquidada, jogador sem escalação…) volta com a mensagem. */
export async function curatePlayerAction(command: PlayerPanelCommand): Promise<ActionResult> {
  const who = await actor();
  return refusalAsResult(async () => {
    await applyPlayerPanelCommand(command, who);
    revalidatePath("/config");
    // O resultado de uma prop muda aposta, saldo e a caixa de /operacoes.
    revalidateFinancialViews();
    return {};
  });
}
