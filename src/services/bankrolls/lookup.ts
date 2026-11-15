import type { CapturePolicy } from "@/src/generated/prisma/enums";
import { prisma } from "@/src/infra/prisma";
import { toNumber } from "@/src/domain/money";
import type { CaptureStakeSettings } from "@/src/domain/capture-stake-policy";

/** Leituras de banca usadas pela camada Telegram, que não toca tabela direto. */

export type ChannelBankroll = CaptureStakeSettings & {
  /** Referência interna criada antes do parsing, nunca fornecida pela IA. */
  financialContextId?: string;
  id: string;
  nome: string;
  /** Slug estável — usado em href, logo e telemetria. */
  slug: string;
  /** De onde vem a odd autoritativa neste canal (dado, não heurística de slug). */
  capturePolicy: CapturePolicy;
  imageStakeAsUnits?: boolean;
  defaultBookmaker: string | null;
  /** Esportes que o canal posta (Config › Tipsters); vazio = "vários/não sei". */
  channelSports?: readonly string[];
  /** Captura pausada pelo dono: post novo vai para os descartados sem leitura. */
  capturePausedAt?: Date | null;
};

/** Banca ativa mapeada a um canal Telegram (`telegramChannelId`). Null = sem mapeamento. */
export async function findBankrollByChannel(chatId: bigint): Promise<ChannelBankroll | null> {
  const row = await prisma.bankroll.findFirst({
    where: { telegramChannelId: chatId },
    select: {
      id: true,
      nome: true,
      slug: true,
      capturePolicy: true,
      stakePolicy: true,
      defaultStakeUnits: true,
      imageStakeAsUnits: true,
      defaultBookmaker: true,
      channelSports: true,
      capturePausedAt: true,
    },
  });
  return row ? { ...row, defaultStakeUnits: row.defaultStakeUnits === null ? null : toNumber(row.defaultStakeUnits) } : null;
}

/** Bancas ativas para o seletor paginado de DM (ordem alfabética), com a política de odd que a prévia avisa. */
export async function listBankrollsParaSelecao(): Promise<
  Array<{ id: string; nome: string; slug: string; capturePolicy: CapturePolicy }>
> {
  return prisma.bankroll.findMany({
    orderBy: [{ nome: "asc" }, { slug: "asc" }],
    select: { id: true, nome: true, slug: true, capturePolicy: true },
  });
}

/** Slug + política de captura de uma banca (DM callback — só temos o id no botão). */
export async function findBankrollCaptureById(
  id: string,
): Promise<{ slug: string; capturePolicy: CapturePolicy; defaultBookmaker: string | null } | null> {
  return prisma.bankroll.findFirst({
    where: { id },
    select: { slug: true, capturePolicy: true, defaultBookmaker: true },
  });
}
