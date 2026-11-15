import { Api } from "grammy";
import { z } from "zod";
import type { Prisma } from "@/src/generated/prisma/client";
import { MAX_AUTO_CAPTURE_STAKE_UNITS, MAX_ODDS, type ParsedBetPost } from "@/src/domain/bet-capture";
import { spStartOfTodayUtc } from "@/src/domain/dates";
import { classifyDlqError } from "@/src/domain/dlq-classification";
import { parseDecimalInput } from "@/src/domain/decimal-input";
import { JANELA_DE_JOGO_MS } from "@/src/domain/entrada-ao-vivo";
import { kickoffInferidoFromParsed } from "@/src/domain/kickoff-infer";
import { SPORT_RESOLVER_VERSION, type SportResolutionDecision } from "@/src/domain/sports/detect";
import { CANONICAL_SPORTS, type CanonicalSport } from "@/src/domain/sports/registry";
import { splitEventoTeams } from "@/src/domain/text";
import { telegramChannelSource } from "@/src/domain/telegram-source";
import { getEnv, telegramOwnerId } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import type { PgBoss } from "pg-boss";
import { captureChannelFinancialContext } from "@/src/services/capture/capture-financial-context";
import { recordParseTelemetry } from "@/src/services/capture/parse-telemetry";
import { prepareBetForCapture } from "@/src/services/capture/preparation/prepare-capture";
import { registerCapturedBet } from "@/src/services/capture/register-captured-bet";
import { enqueueAfterCapture, type CapturedBet } from "@/src/services/scheduling/enqueue-after-capture";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { reuseSerializableTransaction, runSerializableTransaction } from "@/src/services/shared/transaction";
import { deserializeFullDraftBet, fullDraftBetSchema, serializeDraftBet } from "@/src/services/capture/dm-draft";

/**
 * Conserto pela DM de uma captura recusada. Quem avisa a recusa é o bot de
 * notificações, que não recebe updates; quem conversa com o dono é o bot
 * principal (o da DM de apostas). Por isso a pergunta sai pelo bot principal,
 * na DM do dono, e a aposta lida fica num `TelegramDmDraft` preso à mensagem
 * da pergunta: o clique (callback) ou a resposta digitada chegam ao handler da
 * DM, que grava pelo mesmo guard e pelo mesmo registro da captura.
 */

const log = createLogger("tg-capture-fix");

/** O dado que o dono informa. */
export type CaptureFixField = "total_unit" | "handicap_side" | "handicap_type" | "grid_option" | "live_score" | "odds" | "stake";

/** Uma opção da grade que o print mostrou sem a marca do tipster. */
export type CaptureFixOption = { selecao: string; odds: number };

const FIELD_BY_REASON: Readonly<Record<string, CaptureFixField>> = {
  mercado_total_ambiguo: "total_unit",
  lado_handicap_ausente: "handicap_side",
  handicap_tipo_ambiguo: "handicap_type",
  unmarked_selection: "grid_option",
  placar_ao_vivo_ausente: "live_score",
  odd_invalida: "odds",
  odd_legenda_ausente: "odds",
  odd_diverge_legenda: "odds",
  odd_implausivel: "odds",
  stake_invalido: "stake",
  stake_implausivel: "stake",
};

export function captureFixFieldFor(reason: string): CaptureFixField | null {
  return FIELD_BY_REASON[reason] ?? null;
}

/**
 * Odd e stake faltavam no post: a entrada é o momento em que o dono completa.
 * Unidade do total, lado e tipo do handicap, opção da grade e placar da
 * entrada ao vivo são dados daquela hora, só ambíguos ou não escritos: a
 * entrada continua sendo a do post.
 */
export function fixCompletesMissingData(field: CaptureFixField): boolean {
  return field === "odds" || field === "stake";
}

