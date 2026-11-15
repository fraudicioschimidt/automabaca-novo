import type { ParsedBetPost, ResolvedCaptureBet } from "@/src/domain/bet-capture";
import type { SportResolutionDecision } from "@/src/domain/sports/detect";
import type { SourceMessageRef } from "@/src/infra/llm/cascade";
import { createLogger } from "@/src/infra/logger";
import { markSoccerReserveTeams } from "@/src/domain/text";
import { privacyHash } from "@/src/infra/privacy";
import {
  finalizeParsedBetForCapture,
  type CaptureGuardReject,
} from "@/src/services/capture/preparation/parse-capture-guard";
import {
  retryHandicapLineWhenTruncated,
  retryHandicapSideWhenMissingTeam,
  type PostImages,
} from "@/src/services/capture/preparation/parse-capture-handicap-retry";
import {
  cornersTotalByLine,
  needsSoccerTotalMarketRetry,
  retryAmbiguousSoccerTotalMarket,
} from "@/src/services/capture/preparation/parse-capture-market-retry";
import type { CapturePolicy } from "@/src/generated/prisma/enums";
import { canonicalizeBetForRegistration } from "@/src/services/bets/canonicalize-registration";
import { resolveSportForCaptureAsync, sportStoredValue, totalLineImplausible } from "@/src/services/bets/sport-resolution/capture";

const log = createLogger("capture-finalize");

/**
 * Referência curta do post para a telemetria de modelos: identifica a mensagem
 * no painel sem gravar chat, texto ou imagem (mesmo hash usado nos logs).
 */
export function captureItemRef(chatId: bigint | string, messageId: number): SourceMessageRef {
  return { chatIdHash: privacyHash(String(chatId), "telegram-chat"), messageId };
}

/** Baixa as páginas uma vez só, na primeira releitura que precisar delas. */
function loadOnce(images: PostImages): PostImages {
  let loaded: ReturnType<PostImages> | undefined;
  return () => (loaded ??= images());
}

/** A aposta pronta para o registro, com o esporte decidido, ou a recusa do guard. */
export type PreparedCapture = CaptureGuardReject | { ok: true; bet: ResolvedCaptureBet };

/**
 * A aposta lida, pronta para o registro: releituras da imagem, guard,
 * canonização (DNB, dupla chance, os nomes que o dono treinou) e o esporte,
 * decidido uma vez só. Ordem: AH truncado → AH sem lado (círculo) → guard →
 * total sem unidade → canonização → esporte.
 */
