import type { CapturePolicy, SharpMode } from "@/src/generated/prisma/client";
import { toNumber } from "@/src/domain/money";
import { prisma } from "@/src/infra/prisma";
import { resolveLogoUrl } from "@/src/services/painel/logos";
import type { CaptureStakeSettings } from "@/src/domain/capture-stake-policy";

/** Dados da página Config — bancas editáveis + taxonomia de mercados. */

export type BankrollConfigRow = CaptureStakeSettings & {
  id: string;
  nome: string;
  slug: string;
  valorUnidade: number;
  capitalInicial: number;
  sharpMode: SharpMode;
  capturePolicy: CapturePolicy;
  vincularContas: boolean;
  telegramChannelId: string | null;
  defaultBookmaker: string | null;
  logoUrl: string | null;
  betCount: number;
  /** Esportes marcados pelo dono; vazio = "vários/não sei". */
  channelSports: string[];
  capturePausedAt: Date | null;
  /** Apostas com esporte confirmado por evidência (não pela marcação do canal), do maior para o menor. */
  confirmedSports: Array<{ sport: string; bets: number }>;
};

export type MercadoConfigRow = {
  id: string;
  nome: string;
  aliases: Array<{ id: string; alias: string }>;
};

export async function getConfigPageData(): Promise<{
  bankrolls: BankrollConfigRow[];
  mercados: MercadoConfigRow[];
}> {
  const [bankrolls, mercados, confirmedSports] = await Promise.all([
    prisma.bankroll.findMany({
      orderBy: { nome: "asc" },
      select: {
        id: true,
        nome: true,
        slug: true,
        valorUnidade: true,
        capitalInicial: true,
        sharpMode: true,
        capturePolicy: true,
        stakePolicy: true,
        defaultStakeUnits: true,
        vincularContas: true,
        telegramChannelId: true,
        defaultBookmaker: true,
        channelSports: true,
        capturePausedAt: true,
        _count: { select: { bets: true } },
      },
    }),
    prisma.mercadoPadrao.findMany({
      where: { ativo: true },
      orderBy: { nome: "asc" },
      select: {
        id: true,
        nome: true,
        aliases: { orderBy: { alias: "asc" }, select: { id: true, alias: true } },
      },
    }),
    // Sugestão para marcar os esportes do canal: o que o histórico confirmou.
    prisma.bet.groupBy({
      by: ["bankrollId", "esporte"],
      where: { deletedAt: null, sportResolutionStatus: "CONFIRMED", sportSource: { not: "CHANNEL" } },
      _count: { _all: true },
    }),
  ]);
  const sportsByBankroll = new Map<string, Array<{ sport: string; bets: number }>>();
  for (const row of confirmedSports) {
    const list = sportsByBankroll.get(row.bankrollId) ?? [];
    list.push({ sport: row.esporte, bets: row._count._all });
    sportsByBankroll.set(row.bankrollId, list);
  }

  return {
    bankrolls: bankrolls.map((b) => ({
      id: b.id,
      nome: b.nome,
      slug: b.slug,
      valorUnidade: toNumber(b.valorUnidade),
      capitalInicial: toNumber(b.capitalInicial),
      sharpMode: b.sharpMode,
      capturePolicy: b.capturePolicy,
      stakePolicy: b.stakePolicy,
      defaultStakeUnits: b.defaultStakeUnits === null ? null : toNumber(b.defaultStakeUnits),
      vincularContas: b.vincularContas,
      telegramChannelId: b.telegramChannelId === null ? null : String(b.telegramChannelId),
      defaultBookmaker: b.defaultBookmaker,
      logoUrl: resolveLogoUrl(b.slug, b.id),
      betCount: b._count.bets,
      channelSports: b.channelSports,
      capturePausedAt: b.capturePausedAt,
      confirmedSports: (sportsByBankroll.get(b.id) ?? []).sort((a, z) => z.bets - a.bets),
    })),
    mercados,
  };
}