/** Uma pergunta aberta ao dono sobre um post recusado, gravada em `TelegramDmDraft.captureFix`. */
const captureFixStateSchema = z.object({
  version: z.literal(1),
  sourceKey: z.string(),
  chatId: z.string(),
  messageId: z.number().int(),
  bankrollId: z.string(),
  bankrollNome: z.string(),
  reason: z.string(),
  field: z.enum(["total_unit", "handicap_side", "handicap_type", "grid_option", "live_score", "odds", "stake"]),
  via: z.string(),
  caption: z.string(),
  mediaFileId: z.string().nullable(),
  postDate: z.string().datetime(),
  editDate: z.string().datetime().nullable(),
  /** A entrada já foi completada pelo dono (odd ou stake). */
  completedAt: z.string().datetime().nullable(),
  /**
   * A odd foi informada pelo dono neste conserto: nas perguntas seguintes ela
   * continua fora do teto da leitura automática. Opcional para as perguntas
   * abertas antes do campo.
   */
  oddsFromOwner: z.boolean().optional(),
  /** Esporte escolhido pelo dono no botão. */
  sport: z.enum(CANONICAL_SPORTS as [CanonicalSport, ...CanonicalSport[]]).nullable(),
  bet: fullDraftBetSchema,
  /** Grade sem marca: as opções entre as quais o dono escolhe. */
  options: z.array(z.object({ selecao: z.string(), odds: z.number() })).max(6).optional(),
});
export type CaptureFixState = z.infer<typeof captureFixStateSchema>;

function captureFixSourceKey(chatId: bigint | string, messageId: number): string {
  return `${telegramChannelSource(BigInt(chatId))}:${messageId}`;
}

export function fixStateBet(state: CaptureFixState): ParsedBetPost {
  return deserializeFullDraftBet(state.bet);
}

export function serializeFixBet(bet: ParsedBetPost): CaptureFixState["bet"] {
  return JSON.parse(JSON.stringify(serializeDraftBet(bet))) as CaptureFixState["bet"];
}

// ── Prazo ───────────────────────────────────────────────────────────────────

/** Quando o post saiu e, se a captura recusada veio de uma edição, quando ela chegou. */
type FixPostTimes = { postDate: Date; editDate?: Date | null };

/**
 * Até quando o dono pode consertar: o kickoff lido. Sem kickoff confiável, a
 * janela de um jogo desde o post ou o fim do dia dele em São Paulo, o que vier
 * antes: depois disso a aposta poderia nascer de jogo já jogado.
 *
 * Entrada ao vivo (o próprio post saiu depois do kickoff lido) já nasce com o
 * jogo rolando: o dado que continua sendo o do post (placar, lado, unidade)
 * vale até o fim da janela do jogo. Odd e stake completadas agora seriam uma
 * entrada nova no meio do jogo, e essas seguem presas ao kickoff.
 */
export function captureFixDeadline(bet: ParsedBetPost, post: FixPostTimes, field: CaptureFixField): Date {
  const liveEnd = liveEntryWindowEnd(bet, post, field);
  if (liveEnd) return liveEnd;
  if (!kickoffInferidoFromParsed(bet) && bet.data) return bet.data;
  const enteredAt = post.editDate ?? post.postDate;
  const endOfDay = new Date(spStartOfTodayUtc(enteredAt).getTime() + 86_400_000);
  const window = new Date(enteredAt.getTime() + JANELA_DE_JOGO_MS);
  return window < endOfDay ? window : endOfDay;
}

/**
 * Fim da janela do jogo quando o conserto é de um dado do post e o post (não
 * uma edição) saiu depois do kickoff lido. Edição depois do kickoff é ignorada
 * ("o que foi capturado vale"), e placar lido num post anterior ao kickoff não
 * faz a entrada ao vivo: nos dois casos o prazo é o kickoff.
 */
function liveEntryWindowEnd(bet: ParsedBetPost, post: FixPostTimes, field: CaptureFixField): Date | null {
  if (post.editDate || !bet.data || kickoffInferidoFromParsed(bet) || fixCompletesMissingData(field)) return null;
  return post.postDate >= bet.data ? new Date(bet.data.getTime() + JANELA_DE_JOGO_MS) : null;
}

/** O prazo passou: antes do jogo, ele começou; na entrada ao vivo, ele terminou. */
function deadlineMissedReply(bet: ParsedBetPost, post: FixPostTimes, field: CaptureFixField): CaptureFixReply {
  return { text: liveEntryWindowEnd(bet, post, field) ? "⏱️ O jogo já terminou: não registrei." : "⏱️ O jogo já começou: não registrei." };
}

function statePostTimes(state: CaptureFixState): FixPostTimes {
  return { postDate: new Date(state.postDate), editDate: state.editDate ? new Date(state.editDate) : null };
}

// ── A pergunta ──────────────────────────────────────────────────────────────

type InlineButton = { text: string; callback_data: string };
type FixPrompt = {
  text: string;
  reply_markup: { inline_keyboard: InlineButton[][] } | { force_reply: true; input_field_placeholder: string };
};

