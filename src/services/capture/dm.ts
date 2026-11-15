import type { PgBoss } from "pg-boss";
import { bankrollIdentityLabels } from "@/src/domain/bankroll-identity";
import type { CaptureImage, ParsedBetPost } from "@/src/domain/bet-capture";
import { formatSpDateTime, formatSpDayMonth } from "@/src/domain/dates";
import { marketPeriodOf } from "@/src/domain/mercados/classify";
import { rotuloDoMotivo } from "@/src/domain/recusa-de-captura";
import type { TelegramJobOf } from "@/src/domain/telegram-job";
import { telegramDmSource } from "@/src/domain/telegram-source";
import { normalizeStr } from "@/src/domain/text";
import { telegramAllowedChats } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { privacyHash } from "@/src/infra/privacy";
import { findBankrollCaptureById, listBankrollsParaSelecao } from "@/src/services/bankrolls/lookup";
import { captureFinancialContext } from "@/src/services/capture/capture-financial-context";
import { captureItemRef, prepareBetForCapture } from "@/src/services/capture/preparation/prepare-capture";
import { finalizeParsedBetForCapture } from "@/src/services/capture/preparation/parse-capture-guard";
import { extractCaptionBetHints } from "@/src/services/capture/preparation/parse-caption-hints";
import { registerCapturedBet } from "@/src/services/capture/register-captured-bet";
import { betSignalCount } from "@/src/services/capture/reading/noise-filter";
import { readBetPost, type BetPostSource, type ReadingResult } from "@/src/services/capture/reading/read-bet-post";
import { TelegramParseRetryError } from "@/src/services/capture/reading/retry-error";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { enqueueAfterCapture, type CapturedBet } from "@/src/services/scheduling/enqueue-after-capture";
import { deleteTelegramDmDraft, loadTelegramDmDraft, saveTelegramDmDraft } from "@/src/services/capture/dm-draft";

/*
 * Aposta avulsa pela DM do bot, por texto ou print: a mensagem vira a prévia
 * guardada no Postgres e pergunta a banca; a escolha no teclado registra na
 * banca com a mesma leitura, sem repetir a regra nem a IA. A borda do grammY
 * (`src/telegram/dm.ts`) só traduz o update e mostra o que sai daqui.
 */

const log = createLogger("tg-dm");

export type DmMessageJob = TelegramJobOf<"dm_message">;

/** O teclado da prévia: uma banca por linha, a paginação e o cancelar. */
export type DmKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

export type DmReply = (
  text: string,
  other?: { reply_parameters?: { message_id: number }; reply_markup?: DmKeyboard },
) => Promise<unknown>;

/** A foto da mensagem, pela Bot API. */
type LoadImage = (fileId: string) => Promise<CaptureImage>;

function allowedChats(): Set<string> {
  return telegramAllowedChats().chats;
}

// ── Mensagem: leitura e prévia ──────────────────────────────────────────────

const BET_FORMAT = "Jogo: A vs B\nEntrada: Under 2.5\nODD: 1.90\nStake: 1u";
const NOT_A_BET_REPLY = `Não consegui identificar uma aposta daí. 🤔\nManda no formato:\n${BET_FORMAT}`;
const HELP_REPLY = [
  "Aqui você registra uma aposta avulsa.",
  `Mande o print do bilhete (a legenda é opcional) ou o texto da aposta, por exemplo:\n${BET_FORMAT}`,
  "Eu mostro a prévia do que vai ser gravado e você escolhe o tipster.",
].join("\n\n");

/** Palavra de mercado ou de aposta: com ela o texto pode ser uma tip curta ("Flamengo ML"). */
const MARKET_WORD = /\b(?:ml|moneyline|over|under|mais de|menos de|vence|vencer|vitoria|handicap|ah|dnb|empate|gols?|ambas|btts|escanteios?|cantos?|cartoes|dupla chance|total|odd|stake|aposta|entrada|tip)\b/;

/**
 * Resposta que não precisa de leitura: comando (`/start`, `/ajuda`) explica a
 * conversa. Texto sem dígito, sem palavra de mercado e sem nenhum sinal de
 * aposta do filtro de ruído não vale uma chamada de IA; qualquer número
 * ("Lakers -4.5", "Sinner 1.5") vai à leitura.
 */
