import type { ResolvedCaptureBet } from "@/src/domain/bet-capture";
import { bookmakerFromBetLinks } from "@/src/domain/bookmaker-bet-link";
import { kickoffInferidoFromParsed } from "@/src/domain/kickoff-infer";
import { registerBet, type RegisterBetResult } from "@/src/services/bets/register";
import { sportStoredValue } from "@/src/services/bets/sport-resolution/capture";
import type { MercadoCatalogClient } from "@/src/services/mercados/normalize";
import type { SerializableTransactionClient } from "@/src/services/shared/transaction";

/**
 * De onde a aposta veio e como foi lida: o post do canal (ou o item de um
 * lote), o conserto do dono pela DM ou a aposta avulsa da DM.
 */
export type CaptureOrigin = {
  /** `telegram-channel:<chat>` ou `telegram-dm:<chat>:<banca>`. */
  source: string;
  /** A mensagem, ou `<mensagem>:<item>` no lote. */
  sourceExternalId: string;
  /** Instante da entrada: o do post, ou o da edição ou da correção que completou a aposta. */
  enteredAt: Date;
  /** O leitor que a evidência guarda: `universal`, o provedor (com `-vision`) ou `telegram-dm`. */
  parser: string;
  /** Quem grava, na auditoria. */
  actor: string;
  caption: string;
  /** A legenda traz outras apostas além desta (item de lote). */
  sharedCaption?: boolean;
  mediaFileId?: string;
  /** Páginas do álbum lidas juntas. */
  mediaFileIds?: string[];
  /** O dono pediu a captura ("Capturar mesmo assim", conserto): a latência do post não a conta. */
  forcedByOperator?: boolean;
  /** O dono completou a leitura (conserto pela DM): a aposta não mede o leitor. */
  completedByOwner?: boolean;
};

/**
 * O registro único da aposta capturada, pelo canal, pelo conserto ou pela DM:
 * a casa (a da leitura, a do link da aposta na legenda ou a padrão da banca),
 * o esporte decidido e a evidência da captura, gravados por `registerBet`.
 * Recusa, aviso, telemetria e fila seguinte são de quem chama.
 */
export async function registerCapturedBet(params: {
  bankroll: { id: string; defaultBookmaker: string | null; financialContextId?: string };
  bet: ResolvedCaptureBet;
  origin: CaptureOrigin;
  /** Transação do lote: os itens do post gravam juntos. */
  client?: SerializableTransactionClient & MercadoCatalogClient;
}): Promise<{ result: RegisterBetResult; finalBet: ResolvedCaptureBet }> {
  const { bankroll, origin } = params;
  const { sportResolution } = params.bet;
  const finalBet = {
    ...params.bet,
    // O guard por item de um lote pode omitir os links compartilhados da legenda.
    casaDeAposta: params.bet.casaDeAposta.trim() || bookmakerFromBetLinks(origin.caption) || bankroll.defaultBookmaker || "",
    esporte: sportStoredValue(sportResolution),
    sportResolution,
  };

  const result = await registerBet({
    bankrollId: bankroll.id,
    data: finalBet.data ?? origin.enteredAt,
    kickoffInferido: kickoffInferidoFromParsed(finalBet),
    evento: finalBet.evento,
    esporte: finalBet.esporte,
    sportResolutionStatus: sportResolution.status,
    sportConfidence: sportResolution.confidence,
    sportSource: sportResolution.source,
    sportEvidence: sportResolution.evidence,
    sportResolverVersion: sportResolution.resolverVersion,
    competicao: finalBet.competicao,
    pais: finalBet.pais,
    casaDeAposta: finalBet.casaDeAposta || bankroll.defaultBookmaker || "",
    mercado: finalBet.mercado,
    selecao: finalBet.selecao,
    liveScoreHome: finalBet.liveScoreHome,
    liveScoreAway: finalBet.liveScoreAway,
    liveScoreEvidence: finalBet.liveScoreEvidence,
    odds: finalBet.odds,
    stake: finalBet.stake,
    playerProp: finalBet.playerProp,
    ...(finalBet.legs ? { legsJson: finalBet.legs } : {}),
    source: origin.source,
    sourcePostedAt: origin.enteredAt,
    sourceExternalId: origin.sourceExternalId,
    actor: origin.actor,
    captureEvidence: {
      parser: origin.parser,
      caption: origin.caption.slice(0, 4_000),
      ...(origin.sharedCaption ? { sharedCaption: true } : {}),
      ...(origin.completedByOwner ? { completedByOwner: true } : {}),
      ...(origin.mediaFileId ? { mediaFileId: origin.mediaFileId } : {}),
      parsed: {
        evento: finalBet.evento,
        esporte: finalBet.esporte,
        competicao: finalBet.competicao,
        pais: finalBet.pais,
        mercado: finalBet.mercado,
        selecao: finalBet.selecao,
        liveScoreHome: finalBet.liveScoreHome ?? null,
        liveScoreAway: finalBet.liveScoreAway ?? null,
        liveScoreEvidence: finalBet.liveScoreEvidence,
        odds: finalBet.odds,
        stake: finalBet.stake,
        playerProp: finalBet.playerProp,
        stakeSource: finalBet.stakeSource,
        stakePolicySnapshot: finalBet.stakePolicySnapshot,
        ocrEvidence: finalBet.ocrEvidence,
        ...(origin.mediaFileIds ? { mediaFileIds: origin.mediaFileIds } : {}),
        data: finalBet.data?.toISOString() ?? null,
        kickoffDateOnly: finalBet.kickoffDateOnly ?? false,
        casaDeAposta: finalBet.casaDeAposta,
        sportResolution,
        ...(finalBet.legs ? { legs: finalBet.legs } : {}),
        // A latência post → 📥 do painel deixa de fora o que o dono mandou capturar depois.
        ...(origin.forcedByOperator ? { forcedByOperator: true } : {}),
        ...(finalBet.totalUnitFromLine ? { totalUnitFromLine: true } : {}),
      },
    },
  }, {
    ...(params.client ? { client: params.client } : {}), financialContextId: bankroll.financialContextId,
    ...(origin.completedByOwner ? { captureFollowupOrigin: "telegram-capture-fix" as const }
      : origin.parser === "telegram-dm" ? { captureFollowupOrigin: "telegram-dm" as const } : {}),
  });
  return { result, finalBet };
}