/** Prefixo dos callbacks do conserto; o resto é o código da resposta. */
export const CAPTURE_FIX_CALLBACK = "fx:";
/** Começo de toda pergunta de conserto: a resposta digitada a ela é reconhecida por ele. */
export const CAPTURE_FIX_PROMPT_PREFIX = "🛠️ Aposta recusada";
export const CAPTURE_FIX_CANCEL = "x";

const TOTAL_UNITS: ReadonlyArray<readonly [code: string, label: string]> = [
  ["g", "⚽ Gols"],
  ["c", "🚩 Escanteios"],
  ["k", "🟨 Cartões"],
  ["p", "🏀 Pontos (basquete)"],
];

function buildFixPrompt(state: CaptureFixState): FixPrompt {
  const bet = state.bet;
  const header = [
    `${CAPTURE_FIX_PROMPT_PREFIX} · ${state.bankrollNome}`,
    bet.evento || "Evento não identificado",
    `${bet.selecao} @${bet.odds} · ${bet.stake}u`,
  ].join("\n");
  const cancel = [{ text: "✖️ Deixar para lá", callback_data: `${CAPTURE_FIX_CALLBACK}${CAPTURE_FIX_CANCEL}` }];
  if (state.field === "total_unit") {
    return {
      text: `${header}\n\nNão deu para saber a unidade do total.\n👉 Esse total é de quê?`,
      reply_markup: {
        inline_keyboard: [
          ...TOTAL_UNITS.map(([code, label]) => [{ text: label, callback_data: `${CAPTURE_FIX_CALLBACK}${code}` }]),
          cancel,
        ],
      },
    };
  }
  if (state.field === "handicap_side") {
    const teams = splitEventoTeams(bet.evento);
    return {
      text: `${header}\n\nO handicap veio sem o time.\n👉 A linha ${bet.selecao} é de qual time?`,
      reply_markup: {
        inline_keyboard: [
          ...(teams ? [[{ text: teams.home, callback_data: `${CAPTURE_FIX_CALLBACK}h` }], [{ text: teams.away, callback_data: `${CAPTURE_FIX_CALLBACK}a` }]] : []),
          cancel,
        ],
      },
    };
  }
  if (state.field === "grid_option") {
    // A seleção e a odd lidas são só a primeira opção: o cabeçalho não as mostra.
    return {
      text: `${CAPTURE_FIX_PROMPT_PREFIX} · ${state.bankrollNome}\n${bet.evento || "Evento não identificado"}\n\n` +
        "O print mostra as opções sem a marca da que o tipster pegou.\n👉 Qual foi?",
      reply_markup: {
        inline_keyboard: [
          ...(state.options ?? []).map((option, index) => [{ text: `${option.selecao} @${option.odds}`, callback_data: `${CAPTURE_FIX_CALLBACK}o${index}` }]),
          cancel,
        ],
      },
    };
  }
  if (state.field === "live_score") {
    return {
      text: `${header}\n\nA entrada foi ao vivo, e o handicap conta só os gols depois dela, mas o post não diz o placar daquela hora.\n` +
        "👉 Responda a esta mensagem com o placar no momento da entrada, na ordem do jogo (ex.: 1x0).",
      reply_markup: { force_reply: true, input_field_placeholder: "Placar na entrada, ex.: 1x0" },
    };
  }
  if (state.field === "handicap_type") {
    return {
      text: `${header}\n\n"Handicap" com linha inteira pode ser asiático (devolve na cobertura exata) ou europeu (perde).\n👉 Qual é?`,
      reply_markup: {
        inline_keyboard: [
          ...HANDICAP_TYPES.map(([code, label]) => [{ text: label, callback_data: `${CAPTURE_FIX_CALLBACK}${code}` }]),
          cancel,
        ],
      },
    };
  }
  const odds = state.field === "odds";
  const why = !odds
    ? "A stake não veio ou está fora do normal."
    : state.reason === "odd_implausivel" ? "A odd lida está fora do normal para este mercado." : "A odd não veio ou não bate com a da legenda.";
  return {
    text: `${header}\n\n${why}\n` +
      `👉 Responda a esta mensagem com ${odds ? "a odd que você pegou (ex.: 1.85)" : "a stake em unidades (ex.: 1)"}.`,
    reply_markup: { force_reply: true, input_field_placeholder: odds ? "Odd, ex.: 1.85" : "Stake em unidades, ex.: 1" },
  };
}

// ── A resposta ──────────────────────────────────────────────────────────────

