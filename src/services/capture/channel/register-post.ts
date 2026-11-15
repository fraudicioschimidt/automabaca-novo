import { isMercadoFinal } from "@/src/domain/mercados/catalog";
import { moneylineSelectionUnreadable } from "@/src/domain/mercados/selecao";
import { ehMercadoArtilheiro, hasUnsupportedGoalQualifier } from "@/src/domain/settlement/goalscorer";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import { captureParsedSchema, captureReadingOf, type ParsedBetPost, type ResolvedCaptureBet } from "@/src/domain/bet-capture";
import { playerCaptureItemKey } from "@/src/domain/player-prop-capture";
import { sendOperatorNotification } from "@/src/services/ops/alerts";
import type { CaptureVia } from "@/src/services/capture/reading/read-bet-post";
import { kickoffInferidoFromParsed } from "@/src/domain/kickoff-infer";
import { editedAfterKickoff } from "@/src/domain/instante-da-entrada";
import { JANELA_DE_JOGO_MS } from "@/src/domain/entrada-ao-vivo";
import { extractLiveScoresAtTip, type LiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import {
  postExternalIdsWhere,
  postItemExternalId,
  telegramChannelActor,
  telegramChannelSource,
  telegramPostLink,
} from "@/src/domain/telegram-source";
import type { ChannelBankroll } from "@/src/services/bankrolls/lookup";
import { reportCaptureRefusal } from "@/src/services/capture/capture-review";
import type { PostImages } from "@/src/services/capture/preparation/parse-capture-handicap-retry";
import { captureItemRef, prepareBetForCapture } from "@/src/services/capture/preparation/prepare-capture";
import { recordParseTelemetry } from "@/src/services/capture/parse-telemetry";
import { reuseSerializableTransaction, runSerializableTransaction } from "@/src/services/shared/transaction";
import { findPostSourceUse } from "@/src/services/bets/register";
import { registerCapturedBet, type CaptureOrigin } from "@/src/services/capture/register-captured-bet";
import { reconcileCapturedReactionTx } from "@/src/services/capture/channel/reaction-decisions";
import type { CapturedBet } from "@/src/services/scheduling/enqueue-after-capture";
import { offerCaptureFix } from "@/src/services/capture/capture-fix";
import { recordDiscardedChannelPost } from "@/src/services/capture/channel/channel-post-archive";
import { markSportConflictNotified } from "@/src/services/bets/sport-resolution/notify";

const log = createLogger("tg-channel");


export type ChannelCaptureOutcome =
  | {
      kind: "registered";
      betId: string;
      sportResolutionStatus: "CONFIRMED" | "PENDING" | "CONFLICT";
      betIds?: string[];
      registeredBets?: CapturedBet[];
      notTaken?: boolean;
    }
  | { kind: "duplicate"; betId: string }
  | { kind: "skipped"; reason: string }
  | { kind: "ignored"; reason: string }
  | { kind: "unparseable"; missing: string[] };

/** Só diz COMO a aposta foi lida quando foi por IA; o nome do modelo não ajuda o operador. */
function origemDaLeitura(via: CaptureVia): string | null {
  const reading = captureReadingOf(via);
  if (reading === "ia_imagem") return "🤖 Lida da imagem por IA";
  return reading === "ia_texto" ? "🤖 Lida do texto por IA" : null;
}

/** O lote grande não estoura o aviso: as primeiras apostas e quantas faltam. */
const BATCH_NOTICE_ITEMS = 10;

/** Uma linha por aposta do lote. */
function batchNoticeLines(items: ReadonlyArray<Pick<ParsedBetPost, "evento" | "selecao" | "odds" | "stake">>): string[] {
  const lines = items.slice(0, BATCH_NOTICE_ITEMS).map((item) => `• ${item.evento} — ${item.selecao} @${item.odds} · ${item.stake}u`);
  const rest = items.length - lines.length;
  return rest > 0 ? [...lines, `… e mais ${rest}`] : lines;
}

/**
 * `editDate` só existe quando a aposta nasce de uma edição do post: é o
 * instante da entrada e o kickoff provisório, no lugar da data do post.
 */
export type CapturePost = {
  chatId: bigint; messageId: number; postDate: Date; editDate?: Date; forcedByOperator?: boolean;
  /** O pedido veio do 👍: as regras de jogo encerrado valem, mas a aposta nasce depois do post, a pedido do dono. */
  forcedByReaction?: boolean;
};

/**
 * Rascunho completado numa edição só vira aposta antes do kickoff lido. O dono
 * pegou o que chegou na hora: depois do jogo a edição é ignorada, sem aviso.
 */
function ignoreDraftEditedAfterKickoff(post: CapturePost, bets: ParsedBetPost[]): ChannelCaptureOutcome | null {
  if (post.forcedByOperator) return null;
  const editedAt = post.editDate;
  if (!editedAt || !bets.some((bet) => editedAfterKickoff(editedAt, bet))) return null;
  log.info(
    { eventCode: LOG_EVENTS.TELEGRAM_EDIT_IGNORED, chatId: String(post.chatId), messageId: post.messageId, reason: "edicao_depois_do_jogo" },
    "edição de post ignorada",
  );
  return { kind: "ignored", reason: "edicao_depois_do_jogo" };
}

/**
 * Post novo cujo kickoff lido já passou da janela de um jogo: é o jogo
 * terminado sendo comentado ou recapitulado, não entrada. Entrada ao vivo,
 * dentro da janela, segue.
 */
function refuseFinishedGame(post: CapturePost, bets: ParsedBetPost[]): ChannelCaptureOutcome | null {
  if (post.forcedByOperator || post.editDate) return null;
  const finished = bets.some((bet) => bet.data !== null && !kickoffInferidoFromParsed(bet) &&
    post.postDate.getTime() - bet.data.getTime() > JANELA_DE_JOGO_MS);
  if (!finished) return null;
  log.info({ chatId: String(post.chatId), messageId: post.messageId }, "post com jogo já terminado — não é entrada");
  return { kind: "skipped", reason: "jogo_ja_terminado" };
}

/** Captura avulsa: guard da banca, esporte, gravação, telemetria e aviso ao operador. */
export async function registerParsedPost(
  bankroll: ChannelBankroll,
  post: CapturePost,
  bet: ParsedBetPost,
  via: CaptureVia,
  caption: string,
  images?: PostImages,
  mediaFileId?: string,
): Promise<ChannelCaptureOutcome> {
  const prepared = await prepareBetForCapture({
    bet,
    caption,
    capturePolicy: bankroll.capturePolicy,
    images,
    postHasImage: Boolean(images || mediaFileId),
    itemRef: captureItemRef(post.chatId, post.messageId),
    channelSports: bankroll.channelSports,
  });
  if (!prepared.ok) {
    return refuseReadBet({
      post, bankroll, via, reason: prepared.reason, missing: prepared.missing, bet, caption, mediaFileId,
      photo: Boolean(images || mediaFileId),
    });
  }
  const lateEdit = ignoreDraftEditedAfterKickoff(post, [prepared.bet]) ?? refuseFinishedGame(post, [prepared.bet]);
  if (lateEdit) return lateEdit;
  const { result, finalBet } = await registerCapturedBet({
    bankroll, bet: prepared.bet, origin: channelOrigin(post, via, caption, { mediaFileId }),
  });

  if (!result.created) {
    await recordParseTelemetry(post, "duplicate", { via });
    return { kind: "duplicate", betId: result.betId };
  }

  await recordParseTelemetry(post, "registered", { via });
  const mercadoReconhecido = !moneylineSelectionUnreadable(finalBet) && (
    result.mercadoMatched ||
    isMercadoFinal(finalBet.mercado) ||
    // Artilheiro "de cabeça" ou "ou dar assistência" vai ao operador na liquidação.
    (ehMercadoArtilheiro(finalBet.mercado) && !hasUnsupportedGoalQualifier(finalBet.mercado, finalBet.selecao)) ||
    classificarPropDeJogador({
      mercado: finalBet.mercado,
      selecao: finalBet.selecao,
      evento: finalBet.evento,
      esporte: finalBet.esporte,
    }) !== null);
  // Moneyline/Total podem ser conceitos reconhecidos, mas só recebem o rótulo
  // final após resolver o esporte. Essa espera não é falha de leitura do mercado.
  const avisoCaptura = result.sportResolutionStatus === "PENDING"
    ? "⚠️ Esporte ainda não confirmado"
    : result.sportResolutionStatus === "CONFLICT"
      ? "⚠️ Fontes discordam sobre o esporte"
      : mercadoReconhecido ? null : "⚠️ Mercado não reconhecido";

  const delivered = await sendOperatorNotification(
    [
      `📥 Nova aposta · ${bankroll.nome}`,
      finalBet.evento,
      `${finalBet.selecao} @${finalBet.odds} · ${finalBet.stake}u`,
      origemDaLeitura(via),
      avisoCaptura,
      result.notTaken ? "👎 Marcada como não pega, conforme sua reação" : null,
      telegramPostLink(post.chatId, post.messageId),
    ].filter(Boolean).join("\n"),
  );
  // Este 📥 é o aviso do conflito: o resolvedor, que roda depois, não o repete.
  if (delivered && result.sportResolutionStatus === "CONFLICT") {
    await markSportConflictNotified(result.betId, telegramChannelActor(via), { reason: "capture_conflict" });
  }
  return {
    kind: "registered",
    betId: result.betId,
    ...(result.notTaken ? { notTaken: true } : {}),
    sportResolutionStatus: result.sportResolutionStatus,
  };
}

/**
 * Recusa de post avulso com a aposta lida: pendência e aviso (`reportCaptureRefusal`),
 * o post guardado com a aposta para o painel e o 👍, e a pergunta na DM
 * quando o dado que falta é do dono. A pergunta sai mesmo com o ⛔ segurado
 * pelo aviso agrupado: ela é por post e resolve a aposta.
 */
export async function refuseReadBet(params: {
  post: CapturePost; bankroll: ChannelBankroll; via: CaptureVia; reason: string; missing: string[];
  bet: ParsedBetPost; caption: string; mediaFileId?: string; photo: boolean;
}): Promise<ChannelCaptureOutcome> {
  const { post, bankroll, via, reason, bet, caption, mediaFileId } = params;
  await reportCaptureRefusal({ post, bankroll, via, reason, missing: params.missing, evento: bet.evento, caption, mediaFileId });
  await recordDiscardedChannelPost({
    chatId: post.chatId, messageId: post.messageId, bankrollId: bankroll.id, text: caption,
    postDate: post.postDate, editDate: post.editDate, reason: "captura_recusada",
    ...(params.photo ? { photo: { mediaFileId: mediaFileId ?? null } } : {}),
    refusal: { reason, via, bet },
  });
  await offerCaptureFix({ bankroll, post, bet, reason, via, caption, mediaFileId });
  return { kind: "unparseable", missing: params.missing };
}

/**
 * A origem de uma aposta do canal: o post (ou o item `itemIndex` do lote), o
 * leitor e o que o dono pediu. A entrada é a da edição quando a aposta nasceu
 * dela. O item de lote divide a legenda com as outras apostas do post.
 */
function channelOrigin(post: CapturePost, via: CaptureVia, caption: string, media: {
  mediaFileId?: string; mediaFileIds?: string[]; itemIndex?: number;
} = {}): CaptureOrigin {
  return {
    source: telegramChannelSource(post.chatId),
    sourceExternalId: postItemExternalId(post.messageId, media.itemIndex),
    enteredAt: post.editDate ?? post.postDate,
    parser: via,
    actor: telegramChannelActor(via),
    caption,
    ...(media.itemIndex ? { sharedCaption: true } : {}),
    ...(media.mediaFileId ? { mediaFileId: media.mediaFileId } : {}),
    ...(media.mediaFileIds ? { mediaFileIds: media.mediaFileIds } : {}),
    ...(post.forcedByOperator || post.forcedByReaction ? { forcedByOperator: true } : {}),
  };
}

class IncompleteCaptureBatchError extends Error {}

/** O que identifica um item já gravado do lote, lido da evidência dele. */
const capturedItemSchema = captureParsedSchema.pick({ evento: true, mercado: true, selecao: true, esporte: true, playerProp: true });

/**
 * Post com várias seleções: todos os itens passam pelo guard antes da
 * transação, e um retry não completa um lote parcial com itens reordenados.
 * Ledger e captura commitam juntos.
 */
export async function registerCaptureBatch(params: {
  bankroll: ChannelBankroll;
  post: CapturePost;
  bets: ParsedBetPost[];
  via: CaptureVia;
  caption: string;
  images?: PostImages;
  mediaFileId?: string;
  mediaFileIds?: string[];
}): Promise<ChannelCaptureOutcome> {
  const { bankroll, post, bets, caption, via } = params;
  const { mediaFileId } = params;
  const photo = Boolean(params.images || mediaFileId);
  /**
   * Recusa antes da gravação: nenhum item entra. O lote de um item só (a prop
   * sozinha) é recusado como a aposta avulsa, com a pergunta na DM, e o
   * conserto grava com a mesma origem. O de vários fica guardado sem a
   * leitura: o conserto grava uma aposta só, e as outras do post se perderiam.
   */
  const refuse = async (reason: string, missing: string[], evento?: string, refused?: ParsedBetPost): Promise<ChannelCaptureOutcome> => {
    if (refused && bets.length === 1) {
      return refuseReadBet({ post, bankroll, via, reason, missing, bet: refused, caption, mediaFileId, photo });
    }
    await reportCaptureRefusal({
      post, bankroll, via, reason, missing, evento, caption, mediaFileId,
      ...(bets.length > 1 ? { batch: { size: bets.length, lines: batchNoticeLines(bets) } } : {}),
    });
    await recordDiscardedChannelPost({
      chatId: post.chatId, messageId: post.messageId, bankrollId: bankroll.id, text: caption,
      postDate: post.postDate, editDate: post.editDate, reason: "captura_recusada",
      ...(photo ? { photo: { mediaFileId: mediaFileId ?? null } } : {}),
    });
    return { kind: "unparseable", missing };
  };
  const keys = bets.map(playerCaptureItemKey);
  if (new Set(keys).size !== keys.length) return refuse("selecoes_indistinguiveis", ["selecoes_indistinguiveis"]);
  const prepared: ResolvedCaptureBet[] = [];
  for (const bet of bets) {
    const guarded = await prepareBetForCapture({
      bet,
      caption: bet.stakeSource === "caption" || bet.stakePolicySnapshot?.source.startsWith("bankroll_") ? `${bet.stake}u` : caption,
      postCaption: caption,
      sharedCaption: bets.length > 1,
      capturePolicy: bankroll.capturePolicy,
      images: params.images,
      postHasImage: photo,
      itemRef: captureItemRef(post.chatId, post.messageId),
      channelSports: bankroll.channelSports,
    });
    if (!guarded.ok) return refuse(guarded.reason, guarded.missing, bet.evento, bet);
    prepared.push(guarded.bet);
  }
  // A legenda do lote não prova o placar de um item, mas o placar escrito nela
  // é de algum deles. Se nenhum o carrega, a leitura o perdeu, e o handicap ao
  // vivo seria gravado como pré-jogo e liquidado pelo jogo inteiro. O 0-0 fica
  // de fora: o guard o descarta sem evidência no item, e o restante a partir
  // de 0-0 é o jogo inteiro.
  if (bets.length > 1) {
    const carried = (score: LiveScoreAtTip) =>
      (score.home === 0 && score.away === 0)
      || prepared.some((bet) => bet.liveScoreHome === score.home && bet.liveScoreAway === score.away);
    if (!prepared.every((bet) => extractLiveScoresAtTip(caption, { market: bet.mercado }).every(carried))) {
      return refuse("incomplete_live_score", ["placarLive"], prepared[0]?.evento);
    }
  }
  prepared.sort((a, b) => playerCaptureItemKey(a).localeCompare(playerCaptureItemKey(b)));
  if (new Set(prepared.map(playerCaptureItemKey)).size !== prepared.length) return refuse("selecoes_indistinguiveis", ["selecoes_indistinguiveis"]);
  if (!prepared.length) return refuse("lote_vazio", ["lote_vazio"]);
  const lateEdit = ignoreDraftEditedAfterKickoff(post, prepared) ?? refuseFinishedGame(post, prepared);
  if (lateEdit) return lateEdit;
  const source = telegramChannelSource(post.chatId);
  const externalId = String(post.messageId);
  // Os itens gravados, para o aviso: a tentativa que commita é a última a escrever.
  let registeredItems: ResolvedCaptureBet[] = [];
  let outcome: ChannelCaptureOutcome;
  try {
    outcome = await runSerializableTransaction("captureBatch.register", async (tx): Promise<ChannelCaptureOutcome> => {
      const existing = await tx.bet.findMany({ where: { source, ...postExternalIdsWhere([externalId]) }, orderBy: { sourceExternalId: "asc" }, select: { id: true, captureEvidence: { select: { parsedJson: true } } } });
      // Reentrega nunca acrescenta itens a um lote já gravado.
      if (existing[0]) {
        const originalKeys: string[] = [];
        for (const row of existing) {
          const original = capturedItemSchema.safeParse(row.captureEvidence?.parsedJson);
          if (!original.success) return { kind: "unparseable", missing: ["lote_alterado_precisa_revisao"] };
          originalKeys.push(playerCaptureItemKey(original.data));
        }
        // Item que bateu numa aposta de outra origem não tem linha deste post:
        // o gravado precisa estar no lote lido, não ser o lote inteiro.
        const preparedKeys = new Set(prepared.map(playerCaptureItemKey));
        if (!originalKeys.every((key) => preparedKeys.has(key))) return { kind: "unparseable", missing: ["lote_alterado_precisa_revisao"] };
        return { kind: "duplicate", betId: existing[0].id };
      }
      // Um lote já absorvido ou aposentado não pode ganhar itens numa reentrega.
      const used = await findPostSourceUse(source, externalId, tx);
      if (used) return used.kind === "retired"
        ? { kind: "skipped", reason: "fonte_retirada" }
        : { kind: "duplicate", betId: used.betId };
      const client = reuseSerializableTransaction(tx);
      const registeredBets: CapturedBet[] = [];
      const registered: ResolvedCaptureBet[] = [];
      const alreadyRegistered: string[] = [];
      for (const [i, bet] of prepared.entries()) {
        const { result } = await registerCapturedBet({
          bankroll, bet, client,
          origin: channelOrigin(post, via, caption, {
            mediaFileId, mediaFileIds: params.mediaFileIds, itemIndex: prepared.length > 1 ? i + 1 : undefined,
          }),
        });
        // A mesma aposta já chegou por outro caminho (DM, à mão): o item conta
        // como registrado, e os outros picks do post seguem.
        if (!result.created) {
          alreadyRegistered.push(result.betId);
          continue;
        }
        registeredBets.push({
          betId: result.betId,
          sportResolutionStatus: result.sportResolutionStatus,
          ...(result.notTaken ? { notTaken: true } : {}),
        });
        registered.push(bet);
      }
      const firstRegistered = registeredBets[0];
      if (!firstRegistered) {
        const [duplicateOf] = alreadyRegistered;
        if (!duplicateOf) throw new IncompleteCaptureBatchError("lote sem registro");
        return { kind: "duplicate", betId: duplicateOf };
      }
      const notTaken = await reconcileCapturedReactionTx(tx, { source, sourceExternalId: externalId, bankrollId: bankroll.id });
      registeredItems = registered;
      return {
        kind: "registered",
        betId: firstRegistered.betId,
        betIds: registeredBets.map((bet) => bet.betId),
        sportResolutionStatus: firstRegistered.sportResolutionStatus,
        registeredBets,
        ...(notTaken ? { notTaken: true } : {}),
      };
    });
  } catch (error) {
    if (!(error instanceof IncompleteCaptureBatchError)) throw error;
    outcome = { kind: "unparseable", missing: ["lote_incompleto_precisa_revisao"] };
  }
  // Recusa da transação: o post já tem aposta (ou precisa de revisão), e não é guardado.
  if (outcome.kind === "unparseable") {
    const reason = outcome.missing[0] ?? "lote_incompleto_precisa_revisao";
    await reportCaptureRefusal({ post, bankroll, via, reason, missing: outcome.missing, caption, mediaFileId });
    return outcome;
  }
  await recordParseTelemetry(post, outcome.kind === "registered" ? "registered" : "duplicate", { via });
  if (outcome.kind === "registered") {
    const one = registeredItems.length === 1;
    await sendOperatorNotification([
      `📥 ${registeredItems.length} ${one ? "aposta nova" : "apostas novas"} · ${bankroll.nome}`,
      `${one ? "Capturada" : "Capturadas"} do post ${post.messageId}.`,
      ...batchNoticeLines(registeredItems),
      outcome.notTaken ? `👎 ${one ? "Marcada como não pega" : "Marcadas como não pegas"}, conforme sua reação` : null,
      telegramPostLink(post.chatId, post.messageId),
    ].filter(Boolean).join("\n"));
  }
  return outcome;
}