export async function prepareBetForCapture(params: {
  bet: ParsedBetPost;
  /** A legenda que o guard lê: a do post, ou só os números do item de um lote ou da correção do dono. */
  caption: string;
  /** A legenda do post, que a decisão do esporte lê. Padrão: `caption`. */
  postCaption?: string;
  /** A legenda traz outras apostas além desta (item de lote): não prova o placar ao vivo dela. */
  sharedCaption?: boolean;
  capturePolicy: CapturePolicy;
  /** Páginas do post, lidas só se uma releitura precisar; sem elas não há releitura. */
  images?: PostImages;
  /** A aposta veio do print. Padrão: há páginas. O conserto pela DM relê sem baixá-las. */
  readFromImage?: boolean;
  /** A odd foi respondida pelo dono no conserto pela DM: não passa pelo teto da leitura automática. */
  oddsFromOwner?: boolean;
  /** Post de origem, para as métricas das releituras apontarem a mensagem. */
  itemRef?: SourceMessageRef;
  /** Esportes do canal (Config › Tipsters); vazio = "vários/não sei". */
  channelSports?: readonly string[];
  /** O esporte que o dono escolheu no conserto pela DM: vale sem passar pelo resolvedor. */
  ownerSport?: SportResolutionDecision;
  /**
   * O post tinha print, mesmo quando ele não vem para reler (conserto pela DM):
   * a unidade do total então não é deduzida pela linha.
   */
  postHasImage?: boolean;
}): Promise<PreparedCapture> {
  let bet = params.bet;
  const { itemRef } = params;
  const images = params.images ? loadOnce(params.images) : undefined;
  const totalRetryOpts = { hasImage: Boolean(images), channelSports: params.channelSports };
  const decideSport = (guarded: ParsedBetPost) => params.ownerSport ?? resolveSportForCaptureAsync({
    bet: guarded, caption: params.postCaption ?? params.caption, channelSports: params.channelSports,
  });

  if (images) {
    const ahFixed = await retryHandicapLineWhenTruncated({ bet, images, itemRef });
    if (ahFixed) bet = ahFixed;
    const sideFixed = await retryHandicapSideWhenMissingTeam({ bet, images, itemRef });
    if (sideFixed) bet = sideFixed;
  }

  const source = {
    readFromImage: params.readFromImage ?? Boolean(params.images), oddsFromOwner: params.oddsFromOwner,
    channelSports: params.channelSports, sharedCaption: params.sharedCaption,
  };
  let result = finalizeParsedBetForCapture(bet, params.caption, params.capturePolicy, source);

  // A decisão do esporte precede a regra de totais de futebol: o "Over 5.5" de
  // "🏒 Frolunda x Farjestad" é de hóquei, e não um total sem unidade. Só
  // libera o total o esporte confirmado em cuja escala a linha cabe ("Over
  // 9.5" no basquete é outra unidade), ou o que o dono escolheu.
  let early: SportResolutionDecision | undefined;
  if (result.ok && result.bet.esporte.toLowerCase() === "unknown" &&
    needsSoccerTotalMarketRetry(result.bet, totalRetryOpts)) {
    const decision = await decideSport(result.bet);
    if (decision.status === "CONFIRMED" && decision.sport &&
      (params.ownerSport || !totalLineImplausible(decision.sport, result.bet))) {
      early = decision;
      result = { ok: true, bet: { ...result.bet, esporte: decision.sport, sportResolution: decision } };
    }
  }

  if (result.ok && needsSoccerTotalMarketRetry(result.bet, totalRetryOpts)) {
    // A releitura pode trocar o mercado, e o esporte é decidido de novo depois dela.
    early = undefined;
    const ambiguous = result.bet;
    const marketFixed = images
      ? await retryAmbiguousSoccerTotalMarket({ bet: ambiguous, images, itemRef })
      : null;
    // Sem print, a linha decide só no futebol confirmado: "Over 8.5" de
    // beisebol são corridas. Com print, só a releitura decide.
    const postHasImage = Boolean(images) || params.postHasImage === true;
    const byLine = postHasImage ? null : cornersTotalByLine(ambiguous);
    const soccer = byLine ? await decideSport(ambiguous) : null;
    if (marketFixed) {
      bet = marketFixed;
      result = finalizeParsedBetForCapture(bet, params.caption, params.capturePolicy, source);
    } else if (byLine && soccer?.status === "CONFIRMED" && soccer.sport === "Soccer") {
      bet = byLine;
      result = finalizeParsedBetForCapture(bet, params.caption, params.capturePolicy, source);
      if (result.ok) {
        early = soccer;
        result = { ok: true, bet: { ...result.bet, esporte: soccer.sport, sportResolution: soccer } };
        log.info({ evento: bet.evento, selecao: bet.selecao }, "total sem unidade gravado como escanteios pela linha");
      }
    } else {
      result = {
        ok: false,
        missing: ["mercado"],
        reason: "mercado_total_ambiguo",
      };
    }
  }

  if (!result.ok) {
    log.info(
      {
        reason: result.reason,
        missing: result.missing,
        capturePolicy: params.capturePolicy,
        evento: bet.evento,
      },
      "capture guard rejeitou aposta",
    );
    return result;
  }

  const guarded = result.bet;
  const canonical = await canonicalizeBetForRegistration(guarded);
  // A decisão antecipada vale como a da captura: confirmada, e sem releitura
  // depois dela. Senão, o esporte é decidido sobre a aposta canonizada, com o
  // país e a competição que o guard canonizou (desempatam homônimos).
  const sportResolution = early ?? await decideSport(canonical);
  // Confirmado noutro esporte, os nomes e o mercado voltam a ser canonizados a
  // partir da aposta do guard: os nomes treinados e o DNB dependem do esporte.
  const final = sportResolution.status === "CONFIRMED" && sportResolution.sport && sportResolution.sport !== canonical.esporte
    ? await canonicalizeBetForRegistration({ ...guarded, esporte: sportResolution.sport })
    : canonical;
  const esporte = sportStoredValue(sportResolution);
  // O "R" de reserva do tipster vira "Reserva" no futebol confirmado; com o
  // esporte ainda pendente, quem marca é a confirmação dele (`confirmBetSport`).
  const marked = esporte === "Soccer" ? markSoccerReserveTeams(final) : final;
  return { ok: true, bet: { ...final, ...marked, esporte, sportResolution } };
}