/** Tipo de handicap escolhido no botão, pelo mercado que ele grava. */
const HANDICAP_TYPES: ReadonlyArray<readonly [code: string, label: string]> = [
  ["ah", "Asiático"],
  ["eh", "Europeu (3 vias)"],
];
const HANDICAP_MARKET_BY_CODE: Readonly<Record<string, string>> = {
  ah: "Asian Handicap",
  eh: "European Handicap",
};

/** Unidade do total escolhida no botão: o mercado e, quando ela o define, o esporte. */
const TOTAL_UNIT_BY_CODE: Readonly<Record<string, { mercado?: string; sport?: CanonicalSport }>> = {
  g: { mercado: "Total (Gols) – Match" },
  // Escanteio e cartão só existem no futebol.
  c: { mercado: "Total (Corners) – Match", sport: "Soccer" },
  k: { mercado: "Total (Bookings) – Match", sport: "Soccer" },
  p: { sport: "Basketball" },
};

export type FixAnswerResult =
  | { ok: true; bet: ParsedBetPost; sport: CanonicalSport | null }
  | { ok: false; message: string };

const LIVE_SCORE_ANSWER = /^(\d{1,2})\s*[x×:\-–]\s*(\d{1,2})$/i;

/** Odd ou stake digitada, com o "@" ou o "u" que o dono costuma pôr. */
function fixAnswerNumber(value: string): number | null {
  return parseDecimalInput(value.replace(/^@/, "").replace(/u$/i, ""));
}

/** Texto com cara de resposta a uma pergunta de conserto (odd, stake ou placar), e não de tip nova. */
export function looksLikeCaptureFixAnswer(text: string): boolean {
  const value = text.trim();
  return LIVE_SCORE_ANSWER.test(value) || fixAnswerNumber(value) !== null;
}

/** Aplica a resposta do dono à aposta lida. Pura: quem chama passa pelo guard. */
export function applyFixAnswer(state: CaptureFixState, answer: string): FixAnswerResult {
  const bet = fixStateBet(state);
  const value = answer.trim();
  if (state.field === "total_unit") {
    const unit = TOTAL_UNIT_BY_CODE[value];
    if (!unit) return { ok: false, message: "Opção desconhecida." };
    const fixed = { ...bet, ...(unit.mercado ? { mercado: unit.mercado } : {}) };
    return unit.sport
      ? { ok: true, bet: { ...fixed, esporte: unit.sport, sportResolution: ownerSportDecision(unit.sport) }, sport: unit.sport }
      : { ok: true, bet: fixed, sport: state.sport };
  }
  if (state.field === "handicap_side") {
    const teams = splitEventoTeams(bet.evento);
    const team = value === "h" ? teams?.home : value === "a" ? teams?.away : undefined;
    return team
      ? { ok: true, bet: { ...bet, selecao: `${team} ${bet.selecao.trim()}` }, sport: state.sport }
      : { ok: false, message: "Não achei os times do jogo." };
  }
  if (state.field === "handicap_type") {
    const mercado = HANDICAP_MARKET_BY_CODE[value];
    return mercado ? { ok: true, bet: { ...bet, mercado }, sport: state.sport } : { ok: false, message: "Opção desconhecida." };
  }
  if (state.field === "grid_option") {
    const option = /^o\d$/.test(value) ? state.options?.[Number(value.slice(1))] : undefined;
    return option
      ? { ok: true, bet: { ...bet, selecao: option.selecao, odds: option.odds }, sport: state.sport }
      : { ok: false, message: "Opção desconhecida." };
  }
  if (state.field === "live_score") {
    const score = value.match(LIVE_SCORE_ANSWER);
    if (!score) return { ok: false, message: "Não entendi o placar. Responda só com ele, na ordem do jogo, ex.: 1x0." };
    const [home, away] = [Number(score[1]), Number(score[2])];
    return { ok: true, bet: { ...bet, liveScoreHome: home, liveScoreAway: away, liveScoreEvidence: `(${home}-${away}) informado pelo dono` }, sport: state.sport };
  }
  const number = fixAnswerNumber(value);
  if (state.field === "odds") {
    if (number === null || number <= 1 || number > MAX_ODDS) return { ok: false, message: "Não entendi a odd. Responda só com o número, ex.: 1.85." };
    return { ok: true, bet: { ...bet, odds: number }, sport: state.sport };
  }
  // O guard da captura aplica o mesmo teto; acima dele, só pelo painel.
  if (number === null || number <= 0 || number > MAX_AUTO_CAPTURE_STAKE_UNITS) {
    return { ok: false, message: `Não entendi a stake. Responda só com o número de unidades (até ${MAX_AUTO_CAPTURE_STAKE_UNITS}; acima disso, registre pelo painel).` };
  }
  // O registro confere a stake pela original da política gravada na leitura:
  // a do dono substitui a do post, que foi a recusada.
  const stakePolicySnapshot = bet.stakePolicySnapshot && { ...bet.stakePolicySnapshot, originalStake: number };
  return { ok: true, bet: { ...bet, stake: number, ...(stakePolicySnapshot ? { stakePolicySnapshot } : {}) }, sport: state.sport };
}

