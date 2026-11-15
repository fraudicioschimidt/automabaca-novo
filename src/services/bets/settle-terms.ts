import type { Prisma } from "@/src/generated/prisma/client";
import { canonicalJson } from "@/src/domain/canonical-json";
import { toNumber } from "@/src/domain/money";

export class BetSettlementTermsChangedError extends Error {
  constructor(betId: string) {
    super(`Aposta ${betId} sofreu mutação material de termos ou identidade antes da liquidação.`);
    this.name = "BetSettlementTermsChangedError";
  }
}

/** Dados usados para buscar e interpretar o resultado externo. */
export type BetSettlementTerms = {
  id: string;
  /** Revisão lida antes da consulta; detecta remover/restaurar e editar/desfazer. */
  manualSettlementVersion?: number;
  status?: string;
  casaDeAposta?: string;
  playerPropRevision?: number;
  mercado: string;
  selecao: string;
  odds: unknown;
  stake: unknown;
  evento: string;
  esporte: string;
  competicao: string;
  pais: string;
  data: Date;
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  kickoffInferido?: boolean;
  liveTextAtCapture?: boolean;
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
  legsJson?: unknown;
};

/** Deve rodar na mesma transação Serializable que grava resultado ou evidência. */
export async function assertBetSettlementTermsTx(
  tx: Prisma.TransactionClient,
  bet: BetSettlementTerms,
  options: { allowSettledTransition?: boolean } = {},
): Promise<void> {
  const current = await tx.bet.findUniqueOrThrow({
    where: { id: bet.id },
    select: {
      manualSettlementVersion: true, status: true, deletedAt: true,
      mercado: true, selecao: true, odds: true, stake: true,
      casaDeAposta: true, playerProp: { select: { revision: true } },
      evento: true, esporte: true, competicao: true, pais: true,
      data: true, kickoffInferido: true, registradoEm: true, sourcePostedAt: true,
      liveTextAtCapture: true, liveScoreHome: true, liveScoreAway: true, legsJson: true,
    },
  });

  // Uma edição pode manter a seleção (ex.: Over 2.5) e trocar o jogo,
  // as pernas ou o placar na entrada. A resposta antiga precisa ser descartada.
  // O ciclo pode acabar de liquidar a aposta antes de gravar a observação.
  // Uma única saída de PENDING é compatível; reabrir ou restaurar exige leitura nova.
  const settledTransition = options.allowSettledTransition && bet.status === "PENDING" &&
    current.status !== "PENDING" && current.manualSettlementVersion === (bet.manualSettlementVersion ?? 0) + 1;
  const termsMutated =
    current.deletedAt != null ||
    (bet.manualSettlementVersion !== undefined && current.manualSettlementVersion !== bet.manualSettlementVersion && !settledTransition) ||
    (bet.casaDeAposta !== undefined && current.casaDeAposta !== bet.casaDeAposta) ||
    (bet.playerPropRevision !== undefined && current.playerProp?.revision !== bet.playerPropRevision) ||
    current.mercado !== bet.mercado ||
    current.selecao !== bet.selecao ||
    toNumber(current.odds) !== toNumber(bet.odds) ||
    toNumber(current.stake) !== toNumber(bet.stake) ||
    current.evento !== bet.evento ||
    current.esporte !== bet.esporte ||
    current.competicao !== bet.competicao ||
    current.pais !== bet.pais ||
    current.data.getTime() !== bet.data.getTime() ||
    current.kickoffInferido !== (bet.kickoffInferido ?? false) ||
    current.registradoEm.getTime() !== bet.registradoEm.getTime() ||
    (current.sourcePostedAt?.getTime() ?? null) !== (bet.sourcePostedAt?.getTime() ?? null) ||
    (bet.liveTextAtCapture !== undefined && current.liveTextAtCapture !== bet.liveTextAtCapture) ||
    current.liveScoreHome !== (bet.liveScoreHome ?? null) ||
    current.liveScoreAway !== (bet.liveScoreAway ?? null) ||
    canonicalJson(current.legsJson) !== canonicalJson(bet.legsJson ?? null);

  if (termsMutated) {
    throw new BetSettlementTermsChangedError(bet.id);
  }
}
