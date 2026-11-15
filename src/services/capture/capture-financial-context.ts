import { prisma } from "@/src/infra/prisma";
import { telegramChannelSource } from "@/src/domain/telegram-source";
import { validateCaptureStakeSettings } from "@/src/domain/capture-stake-policy";
import { toNumber } from "@/src/domain/money";
import type { ChannelBankroll } from "@/src/services/bankrolls/lookup";
import { runSerializableTransaction } from "@/src/services/shared/transaction";

export type FinancialChannelBankroll = ChannelBankroll & { financialContextId: string };
export type FinancialSource = { source: string; sourceExternalId: string };

export function channelFinancialSource(post: { chatId: bigint; messageId: number; mediaGroupId?: string }): FinancialSource {
  return { source: telegramChannelSource(post.chatId), sourceExternalId: post.mediaGroupId ? `album:${post.mediaGroupId}` : String(post.messageId) };
}

/** Primeira associação confirmada no banco vence, inclusive com retries concorrentes. */
export async function captureFinancialContext(source: FinancialSource, target: { bankrollId: string; explicitStake?: boolean } | { chatId: bigint }) {
  return runSerializableTransaction("capture.financial-context", async (tx) => {
    // SSI + unique resolvem a corrida; nunca atualizar a configuração conservada.
    const previous = await tx.captureFinancialContext.findUnique({ where: { source_sourceExternalId: source } });
    if (previous) return previous;
    const bankroll = await tx.bankroll.findFirst({ where: { ...( "bankrollId" in target ? { id: target.bankrollId } : { telegramChannelId: target.chatId }) } });
    if (!bankroll) return null;
    // DM confirma uma stake explícita na prévia; não aplicar a política do canal.
    const settings = validateCaptureStakeSettings("explicitStake" in target && target.explicitStake
      ? { stakePolicy: "MESSAGE", defaultStakeUnits: null }
      : { stakePolicy: bankroll.stakePolicy, defaultStakeUnits: bankroll.defaultStakeUnits === null ? null : toNumber(bankroll.defaultStakeUnits) });
    await tx.captureFinancialContext.createMany({ data: [{ ...source, bankrollId: bankroll.id, valorUnidade: bankroll.valorUnidade, ...settings, imageStakeAsUnits: bankroll.imageStakeAsUnits }], skipDuplicates: true });
    return tx.captureFinancialContext.findUniqueOrThrow({ where: { source_sourceExternalId: source } });
  });
}

export async function captureChannelFinancialContext(post: { chatId: bigint; messageId: number; mediaGroupId?: string }): Promise<FinancialChannelBankroll | null> {
  const mediaGroupId = post.mediaGroupId ?? await albumWonBy(post);
  const context = await captureFinancialContext(channelFinancialSource({ ...post, ...(mediaGroupId ? { mediaGroupId } : {}) }), { chatId: post.chatId });
  if (!context) return null;
  // Apresentação e políticas não financeiras continuam vindo da banca associada.
  const bankroll = await prisma.bankroll.findFirst({ where: { id: context.bankrollId }, select: { id: true, nome: true, slug: true, capturePolicy: true, defaultBookmaker: true, channelSports: true, capturePausedAt: true } });
  return bankroll ? { ...bankroll, financialContextId: context.id, stakePolicy: context.stakePolicy, defaultStakeUnits: context.defaultStakeUnits === null ? null : toNumber(context.defaultStakeUnits), imageStakeAsUnits: context.imageStakeAsUnits } : null;
}

/**
 * O conserto pela DM, a captura forçada e a edição chegam sem o álbum, mas a
 * foto vencedora dele tem a configuração presa na chegada do álbum. Só a
 * vencedora: o registro só aceita o contexto do álbum para ela.
 */
async function albumWonBy(post: { chatId: bigint; messageId: number }): Promise<string | undefined> {
  const album = await prisma.telegramMediaAlbum.findFirst({
    where: { chatId: String(post.chatId), winnerMessageId: post.messageId },
    select: { mediaGroupId: true },
  });
  return album?.mediaGroupId;
}