/** O esporte que o dono escolheu no botão é confirmação manual. */
export function ownerSportDecision(sport: CanonicalSport): SportResolutionDecision {
  return {
    sport,
    status: "CONFIRMED",
    confidence: 100,
    source: "MANUAL",
    evidence: [{ source: "MANUAL", sport, confidence: 100, value: "conserto pela DM" }],
    resolverVersion: SPORT_RESOLVER_VERSION,
  };
}

/**
 * O guard lê odd e stake da legenda quando ela manda. Depois que o dono
 * informou um dos dois, os números dele são a legenda.
 */
export function fixGuardCaption(state: CaptureFixState, bet: ParsedBetPost): string {
  return state.completedAt ? `${bet.stake}u @${bet.odds}` : state.caption;
}

// ── Envio e armazenamento ───────────────────────────────────────────────────

/** Mensagem do bot principal na DM do dono; devolve o id da mensagem. */
export type SendOwnerMessage = (chatId: string, prompt: FixPrompt) => Promise<number>;

async function sendWithMainBot(chatId: string, prompt: FixPrompt): Promise<number> {
  const token = getEnv().TELEGRAM_TOKEN;
  if (!token) throw new Error("TELEGRAM_TOKEN ausente: sem bot para perguntar ao dono.");
  const sent = await new Api(token).sendMessage(chatId, prompt.text, { reply_markup: prompt.reply_markup });
  return sent.message_id;
}

/** A pergunta vale até o prazo do conserto e no máximo 24 h. */
const CAPTURE_FIX_TTL_MS = 24 * 60 * 60_000;

/**
 * Manda a pergunta e guarda o estado preso à mensagem dela. `replaces`: a
 * pergunta anterior do mesmo conserto, que sai do ar na transação que guarda
 * esta. Sem ela (outra resposta já a tirou), esta não é guardada: `null`.
 */
export async function promptCaptureFix(
  state: CaptureFixState,
  opts: { ownerChatId: string; now?: Date; send?: SendOwnerMessage; replaces?: number },
): Promise<number | null> {
  const now = opts.now ?? new Date();
  const messageId = await (opts.send ?? sendWithMainBot)(opts.ownerChatId, buildFixPrompt(state));
  const deadline = captureFixDeadline(fixStateBet(state), statePostTimes(state), state.field);
  const ttl = new Date(now.getTime() + CAPTURE_FIX_TTL_MS);
  const data = {
    chatId: opts.ownerChatId,
    messageId,
    parsedBet: state.bet as Prisma.InputJsonValue,
    caption: state.caption,
    imageFileId: state.mediaFileId,
    postDate: new Date(state.postDate),
    captureFix: state as Prisma.InputJsonValue,
    expiresAt: deadline < ttl ? deadline : ttl,
  };
  const { replaces } = opts;
  if (replaces === undefined) {
    await prisma.telegramDmDraft.create({ data });
    return messageId;
  }
  return prisma.$transaction(async (tx) => {
    if (!(await claimCaptureFix({ ownerChatId: opts.ownerChatId, messageId: replaces }, tx))) return null;
    await tx.telegramDmDraft.create({ data });
    return messageId;
  });
}

/** Pergunta ainda aberta para o post: uma por post, mesmo com a captura repetida. */
async function hasOpenCaptureFix(sourceKey: string, now = new Date()): Promise<boolean> {
  const open = await prisma.telegramDmDraft.findFirst({
    where: { captureFix: { path: ["sourceKey"], equals: sourceKey }, expiresAt: { gt: now } },
    select: { id: true },
  });
  return open !== null;
}

