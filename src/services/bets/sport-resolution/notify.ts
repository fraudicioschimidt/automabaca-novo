import type { Prisma } from "@/src/generated/prisma/client";
import { SPORT_AUTO_CONFIRM_MIN_CONFIDENCE } from "@/src/domain/sports/detect";
import { mensagemConflitoDeEsporte, mensagemEsportePendente } from "@/src/domain/sport-pending";
import { prisma } from "@/src/infra/prisma";
import { sendOperatorNotification } from "@/src/services/ops/alerts";
import { votingCandidates } from "./decision";
import type { SportResolutionRun } from "./types";

/**
 * Tentativas automáticas esgotadas: o dono decide, e fica sabendo na hora —
 * sem o esporte não há identidade, CLV nem resposta no canal. A notificação
 * leva junto o que a busca achou e quem discordou, para a decisão sair do
 * celular.
 *
 * Só avisa sobre aposta que ainda importa: viva, pendente e de fato sem
 * modalidade confirmada entre a última tentativa e agora. O dedupe por conteúdo
 * e aposta do `sendOperatorNotification` cobre o resto.
 */
export async function avisarEsportePendente(run: SportResolutionRun): Promise<boolean> {
  const bet = await prisma.bet.findUnique({
    where: { id: run.betId },
    select: { evento: true, status: true, deletedAt: true, sportResolutionStatus: true },
  });
  if (!bet || bet.deletedAt || bet.status !== "PENDING") return false;
  if (bet.sportResolutionStatus === "CONFIRMED") return false;
  return sendOperatorNotification(mensagemEsportePendente({
    evento: bet.evento,
    candidates: votingCandidates(run.candidates),
    limiar: SPORT_AUTO_CONFIRM_MIN_CONFIDENCE,
    reason: run.reason,
    ...(run.dissent ? { dissent: run.dissent } : {}),
  }), { key: `sport-pending:${run.betId}` });
}

/** Marca, na auditoria da aposta, que o conflito já foi avisado. */
const CONFLICT_NOTICE_ACTION = "bet.sport_conflict_notified";

/**
 * O dono já soube do conflito desta aposta: pelo aviso do resolvedor ou pela
 * chegada que disse que as fontes discordam. O resolvedor não repete.
 */
export async function markSportConflictNotified(betId: string, actor: string, details: Prisma.InputJsonObject): Promise<void> {
  await prisma.auditEvent.create({ data: {
    actor, action: CONFLICT_NOTICE_ACTION, resource: "bet", resourceId: betId, details,
  } });
}

/**
 * Conflito que o resolvedor achou: o dono fica sabendo na hora, com o que a
 * busca achou e quem discorda. O conflito não se resolve sozinho, e o CLV
 * depende de o dono decidir antes do jogo. Uma vez por aposta: só a marca
 * gravada de um aviso entregue segura este. Só o post avulso avisa o conflito
 * na chegada; o lote, a DM e o conserto pela DM contam com este aviso.
 */
export async function avisarConflitoDeEsporte(run: SportResolutionRun): Promise<boolean> {
  if (run.status !== "conflict") return false;
  const bet = await prisma.bet.findUnique({
    where: { id: run.betId },
    select: { evento: true, deletedAt: true, sportResolutionStatus: true },
  });
  if (!bet || bet.deletedAt || bet.sportResolutionStatus !== "CONFLICT") return false;
  const avisado = await prisma.auditEvent.findFirst({
    where: { resource: "bet", resourceId: run.betId, action: CONFLICT_NOTICE_ACTION },
    select: { id: true },
  });
  if (avisado) return false;
  const delivered = await sendOperatorNotification(mensagemConflitoDeEsporte({
    evento: bet.evento,
    candidates: votingCandidates(run.candidates),
    reason: run.reason,
    ...(run.dissent ? { dissent: run.dissent } : {}),
  }), { key: `sport-conflict:${run.betId}` });
  if (delivered) {
    await markSportConflictNotified(run.betId, "sport-resolver", {
      reason: run.reason, ...(run.dissent ? { dissent: run.dissent } : {}),
    });
  }
  return delivered;
}

/** Dead-letter da resolução: a busca desistiu por falha técnica, não por dúvida. */
export async function avisarBuscaDeEsporteDesistiu(betId: string): Promise<boolean> {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: { evento: true, deletedAt: true, sportResolutionStatus: true, bankroll: { select: { nome: true } } },
  });
  if (!bet || bet.deletedAt || bet.sportResolutionStatus === "CONFIRMED") return false;
  const onde = `${bet.evento} (tipster ${bet.bankroll.nome})`;
  return sendOperatorNotification(
    `❓ Esporte não identificado · ${onde}\n`
      + "A busca automática desistiu depois de várias falhas técnicas.\n"
      + "👉 Confirme o esporte na caixa de ações do painel.",
    { key: `sport-dlq:${betId}` },
  );
}