function textShortcut(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) return HELP_REPLY;
  if (/\d/.test(trimmed) || MARKET_WORD.test(normalizeStr(trimmed)) || betSignalCount(trimmed) > 0) return null;
  return NOT_A_BET_REPLY;
}

/**
 * A leitura da mensagem é a do canal, sem os porteiros de ruído e de
 * recapitulação: quem manda é o dono. Provedor fora e qualquer falha da
 * leitura (download, IA) devolvem a mensagem à fila.
 */
async function readDmMessage(data: DmMessageJob, loadImage: LoadImage): Promise<ReadingResult | null> {
  const kind = data.fileId ? "foto" : "texto";
  const source: BetPostSource | null = data.text
    ? { kind: "text", text: data.text }
    : data.fileId
      ? { kind: "photo", caption: data.caption ?? "", fileId: data.fileId, loadImage }
      : null;
  if (!source) return null;
  try {
    const reading = await readBetPost(source, { now: new Date(data.postDate), gates: { recap: false, draft: true } });
    if (reading.kind === "unavailable") throw new TelegramParseRetryError(kind, data.messageId);
    return reading;
  } catch (error) {
    if (error instanceof TelegramParseRetryError) throw error;
    log.error({ err: error, messageId: data.messageId }, "leitura da DM falhou — a mensagem volta à fila");
    throw new TelegramParseRetryError(kind, data.messageId, { cause: error });
  }
}

/** A dúvida que a própria leitura escreveu, dita ao dono. */
function doubtReply(description: string | undefined): string | undefined {
  const doubt = description?.trim().slice(0, 300);
  return doubt ? `Li a aposta, mas fiquei em dúvida: ${doubt}\n👉 Mande de novo deixando isso claro, ou registre pelo painel.` : undefined;
}

/** Os números que a leitura não achou, como o dono os chama. */
function missingNumbers(missing: readonly string[]): string[] {
  return missing.flatMap((field) => field === "odds" ? ["a odd"] : field === "stake" ? ["a stake"] : []);
}

function missingNumbersReply(numbers: readonly [string, ...string[]]): string {
  return `Li a aposta, mas faltou ${numbers.join(" e ")}.\n👉 Mande de novo com ${numbers.length > 1 ? "elas" : "ela"}.`;
}

/**
 * A mensagem que não virou prévia. Se a leitura achou a aposta mas parou numa
 * dúvida ou num número que faltou, a resposta diz qual; o rascunho que o
 * porteiro segura, a recusa e o "não é aposta" são "não consegui identificar".
 */
function unreadReply(reading: ReadingResult | null): string {
  if (reading?.kind === "refused") return doubtReply(reading.detail) ?? NOT_A_BET_REPLY;
  // Só a odd mínima no post: a leitura saiu sem a odd.
  if (reading?.kind === "bets") return missingNumbersReply(["a odd"]);
  if (reading?.kind !== "draft" || reading.byRule) return NOT_A_BET_REPLY;
  const doubt = doubtReply(reading.review?.description);
  if (doubt) return doubt;
  const [first, ...rest] = missingNumbers(reading.missing);
  return first ? missingNumbersReply([first, ...rest]) : NOT_A_BET_REPLY;
}

/**
 * A mensagem vira prévia e pergunta a banca. Falha sobe: o job volta pelo
 * retry da fila e, esgotado, vai para a dead-letter.
 */