export async function loadCaptureFix(
  params: { ownerChatId: string; messageId: number; now?: Date },
): Promise<CaptureFixState | null> {
  const row = await prisma.telegramDmDraft.findUnique({
    where: { chatId_messageId: { chatId: params.ownerChatId, messageId: params.messageId } },
    select: { captureFix: true, expiresAt: true },
  });
  if (!row?.captureFix || row.expiresAt <= (params.now ?? new Date())) return null;
  const parsed = captureFixStateSchema.safeParse(row.captureFix);
  if (!parsed.success) {
    log.warn({ messageId: params.messageId, issues: parsed.error.issues.length }, "pergunta de conserto ilegível — ignorada");
    return null;
  }
  return parsed.data;
}

/**
 * Tira a pergunta do ar. Devolve se foi esta chamada que a tirou: duas
 * respostas simultâneas disputam a mesma linha e só uma segue.
 */
export async function claimCaptureFix(
  params: { ownerChatId: string; messageId: number },
  client: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const { count } = await client.telegramDmDraft.deleteMany({
    where: { chatId: params.ownerChatId, messageId: params.messageId },
  });
  return count === 1;
}

export type OfferCaptureFixResult = "perguntado" | "nao_consertavel" | "ja_perguntado" | "jogo_comecou" | "sem_dono" | "falhou";

/**
 * Captura recusada por um dado que o dono sabe: pergunta na DM. Não pergunta
 * de novo pelo mesmo post nem depois do prazo. Falha no envio fica no log: o
 * aviso ⛔ da recusa já saiu pelo bot de notificações.
 */
export async function offerCaptureFix(input: {
  bankroll: { id: string; nome: string };
  post: { chatId: bigint; messageId: number; postDate: Date; editDate?: Date };
  bet: ParsedBetPost;
  reason: string;
  via: string;
  caption: string;
  mediaFileId?: string;
  /** Grade sem marca: as opções para o dono escolher. */
  options?: CaptureFixOption[];
  now?: Date;
  send?: SendOwnerMessage;
}): Promise<OfferCaptureFixResult> {
  const field = captureFixFieldFor(input.reason);
  // Sem ao menos duas opções não há o que escolher.
  if (!field || (field === "grid_option" && (input.options?.length ?? 0) < 2)) return "nao_consertavel";
  const ownerChatId = telegramOwnerId();
  if (!ownerChatId) return "sem_dono";
  const now = input.now ?? new Date();
  if (captureFixDeadline(input.bet, input.post, field) <= now) return "jogo_comecou";
  const sourceKey = captureFixSourceKey(input.post.chatId, input.post.messageId);
  if (await hasOpenCaptureFix(sourceKey, now)) return "ja_perguntado";
  const state: CaptureFixState = {
    version: 1,
    sourceKey,
    chatId: String(input.post.chatId),
    messageId: input.post.messageId,
    bankrollId: input.bankroll.id,
    bankrollNome: input.bankroll.nome,
    reason: input.reason,
    field,
    via: input.via,
    caption: input.caption.slice(0, 4_000),
    mediaFileId: input.mediaFileId ?? null,
    postDate: input.post.postDate.toISOString(),
    editDate: input.post.editDate?.toISOString() ?? null,
    completedAt: null,
    sport: null,
    bet: serializeFixBet(input.bet),
    ...(field === "grid_option" ? { options: input.options } : {}),
  };
  try {
    await promptCaptureFix(state, { ownerChatId, now, send: input.send });
    return "perguntado";
  } catch (err) {
    log.warn({ err, messageId: input.post.messageId, reason: input.reason }, "pergunta de conserto não enviada");
    return "falhou";
  }
}

// ── A resposta do dono ──────────────────────────────────────────────────────

/** O que dizer ao dono depois da resposta; `keep` mantém a pergunta aberta. */
export type CaptureFixReply = { text: string; keep?: boolean };

type FixPromptRef = { ownerChatId: string; messageId: number };
type AnswerDeps = { boss: PgBoss; now?: Date; send?: SendOwnerMessage };

/**
 * Resposta do dono (botão ou número digitado) a uma pergunta de conserto.
 * Aplica o dado, passa pelo guard da banca e grava pelo registro da captura.
 * Só dentro do prazo (`captureFixDeadline`): antes do jogo ou, na entrada ao
 * vivo, até o fim da janela dele; a correção pode passar dos 30 min do rascunho.
 *
 * A pergunta sai do ar com a resposta que encerra o conserto: a gravação, a
 * desistência, a recusa definitiva ou a próxima pergunta. Falha passageira
 * (banco) a deixa aberta, e o dono responde de novo; erro que a resposta de
 * novo não resolve (validação do registro) a encerra com o motivo e abre
 * alerta. Sem a pergunta carregada, não se sabe se a mensagem é resposta a
 * ela: a falha sobe, e a fila repete.
 */
