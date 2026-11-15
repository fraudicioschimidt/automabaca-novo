// A remoção em palavras, igual na lista "Removidas" da banca e na ficha.
import { fmtU } from "@/src/domain/formato-de-resultado";
import type { StatusDeTela } from "@/src/domain/status-de-aposta";
import type { BetRemovalView } from "../adapters/aposta";

const STATUS: Record<StatusDeTela, string> = {
  pending: "pendente", won: "ganha", halfwon: "½ ganha", lost: "perdida",
  half: "½ perdida", void: "reembolso", cashout: "cashout",
};

/** "pelo 👎 no canal" ou "pelo painel". */
export function removalOriginText(origin: BetRemovalView["origin"]): string {
  return origin === "reacao" ? "pelo 👎 no canal" : "pelo painel";
}

/** O que a aposta era ao sair: o resultado que o estorno desfez, ou que ainda estava pendente. */
export function previousResultText(previous: BetRemovalView["previous"]): string | null {
  if (!previous) return null;
  if (previous.profit == null) return "estava pendente";
  return `era ${STATUS[previous.status]} (${fmtU(previous.profit)}), resultado estornado`;
}
