import "server-only";
import type { Prisma } from "@/src/generated/prisma/client";
import { queryChannelDecisions, type ChannelDecision } from "@/src/services/bankrolls/channel-decision";
import { resolveLogoUrl } from "@/src/services/painel/logos";

/**
 * Ranking de canais para o painel, melhor evidência de edge primeiro: a régua
 * de `queryChannelDecisions` com a logo de cada banca, que só o web serve.
 */
export type CanalDecisaoRow = ChannelDecision & { logoUrl: string | null };

/** Com `bankrollId`, só a decisão daquela banca (a ficha e a lista não precisam das outras). */
export async function getCanaisDecisao(ref: Date = new Date(), filter: { bankrollId?: string } = {}, client?: Prisma.TransactionClient): Promise<CanalDecisaoRow[]> {
  return (await queryChannelDecisions(ref, filter, client)).map((row) => ({ ...row, logoUrl: resolveLogoUrl(row.slug, row.id) }));
}