export async function answerCaptureFix(
  params: { ownerChatId: string; promptMessageId: number; answer: string },
  deps: AnswerDeps,
): Promise<CaptureFixReply | null> {
  const now = deps.now ?? new Date();
  const prompt = { ownerChatId: params.ownerChatId, messageId: params.promptMessageId };
  const state = await loadCaptureFix({ ...prompt, now });
  if (!state) return null;
  try {
    return await settleCaptureFix(state, prompt, params.answer, { ...deps, now });
  } catch (err) {
    if (classifyDlqError(err) === "transient") {
      log.warn({ err, messageId: prompt.messageId }, "resposta do conserto falhou; a pergunta continua aberta");
      return { text: "⚠️ Não consegui registrar agora. A pergunta continua aberta: responda de novo.", keep: true };
    }
    if (!(await claimCaptureFix(prompt))) return null;
    return reportCaptureFixFailure(state, err);
  }
}

/** Erro que responder de novo não resolve: o dono fica sabendo o motivo, e o operador decide. */
async function reportCaptureFixFailure(state: CaptureFixState, err: unknown): Promise<CaptureFixReply> {
  log.error({ err, messageId: state.messageId }, "conserto pela DM não registrou a aposta");
  const message = err instanceof Error ? err.message.slice(0, 180) : "Falha ao registrar.";
  const post = `${state.chatId}:${state.messageId}`;
  await sendOperationalAlert(
    `🛑 Conserto pela DM não registrou a aposta · ${state.bankrollNome}\nErro: ${message}\n👉 Se ainda vale, registre à mão.`,
    {
      source: "telegram.capture-fix",
      key: post,
      title: "Conserto pela DM não registrado",
      resource: "telegram-channel",
      resourceId: post,
      evidence: { bankrollId: state.bankrollId, field: state.field, erro: err instanceof Error ? err.name : "desconhecido" },
      // Só o operador sabe se a tip ainda vale a pena registrar à mão.
      autoResolve: false,
    },
  ).catch((alertErr: unknown) => log.error({ err: alertErr }, "falha ao alertar sobre conserto não registrado"));
  return { text: `⚠️ Não registrei: ${message}\nRegistre à mão se ainda valer.` };
}