export async function answerDmMessage(data: DmMessageJob, deps: { loadImage: LoadImage; reply: DmReply }): Promise<void> {
  // Jobs duráveis podem sobreviver à remoção do chat e ao reinício do worker.
  if (!allowedChats().has(data.chatId)) {
    log.warn({ chatIdHash: privacyHash(data.chatId, "telegram-chat") }, "DM de chat não autorizado ignorada");
    return;
  }
  const answer = (text: string) => deps.reply(text, { reply_parameters: { message_id: data.messageId } });
  const shortcut = data.text && !data.fileId ? textShortcut(data.text) : null;
  if (shortcut) {
    await answer(shortcut);
    return;
  }
  const reading = await readDmMessage(data, deps.loadImage);
  if (reading?.kind !== "bets" || reading.oddsMissing) {
    await answer(unreadReply(reading));
    return;
  }

  // A prévia guarda uma aposta só: gravar a primeira de várias simples perderia
  // as outras sem aviso.
  if (reading.bets.length > 1) {
    await answer(`Achei ${reading.bets.length} apostas nessa mensagem. Por aqui eu registro uma por vez: mande cada uma separada ou registre pelo painel.`);
    return;
  }

  const bancas = await listBankrollsParaSelecao();
  if (bancas.length === 0) {
    await deps.reply("Nenhum tipster cadastrado — crie um em Config no site.");
    return;
  }
  const caption = data.text ?? data.caption ?? "";
  // O rascunho guarda a leitura: o clique refaz a preparação com a banca escolhida.
  await saveTelegramDmDraft({
    chatId: data.chatId,
    messageId: data.messageId,
    bet: reading.bet,
    caption,
    imageFileId: data.fileId ?? null,
    postDate: new Date(data.postDate),
  });
  const preview = previewText(reading.bet, caption, {
    photo: Boolean(data.fileId), captionOddBankroll: bancas.some((banca) => banca.capturePolicy === "CAPTION_ODD"),
  });
  await deps.reply(`📝 ${preview}\n\nEm qual tipster?`, {
    reply_parameters: { message_id: data.messageId },
    reply_markup: buildDmKeyboard(bancas),
  });
}

// ── Escolha da banca: registro ──────────────────────────────────────────────

/** A prévia (a mensagem do dono a que o teclado responde). */
export type DmDraftRef = { chatId: string; messageId: number };

/**
 * O que a prévia passa a mostrar. `registered`: a aposta já está gravada (ou
 * já estava), e uma falha ao mostrar isso não é falha do registro.
 */
export type DmScreen = { text: string; keyboard?: DmKeyboard; registered?: boolean };

/**
 * Registra a prévia na banca escolhida: o guard da banca, o esporte e o
 * registro único da captura, com a origem da DM (uma por banca). A DM não
 * recusa jogo antigo: o dono pode registrar o que já pegou.
 */
export async function registerDmDraftInBankroll(
  draftRef: DmDraftRef,
  bankrollId: string,
  deps: { boss: PgBoss; loadImage: LoadImage },
): Promise<DmScreen> {
  const draft = await loadTelegramDmDraft(draftRef);
  if (!draft) return { text: "⚠️ A prévia expirou. Envie a aposta novamente." };

  const banca = await findBankrollCaptureById(bankrollId);
  if (!banca) return { text: "⚠️ Este tipster não está mais disponível. Envie a aposta novamente." };

  const bancas = await listBankrollsParaSelecao();
  const keyboard = buildDmKeyboard(bancas);
  const source = telegramDmSource(draftRef.chatId, bankrollId);
  const financialContext = await captureFinancialContext({ source, sourceExternalId: String(draftRef.messageId) }, { bankrollId, explicitStake: true });
  if (!financialContext) throw new Error("Tipster indisponível para a captura.");
  // A foto só é baixada de novo se o guard precisar reler o print.
  const imageFileId = draft.imageFileId;
  const prepared = await prepareBetForCapture({
    bet: draft.bet,
    caption: draft.caption,
    capturePolicy: banca.capturePolicy,
    ...(imageFileId ? { images: async () => [await deps.loadImage(imageFileId)] } : {}),
    itemRef: captureItemRef(draftRef.chatId, draftRef.messageId),
  });
  if (!prepared.ok) return { text: `⚠️ Rejeitada: ${rotuloDoMotivo(prepared.reason)}\n\nEscolha outro tipster ou cancele:`, keyboard };
  const { result, finalBet } = await registerCapturedBet({
    bankroll: { id: bankrollId, defaultBookmaker: banca.defaultBookmaker, financialContextId: financialContext.id },
    bet: prepared.bet,
    origin: {
      source,
      sourceExternalId: String(draftRef.messageId),
      enteredAt: draft.postDate,
      parser: "telegram-dm",
      actor: "telegram-dm",
      caption: draft.caption,
      ...(imageFileId ? { mediaFileId: imageFileId } : {}),
    },
  });
  const bankrollNome = bankrollIdentityLabels(bancas).get(bankrollId) ?? "tipster escolhido";
  if (!result.created) {
    return { text: `♻️ Já registrada em ${bankrollNome}.\n${resumo(finalBet)}\n\nEscolha outro tipster ou cancele:`, keyboard, registered: true };
  }
  const enrichMessage = await enqueueDmEnrich(deps.boss, result, `${finalBet.evento} (tipster ${bankrollNome})`);
  return {
    text: `✅ Registrada em ${bankrollNome}!\n${resumo(finalBet)}\n\n${enrichMessage} Você pode registrar a mesma tip em outro tipster:`,
    keyboard,
    registered: true,
  };
}

