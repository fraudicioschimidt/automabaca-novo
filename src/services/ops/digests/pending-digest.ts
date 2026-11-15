import { formatSpDateTime, spDayKey, spRelative } from "@/src/domain/dates";
import { DAILY_NOTIFICATION_DEDUPE_MS, OPERATOR_MESSAGE_MAX_CHARS, truncateOperatorMessage } from "@/src/domain/mensagem-operador";
import { sendRequiredOperatorNotification } from "@/src/services/ops/alerts";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { listPostponedWaitingBetIds } from "@/src/services/settlement/flashscore/observation-store";

const log = createLogger("pending-digest");

/**
 * Digest diário de apostas PENDENTES provavelmente encerradas (kickoff >6h)
 * — onde o placar não chega pelo feed (escanteios, tênis…) o operador
 * liquida no painel; o 👎 no post só remove a aposta que ele não fez. Este
 * resumo garante que nada fique esquecido.
 * Uma mensagem, agrupada por banca, com teto de 25 linhas.
 */

const VENCIDA_APOS_MS = 6 * 3_600_000;
const MAX_LINHAS = 25;
/** Teto dos resumos, em caracteres Unicode: abaixo dos 4096 de uma mensagem do Telegram. */
export const DIGEST_MAX_CHARS = OPERATOR_MESSAGE_MAX_CHARS;

/** O sufixo do corte manda o dono para `screen`, a tela que tem o resto do resumo. */
export function truncatePendingDigestMessage(
  raw: string,
  maxChars = DIGEST_MAX_CHARS,
  screen = "Operações",
): string {
  return truncateOperatorMessage(raw, maxChars, `\n… resumo truncado; veja ${screen}.`);
}

export async function sendPendingDigest(now = new Date()): Promise<{ pendentes: number }> {
  const where = {
      deletedAt: null,
      status: "PENDING",
      data: { lte: new Date(now.getTime() - VENCIDA_APOS_MS) },
      // Adiado em graça de 48h não é "falta liquidar" — é espera deliberada do
      // FlashScore, como no card `settlement.parado`. Sem isto o digest mandaria
      // o operador liquidar jogo que não aconteceu.
      id: { notIn: await listPostponedWaitingBetIds(now) },
    } as const;
  const [total, bets] = await Promise.all([
    prisma.bet.count({ where }),
    prisma.bet.findMany({
      where,
      orderBy: { data: "asc" },
      take: 200,
      select: {
        evento: true,
        mercado: true,
        selecao: true,
        data: true,
        bankroll: { select: { id: true, nome: true, slug: true } },
      },
    }),
  ]);
  if (total === 0) return { pendentes: 0 };

  const porBanca = new Map<string, typeof bets>();
  for (const b of bets) {
    const lista = porBanca.get(b.bankroll.id) ?? [];
    lista.push(b);
    porBanca.set(b.bankroll.id, lista);
  }

  const linhas: string[] = [];
  for (const lista of porBanca.values()) {
    const banca = lista[0]!.bankroll;
    linhas.push(`\n📁 ${banca.nome} (${banca.slug}) (${lista.length})`);
    for (const b of lista.slice(0, MAX_LINHAS)) {
      // `spRelative` e não um `${horas}h` local: kickoff de 51h vira "há 2 d" e
      // um kickoff ainda no futuro sai "em 3 h" em vez de "há -3h".
      linhas.push(`• ${b.evento}: ${b.mercado} ${b.selecao} (começou ${spRelative(b.data, now)}, ${formatSpDateTime(b.data)})`);
    }
    if (lista.length > MAX_LINHAS) linhas.push(`… e mais ${lista.length - MAX_LINHAS}.`);
  }

  const omitted = Math.max(0, total - bets.length);
  const suffix = omitted > 0 ? `\n… e mais ${omitted} fora desta amostra.` : "";
  const raw =
    `⏳ ${total} aposta(s) sem resultado\n` +
    "O jogo começou há mais de 6h e ninguém liquidou ainda.\n" +
    `👉 Liquide em Operações. Use 👎 só se você não fez a aposta.${linhas.join("\n")}${suffix}`;
  const message = truncatePendingDigestMessage(raw);
  const delivery = await sendRequiredOperatorNotification(message, {
    key: `pending-digest:${spDayKey(now)}`, forMs: DAILY_NOTIFICATION_DEDUPE_MS,
  });
  log.info({ pendentes: total, listadas: bets.length, delivery }, "digest de pendentes entregue");
  return { pendentes: total };
}
