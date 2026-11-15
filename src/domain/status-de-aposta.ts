import { ALL_BET_STATUSES, FINAL_BET_STATUSES } from "@/src/domain/bet-status";

/**
 * Vocabulário de resultado da aposta (status do domínio → slug da tela → PT),
 * numa implementação só para adapters, gaveta, calendário e prosa do domínio.
 *
 * Client-safe e sem I/O: roda no navegador e também no servidor
 * (`domain/trilha-da-aposta` escreve "liquidada como **ganha**"). Mora no
 * domínio porque o domínio não importa do design.
 */

/** Slug da tela — vocabulário que os componentes portados já falam. */
export type StatusDeTela =
  | "pending" | "won" | "halfwon" | "lost" | "half" | "void" | "cashout";

/**
 * Status de tela que entram em lucro, stake finalizada e ROI (com impacto no PnL).
 * @public
 */
export const STATUS_DE_TELA_FINANCEIROS_SET: ReadonlySet<StatusDeTela> = new Set(
  FINAL_BET_STATUSES.map(statusDeTela),
);

/**
 * Status de tela que representam apostas concluídas/resolvidas (incluindo void/canceladas).
 * @public
 */
export const STATUS_DE_TELA_FINALIZADOS_SET: ReadonlySet<StatusDeTela> = new Set(
  ALL_BET_STATUSES.filter((status) => status !== "PENDING").map(statusDeTela),
);

/**
 * Status do domínio → slug da tela.
 *
 * VOID/CANCELED = "void" (resolvida sem efeito financeiro), nunca "½ perdida".
 * HALF_WON = "halfwon", nunca "won"
 * pleno. Desconhecido cai em "void": neutro, para nunca pintar ganho ou perda
 * que não aconteceu.
 */
export function statusDeTela(status: string): StatusDeTela {
  switch (status) {
    case "PENDING":
      return "pending";
    case "WON":
      return "won";
    case "HALF_WON":
      return "halfwon";
    case "LOST":
      return "lost";
    case "HALF_LOST":
      return "half";
    case "CASHOUT":
      return "cashout";
    case "VOID":
    case "CANCELED":
      return "void";
    default:
      return "void";
  }
}

const ROTULOS: Record<StatusDeTela, string> = {
  pending: "pendente",
  won: "ganha",
  halfwon: "½ ganha",
  lost: "perdida",
  half: "½ perdida",
  void: "reembolso",
  cashout: "cashout",
};

/** Slug da tela → rótulo em PT-BR. */
export function rotuloDeStatusDeTela(slug: string): string {
  return ROTULOS[slug as StatusDeTela] ?? "";
}

/** Status do domínio → rótulo em PT-BR, direto (o caminho da gaveta). */
export function rotuloDeStatus(status: string): string {
  return ROTULOS[statusDeTela(status)];
}