/** A aposta já está salva: falha ao enfileirar vira ação em Operações, não erro para o operador. */
async function enqueueDmEnrich(boss: PgBoss, result: CapturedBet, where: string): Promise<string> {
  try {
    await enqueueAfterCapture(boss, [result], "telegram-dm");
    return "Enriquecimento sharp em andamento.";
  } catch (err) {
    log.error({ err, betId: result.betId }, "falha ao enfileirar sharp.enrich após DM");
    await sendOperationalAlert(
      `⚠️ Aposta da conversa sem busca de preço · ${where}\nA aposta foi salva, mas a busca na Pinnacle não entrou na fila.\nA recuperação automática tentará novamente; acompanhe em Operações.`,
      {
        source: "bets.dm-enrich-enqueue",
        key: result.betId,
        title: "Tip DM sem enriquecimento enfileirado",
        resource: "bet",
        resourceId: result.betId,
        autoResolve: false,
      },
    ).catch((alertErr) =>
      log.error({ err: alertErr, betId: result.betId }, "falha ao alertar enrich ausente da DM"),
    );
    return "Aposta salva; aguardando recuperação automática da busca.";
  }
}

/**
 * A aposta não entrou: além do aviso na conversa, abre ação para o operador
 * decidir. Devolve o que a prévia mostra.
 */
export async function reportDmRegisterFailure(draftRef: DmDraftRef, bankrollId: string, err: unknown): Promise<string> {
  log.error({ err }, "falha ao registrar via DM");
  await sendOperationalAlert(
    `🛑 Aposta da conversa não foi registrada\nErro: ${err instanceof Error ? err.message : String(err)}\n👉 Se ainda vale, registre à mão.`,
    {
      source: "telegram.dm-register",
      key: `${draftRef.chatId}:${draftRef.messageId}`,
      title: "Aposta da DM não registrada",
      resource: "telegram-dm-draft",
      resourceId: `${draftRef.chatId}:${draftRef.messageId}`,
      evidence: { bankrollId, erro: err instanceof Error ? err.name : "desconhecido" },
      // Só o operador sabe se a tip ainda vale a pena registrar à mão.
      autoResolve: false,
    },
  ).catch((alertErr) =>
    log.error({ err: alertErr }, "falha ao alertar sobre registro perdido da DM"),
  );
  const message = err instanceof Error ? err.message.slice(0, 180) : "Falha ao registrar.";
  return `⚠️ ${message}\n\nTente novamente ou envie a aposta de novo.`;
}

/** O dono cancelou a prévia: o rascunho sai; se não sair, expira sozinho e o operador é avisado. */
export async function discardDmDraft(draftRef: DmDraftRef): Promise<void> {
  try {
    await deleteTelegramDmDraft(draftRef);
  } catch (err) {
    log.error({ err }, "falha ao remover rascunho cancelado da DM");
    await sendOperationalAlert("⚠️ Rascunho cancelado não foi apagado\nVocê cancelou uma aposta na conversa, mas o rascunho ficou salvo.\n👉 Nada a fazer: ele expira sozinho em 24 h. Feche este aviso em Monitoramento.", {
      source: "telegram.dm-draft-delete",
      key: `${draftRef.chatId}:${draftRef.messageId}`,
      title: "Rascunho de DM não removido",
      resource: "telegram-dm-draft",
      resourceId: `${draftRef.chatId}:${draftRef.messageId}`,
      autoResolve: false,
    }).catch((alertErr) =>
      log.error({ err: alertErr }, "falha ao alertar sobre rascunho de DM não removido"),
    );
  }
}