async function settleCaptureFix(
  state: CaptureFixState,
  prompt: FixPromptRef,
  answer: string,
  deps: AnswerDeps & { now: Date },
): Promise<CaptureFixReply | null> {
  const { now } = deps;
  const cancel = answer === CAPTURE_FIX_CANCEL;
  const applied = cancel ? null : applyFixAnswer(state, answer);
  if (applied && !applied.ok) return { text: applied.message, keep: true };
  /** Encerra o conserto sem gravar: a resposta vale se foi esta que tirou a pergunta do ar. */
  const close = async (reply: CaptureFixReply) => (await claimCaptureFix(prompt)) ? reply : null;
  if (!applied) return close({ text: "✖️ Deixei para lá. A aposta não foi registrada." });

  // A entrada só existe quando o último número que faltava foi respondido.
  // Esclarecer depois um dado já presente no post conserva esse instante.
  const completedAt = fixCompletesMissingData(state.field) ? now.toISOString() : state.completedAt;
  // A stake respondida também marca `completedAt`: ele não diz de quem é a odd.
  const oddsFromOwner = state.oddsFromOwner === true || state.field === "odds";
  const next: CaptureFixState = { ...state, completedAt, oddsFromOwner, sport: applied.sport, bet: serializeFixBet(applied.bet) };
  const times = statePostTimes(state);
  if (captureFixDeadline(applied.bet, times, state.field) <= now) return close(deadlineMissedReply(applied.bet, times, state.field));

  const bankroll = await captureChannelFinancialContext({ chatId: BigInt(state.chatId), messageId: state.messageId });
  if (!bankroll || bankroll.id !== state.bankrollId) {
    return close({ text: "⚠️ O tipster deste canal mudou ou foi excluído: não registrei." });
  }
  const guarded = await prepareBetForCapture({
    bet: applied.bet,
    caption: fixGuardCaption(next, applied.bet),
    postCaption: state.caption,
    capturePolicy: bankroll.capturePolicy,
    channelSports: bankroll.channelSports,
    // O esporte escolhido pelo dono vale sem passar pelo resolvedor.
    ...(next.sport ? { ownerSport: ownerSportDecision(next.sport) } : {}),
    // Odd ou stake respondidas pelo dono viram a legenda; senão vale o print lido.
    readFromImage: state.mediaFileId !== null && !next.completedAt,
    postHasImage: state.mediaFileId !== null,
    oddsFromOwner,
  });
  if (!guarded.ok) {
    const field = captureFixFieldFor(guarded.reason);
    // Outro dado faltando: nova pergunta, com o que o dono já respondeu. Ela
    // substitui esta só depois de enviada, e a resposta não se perde no envio.
    if (field && field !== state.field) {
      // Na entrada ao vivo, a odd ou a stake que ainda falta já não se completa.
      if (captureFixDeadline(applied.bet, times, field) <= now) return close(deadlineMissedReply(applied.bet, times, field));
      let asked: number | null;
      try {
        asked = await promptCaptureFix({ ...next, reason: guarded.reason, field }, {
          ownerChatId: prompt.ownerChatId, now, send: deps.send, replaces: prompt.messageId,
        });
      } catch (err) {
        log.warn({ err, reason: guarded.reason }, "próxima pergunta do conserto não enviada");
        return { text: "⚠️ Falta mais um dado, mas não consegui perguntar agora. A pergunta continua aberta: responda de novo.", keep: true };
      }
      return asked === null ? null : { text: "👍 Anotado. Falta mais um dado, pergunto abaixo." };
    }
    return close({ text: `⚠️ Ainda recusada (${guarded.reason.replaceAll("_", " ")}). Registre à mão se for o caso.` });
  }

  const post = { chatId: BigInt(state.chatId), messageId: state.messageId };
  // A pergunta sai do ar na transação que grava a aposta: se a gravação
  // falhar, ela continua aberta com a resposta do dono por fazer.
  const registered = await runSerializableTransaction("captureFix.register", async (tx) => {
    if (!(await claimCaptureFix(prompt, tx))) return null;
    return registerCapturedBet({
      bankroll,
      bet: guarded.bet,
      client: reuseSerializableTransaction(tx),
      origin: {
        source: telegramChannelSource(post.chatId),
        sourceExternalId: String(post.messageId),
        // Odd ou stake que faltavam: a entrada é a correção, como na edição do rascunho.
        enteredAt: new Date(completedAt ?? state.editDate ?? state.postDate),
        parser: state.via,
        actor: `telegram-user:${prompt.ownerChatId}`,
        caption: state.caption,
        ...(state.mediaFileId ? { mediaFileId: state.mediaFileId } : {}),
        forcedByOperator: true,
        completedByOwner: true,
      },
    });
  });
  if (!registered) return null;
  const { result, finalBet } = registered;
  if (!result.created) return { text: "♻️ Este post já tinha virado aposta; nada mudou." };
  // O funil conta o post como capturado, não mais como recusado. A aposta já
  // está gravada: a falha aqui fica no log, sem desfazer a resposta.
  await recordParseTelemetry(post, "registered", { via: state.via, reason: "conserto_pela_dm" })
    .catch((err: unknown) => log.warn({ err, messageId: post.messageId }, "funil do conserto não registrado"));
  await enqueueAfterFix(deps.boss, result, `${finalBet.evento} (tipster ${state.bankrollNome})`);
  return { text: `✅ Registrada em ${state.bankrollNome}\n${summary(finalBet)}` };
}

function summary(bet: ParsedBetPost): string {
  return `${bet.evento}\n${bet.selecao} @${bet.odds} · ${bet.stake}u`;
}

/**
 * A aposta e o agendamento estão gravados: a outbox retoma a falha ao
 * enfileirar, enquanto a ação em Operações mantém o dono informado.
 */
async function enqueueAfterFix(boss: PgBoss, result: CapturedBet, where: string) {
  try {
    await enqueueAfterCapture(boss, [result], "telegram-capture-fix");
  } catch (err) {
    log.error({ err, betId: result.betId }, "aposta do conserto sem fila de enriquecimento");
    await sendOperationalAlert(
      `⚠️ Aposta do conserto sem fila · ${where}\nA aposta foi salva, mas a busca do esporte e do preço não entrou na fila.\nA recuperação automática tentará novamente; acompanhe em Operações.`,
      {
        source: "bets.capture-fix-enqueue",
        key: result.betId,
        title: "Conserto pela DM sem fila depois de gravar",
        resource: "bet",
        resourceId: result.betId,
        autoResolve: false,
      },
    ).catch((alertErr: unknown) => log.error({ err: alertErr, betId: result.betId }, "falha ao alertar a fila ausente do conserto"));
  }
}
