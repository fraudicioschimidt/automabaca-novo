import { betExportStatusLabel } from "@/src/domain/bet-export";
import { fmtPct } from "@/src/domain/formato-de-resultado";

/**
 * Peças comuns das mensagens do bot de notificação. Um só vocabulário para o
 * resultado e o CLV: antes cada serviço escrevia "WON (+1.50u)" ou "CLV +2.1%"
 * do seu jeito, com o enum do banco cru no meio do texto.
 */

/** "Ganha", "Meia perda", "Reembolso"… — o mesmo rótulo da exportação. */
export function rotuloStatus(status: string): string {
  return betExportStatusLabel(status);
}

export function emojiStatus(status: string): string {
  if (status === "WON" || status === "HALF_WON") return "🟢";
  if (status === "LOST" || status === "HALF_LOST") return "🔴";
  if (status === "VOID" || status === "CANCELED") return "↩️";
  return "⚪";
}

/** "CLV +2.1% 🟢"; sem número, diz que não há, em vez de "CLV —". */
export function linhaClv(clv: number | null | undefined): string {
  if (clv == null || !Number.isFinite(clv)) return "CLV indisponível";
  const cor = clv > 0 ? " 🟢" : clv < 0 ? " 🔴" : "";
  return `CLV ${fmtPct(clv)}${cor}`;
}

/**
 * Quanto a odd justa andou da abertura ao fechamento: "2.100 → 1.950 (−7.1%)".
 * Queda = o mercado passou a acreditar mais na seleção.
 */
export function linhaMovimento(aberturaJusta: number, fechamentoJusta: number): string {
  const variacao = (fechamentoJusta / aberturaJusta - 1) * 100;
  return `Abertura → fechamento (justas): ${aberturaJusta.toFixed(3)} → ${fechamentoJusta.toFixed(3)} (${fmtPct(variacao)})`;
}

/** A chave inclui o dia; o prazo cobre retries sem bloquear o resumo seguinte. */
export const DAILY_NOTIFICATION_DEDUPE_MS = 2 * 86_400_000;

/** A margem comporta o aviso de corte sem exceder o teto de uma mensagem. */
export const OPERATOR_MESSAGE_MAX_CHARS = 3_900;

/** Corta por caractere Unicode e prefere terminar numa linha completa. */
export function truncateOperatorMessage(
  raw: string,
  maxChars = OPERATOR_MESSAGE_MAX_CHARS,
  suffix = "\n… mensagem truncada; veja o painel.",
): string {
  const chars = Array.from(raw);
  if (chars.length <= maxChars) return raw;
  const suffixChars = Array.from(suffix);
  if (suffixChars.length >= maxChars) return suffixChars.slice(0, Math.max(0, maxChars)).join("");
  const budget = maxChars - suffixChars.length;
  const candidate = chars.slice(0, budget).join("").trimEnd();
  const lastLineBreak = candidate.lastIndexOf("\n");
  const safePrefix = lastLineBreak >= Math.floor(budget * 0.6)
    ? candidate.slice(0, lastLineBreak).trimEnd()
    : candidate;
  return `${safePrefix}${suffix}`;
}