// ── Apresentação ────────────────────────────────────────────────────────────

const BANKROLLS_PER_PAGE = 8;

const PERIOD_LABEL: Partial<Record<ReturnType<typeof marketPeriodOf>, string>> = {
  HT: "1º tempo",
  SECOND_HALF: "2º tempo",
};

/**
 * O que a aposta vai gravar: o dono confere mercado, período, as pernas da
 * múltipla, o jogador da prop, a data e o placar antes de escolher a banca.
 */
function resumo(bet: ParsedBetPost): string {
  const period = PERIOD_LABEL[marketPeriodOf(`${bet.mercado} ${bet.selecao}`, bet.esporte)];
  const data = bet.data
    ? `📅 ${bet.kickoffDateOnly ? formatSpDayMonth(bet.data) : formatSpDateTime(bet.data)}`
    : "📅 sem data no post (vale a do envio)";
  const live = bet.liveScoreHome != null && bet.liveScoreAway != null
    ? `🔴 Ao vivo, entrada com ${bet.liveScoreHome}-${bet.liveScoreAway}`
    : null;
  const legs = bet.legs?.legs.map((leg) => `• ${leg.evento}: ${leg.mercado} · ${leg.selecao}`) ?? [];
  const prop = bet.playerProp
    ? `👤 ${bet.playerProp.jogador}${bet.playerProp.time ? ` (${bet.playerProp.time})` : ""}: ${bet.playerProp.mercadoOriginal} · ${bet.playerProp.selecaoOriginal}`
    : null;
  return [
    bet.evento,
    `${bet.mercado}${period ? ` · ${period}` : ""}`,
    `${bet.selecao} @${bet.odds} (${bet.stake}u)`,
    ...(legs.length ? [`🧩 ${legs.length} pernas:`, ...legs] : []),
    prop,
    data,
    live,
  ].filter(Boolean).join("\n");
}

/**
 * A prévia com a odd e a stake que o clique grava. O guard aplica a stake da
 * legenda, que na DM não depende da banca, e no print mantém a odd dele; só a
 * banca "Odd da legenda (@) manda" troca a odd do print pela do "@", e a
 * prévia avisa quando existe uma. A recusa do guard fica para o clique, que
 * diz o motivo e oferece outra banca (e às vezes a releitura do print a resolve).
 */
function previewText(bet: ParsedBetPost, caption: string, opts: { photo: boolean; captionOddBankroll: boolean }): string {
  const guarded = finalizeParsedBetForCapture(bet, caption, "AUTO", { readFromImage: opts.photo });
  const shown = guarded.ok ? { ...bet, odds: guarded.bet.odds, stake: guarded.bet.stake } : bet;
  const captionOdds = opts.photo && opts.captionOddBankroll ? extractCaptionBetHints(caption).odds : undefined;
  return [
    resumo(shown),
    captionOdds !== undefined && captionOdds !== shown.odds
      ? `⚠️ Nos tipsters com "Odd da legenda (@) manda" vale @${captionOdds} (legenda), não @${shown.odds} (print).`
      : null,
  ].filter(Boolean).join("\n");
}

export function buildDmKeyboard(bancas: Array<{ id: string; nome: string; slug: string }>, requestedPage = 0): DmKeyboard {
  const labels = bankrollIdentityLabels(bancas);
  const pages = Math.max(1, Math.ceil(bancas.length / BANKROLLS_PER_PAGE));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const start = page * BANKROLLS_PER_PAGE;
  const rows = bancas
    .slice(start, start + BANKROLLS_PER_PAGE)
    .map((b) => [{ text: labels.get(b.id) ?? b.nome, callback_data: `dm:${b.id}` }]);
  if (pages > 1) {
    rows.push([
      { text: "‹", callback_data: `dm:page:${Math.max(0, page - 1)}` },
      { text: `${page + 1}/${pages}`, callback_data: `dm:page:${page}` },
      { text: "›", callback_data: `dm:page:${Math.min(pages - 1, page + 1)}` },
    ]);
  }
  rows.push([{ text: "✖️ Cancelar", callback_data: "dm:cancel" }]);
  return { inline_keyboard: rows };
}
