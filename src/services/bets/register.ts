import { z } from "zod";
import { Prisma } from "@/src/generated/prisma/client";
import { SportResolutionSource, SportResolutionStatus } from "@/src/generated/prisma/enums";
import { parseBetLegs, parseStoredLegs, sameBetLegs, type BetLegsTicket } from "@/src/domain/bet-legs";
import { canonicalizeBookmakerName } from "@/src/domain/bookmaker";
import { preserveCaptureStakeSnapshot } from "@/src/domain/capture-financial-history";
import { captureParsedSchema, capturedTermsSchema, captionDeclaresPromotionFunding, captionDeclaresTradingOperation, captureReaderOf, hasUnsupportedPromotionTerms, hasUnsupportedTradingTerms } from "@/src/domain/bet-capture";
import { captureRegisteredOcrEvidence } from "@/src/domain/capture-ocr-evidence";
import { resolveCaptureStake } from "@/src/domain/capture-stake-policy";
import { MAX_LIVE_SCORE_AT_TIP, mentionsLiveEntryNearBet, resolveLiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import { BET_UNIT_MIN_AMOUNT, roundMoney, toNumber } from "@/src/domain/money";
import { MERCADO_DA_PROP } from "@/src/domain/settlement/player-prop-classify";
import { playerPropRule } from "@/src/domain/settlement/player-prop-rules";
import {
  buildPlayerPropTerms,
  normalizePlayerThreshold,
  playerPropInputSchema,
  type PlayerPropTerms,
} from "@/src/domain/settlement/player-prop-terms";
import { UNKNOWN_SPORT } from "@/src/domain/sports/detect";
import { normalizeStr } from "@/src/domain/text";
import {
  postExternalIdsWhere,
  postIdOfExternalId,
  telegramChannelSource,
  type ExternalIdsWhere,
} from "@/src/domain/telegram-source";
import { canonicalizeBetForRegistration } from "@/src/services/bets/canonicalize-registration";
import { normalizeBetFields, normalizeTicketLegs } from "@/src/services/bets/normalize-fields";
import {
  esporteSanity,
  eventoSanity,
  kickoffSanity,
  mercadoSanity,
  oddsSanity,
  selecaoSanity,
  stakeSanity,
} from "@/src/services/bets/sanity";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";
import { prisma } from "@/src/infra/prisma";
import { findContaAtivaParaCasa } from "@/src/services/contas/link";
import { reportMercadoAliasConflictTx } from "@/src/services/mercados/alias-conflict-action";
import type { MercadoCatalogClient } from "@/src/services/mercados/normalize";
import { reconcileCapturedReactionTx } from "@/src/services/capture/channel/reaction-decisions";
import { recordCaptureFollowupTx, type CaptureFollowupOrigin } from "@/src/services/scheduling/enqueue-after-capture";
import {
  type SerializableTransactionClient,
  runSerializableTransaction,
} from "@/src/services/shared/transaction";

/**
 * Registro de aposta: porta única de todas as origens (web, DM, canais
 * Telegram). Valida com tetos de sanidade (saída de LLM é input hostil),
 * normaliza para o vocabulário Pinnacle, deduplica e persiste com auditoria
 * numa transação Serializable, que fecha a corrida de inserts idênticos. A
 * canonização (país, DNB, dupla chance, nomes dos times) vem feita por quem
 * chama: a captura na preparação, o painel antes de registrar.
 */

const log = createLogger("bet-register");

const registerBetInputSchema = z.object({
  bankrollId: z.string().uuid(),
  playerProp: playerPropInputSchema.optional(),
  data: kickoffSanity,
  evento: eventoSanity,
  esporte: esporteSanity,
  sportResolutionStatus: z.nativeEnum(SportResolutionStatus).default(SportResolutionStatus.CONFIRMED),
  sportConfidence: z.number().int().min(0).max(100).default(100),
  sportSource: z.nativeEnum(SportResolutionSource).default(SportResolutionSource.LEGACY),
  sportEvidence: z.unknown().optional(),
  sportResolverVersion: z.number().int().positive().default(1),
  competicao: z.string().trim().max(200).default(""),
  pais: z.string().trim().max(100).default(""),
  casaDeAposta: z.string().trim().max(100).default(""),
  tipster: z.string().trim().max(120).default(""),
  mercado: mercadoSanity,
  selecao: selecaoSanity,
  liveScoreHome: z.number().int().min(0).max(MAX_LIVE_SCORE_AT_TIP).optional(),
  liveScoreAway: z.number().int().min(0).max(MAX_LIVE_SCORE_AT_TIP).optional(),
  liveScoreEvidence: z.string().max(4000).optional(),
  odds: oddsSanity,
  stake: stakeSanity,
  legsJson: z.unknown().optional(),
  source: z.string().trim().min(1).max(80).default("web"),
  sourceExternalId: z.string().trim().min(1).max(120).optional(),
  sourcePostedAt: z.date().refine((value) => value.getTime() <= Date.now() + 60_000, "Postagem não pode estar no futuro.").optional(),
  actor: z.string().trim().max(120).default("system"),
  captureEvidence: z.object({
    parser: z.string().trim().min(1).max(80),
    caption: z.string().max(4_000).optional(),
    mediaFileId: z.string().trim().min(1).max(300).optional(),
    parsed: z.unknown(),
    candidates: z.unknown().optional(),
    /** O dono completou a leitura (conserto pela DM): a aposta não mede o leitor. */
    completedByOwner: z.boolean().optional(),
    /** A legenda é a do post com várias apostas: o placar de um jogo nela não é o desta. */
    sharedCaption: z.boolean().optional(),
  }).optional(),
  kickoffInferido: z.boolean().default(false),
}).superRefine((input, ctx) => {
  if ((input.liveScoreHome === undefined) !== (input.liveScoreAway === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["liveScoreHome"],
      message: "Placar live precisa informar mandante e visitante juntos.",
    });
  }
  if (input.sportResolutionStatus === SportResolutionStatus.CONFIRMED && input.esporte === UNKNOWN_SPORT) {
    ctx.addIssue({ code: "custom", path: ["esporte"], message: "Esporte confirmado não pode ser Unknown." });
  }
  if (input.sportResolutionStatus !== SportResolutionStatus.CONFIRMED && input.esporte !== UNKNOWN_SPORT) {
    ctx.addIssue({ code: "custom", path: ["esporte"], message: "Esporte pendente ou em conflito deve ser Unknown." });
  }
});

/** O contrato da evidência gravada, sem campo a mais: campo novo no escritor entra no contrato junto. */
const writtenCaptureParsedSchema = z.strictObject(captureParsedSchema.shape);

/**
 * A evidência é o que a leitura viu: fora do contrato ela é gravada assim
 * mesmo, e o log aponta o que destoou para o escritor ser corrigido.
 */
function warnWhenEvidenceOffContract(evidence: { parser: string; parsed?: unknown }): void {
  const checked = writtenCaptureParsedSchema.safeParse(evidence.parsed);
  if (checked.success) return;
  log.warn({
    eventCode: LOG_EVENTS.CAPTURE_EVIDENCE_OFF_CONTRACT,
    parser: evidence.parser,
    issues: checked.error.issues.slice(0, 10).map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
      ...(issue.code === "unrecognized_keys" ? { keys: issue.keys } : {}),
    })),
  }, "evidência da captura fora do contrato — gravada assim mesmo");
}

export type RegisterBetInput = z.input<typeof registerBetInputSchema>;
export type RegisterBetResult = {
  created: boolean;
  notTaken?: boolean;
  captureFollowupId?: string;
  betId: string;
  duplicateOfId?: string;
  duplicateWasDeleted?: boolean;
  mercadoMatched: boolean;
  sportResolutionStatus: SportResolutionStatus;
};

/** Placar live e normalização Pinnacle, fora da transação. */
async function normalizeRegistration(rawInput: RegisterBetInput, client?: MercadoCatalogClient) {
  const originalInput = registerBetInputSchema.parse(rawInput);
  const declaredLegs = parseStoredLegs(originalInput.legsJson);
  // Da legenda livre só vale a linha que rotula esta aposta; rodapé de afiliado não a recusa.
  const caption = originalInput.captureEvidence?.caption;
  if (captionDeclaresTradingOperation(caption) || hasUnsupportedTradingTerms(originalInput.mercado, originalInput.selecao,
    ...(declaredLegs?.legs.flatMap((leg) => [leg.mercado, leg.selecao]) ?? []))) {
    throw new RecusaDeNegocioError("Operação recusada: lay, responsabilidade, comissão e cash-out parcial exigem contrato financeiro próprio.");
  }
  if (captionDeclaresPromotionFunding(caption) || hasUnsupportedPromotionTerms(originalInput.mercado, originalInput.selecao,
    ...(declaredLegs?.legs.flatMap((leg) => [leg.mercado, leg.selecao]) ?? []))) {
    throw new Error("Registro recusado: regra promocional sem contrato financeiro próprio. Freebet e reembolso não usam o cálculo de stake em dinheiro.");
  }
  if (originalInput.captureEvidence) warnWhenEvidenceOffContract(originalInput.captureEvidence);
  const propTerms = buildPlayerPropTerms(originalInput);
  const parsedInput = propTerms
    ? { ...originalInput, mercado: propTerms.period === "FT" && !propTerms.unsupportedReason ? MERCADO_DA_PROP[propTerms.family] : originalInput.mercado, selecao: normalizePlayerThreshold(originalInput.selecao) }
    : originalInput;
  const evidence = parsedInput.captureEvidence;
  const liveScore = resolveLiveScoreAtTip({
    liveScoreHome: parsedInput.liveScoreHome,
    liveScoreAway: parsedInput.liveScoreAway,
    texts: [parsedInput.selecao, parsedInput.liveScoreEvidence, evidence?.sharedCaption ? null : evidence?.caption],
    market: parsedInput.mercado,
  });
  if (!liveScore.ok) {
    throw new Error(`Placar live inválido na captura (${liveScore.reason}).`);
  }
  const input = {
    ...parsedInput,
    liveScoreHome: liveScore.score?.home ?? null,
    liveScoreAway: liveScore.score?.away ?? null,
    casaDeAposta: canonicalizeBookmakerName(parsedInput.casaDeAposta),
  };

  const hasExplicitLegs = Object.prototype.hasOwnProperty.call(input, "legsJson") && input.legsJson != null;
  const explicitLegs = hasExplicitLegs ? parseStoredLegs(input.legsJson) : null;
  if (hasExplicitLegs && !explicitLegs) {
    throw new Error("Registro de múltipla recusado: legsJson explícito é inválido.");
  }
  const incomingLegs = explicitLegs ?? parseBetLegs(input.evento, input.selecao, input.mercado);
  const normalizedLegs = incomingLegs
    ? await normalizeTicketLegs(incomingLegs, input.esporte, input.casaDeAposta, client)
    : null;

  const normalized = await normalizeBetFields({
    evento: normalizedLegs
      ? [...new Set(normalizedLegs.legs.map((leg) => leg.evento))].join(" | ")
      : input.evento,
    mercado: normalizedLegs?.legs[0]?.mercado ?? input.mercado,
    selecao: input.selecao,
    esporte: input.esporte,
    casaDeAposta: input.casaDeAposta || undefined,
    liveScore: liveScore.score,
    client,
    preserveSelecao: normalizedLegs != null,
  });
  return { input, propTerms, normalizedLegs, normalized };
}

type NormalizedRegistration = Awaited<ReturnType<typeof normalizeRegistration>>;
type RegistrationInput = NormalizedRegistration["input"];

/** Uso anterior da origem: aposta, duplicata absorvida ou origem aposentada com o tipster. */
export type SourceUse =
  | { kind: "bet"; betId: string; deleted: boolean }
  | { kind: "retired"; betId: string };

type SourceUseClient = Pick<Prisma.TransactionClient, "bet" | "retiredBetSource" | "absorbedBetSource" | "$queryRaw">;

/**
 * O que impede gravar `externalId`. A mensagem sozinha ocupa o post inteiro,
 * itens de lote incluídos. O item `<id>:<n>` esbarra nele mesmo e na mensagem
 * sozinha, mas não nos irmãos do mesmo lote, que a transação do lote grava em
 * sequência.
 */
function registrationConflictWhere(externalId: string): ExternalIdsWhere {
  const postId = postIdOfExternalId(externalId);
  return postId === externalId
    ? postExternalIdsWhere([postId])
    : { OR: [{ sourceExternalId: externalId }, { sourceExternalId: postId }] };
}

/**
 * Uso anterior de uma origem externa (reentrega do Telegram, edit). Inclui
 * apostas removidas, duplicatas absorvidas e origens aposentadas.
 */
async function findSourceUse(
  db: SourceUseClient,
  source: string,
  ids: ExternalIdsWhere,
): Promise<SourceUse | null> {
  if (ids.OR.length === 0) return null;
  const bets = await db.bet.findMany({
    where: { source, ...ids },
    select: { id: true, deletedAt: true },
    orderBy: { sourceExternalId: "asc" },
  });
  const live = bets.find((bet) => bet.deletedAt === null);
  const first = live ?? bets[0];
  if (first) return { kind: "bet", betId: first.id, deleted: !live };
  const absorbed = await db.absorbedBetSource.findFirst({
    where: { source, ...ids },
    select: { bet: { select: { id: true, deletedAt: true } } },
    orderBy: { sourceExternalId: "asc" },
  });
  if (absorbed) return { kind: "bet", betId: absorbed.bet.id, deleted: absorbed.bet.deletedAt !== null };
  // A auditoria já existente prova a decisão sem reescrever dados antigos.
  // O recibo novo dispensa essa dependência para as próximas capturas.
  const legacy = await db.$queryRaw<Array<{ id: string; deletedAt: Date | null }>>(Prisma.sql`
    SELECT b.id, b."deletedAt" FROM audit_events AS a JOIN bets AS b ON b.id = a."resourceId"
    WHERE a.action = 'bet.duplicate_absorbed' AND a.resource = 'bet'
      AND a.details->>'source' = ${source}
      AND (${Prisma.join(ids.OR.map(({ sourceExternalId: id }) => typeof id === "string"
        ? Prisma.sql`a.details->>'sourceExternalId' = ${id}`
        : Prisma.sql`starts_with(a.details->>'sourceExternalId', ${id.startsWith})`), " OR ")})
    ORDER BY a."createdAt", a.id LIMIT 1
  `);
  if (legacy[0]) return { kind: "bet", betId: legacy[0].id, deleted: legacy[0].deletedAt !== null };
  const retired = await db.retiredBetSource.findFirst({
    where: { source, ...ids },
    select: { retiredBetId: true },
  });
  return retired ? { kind: "retired", betId: retired.retiredBetId } : null;
}

/**
 * A mensagem do Telegram (inteira, com os itens de lote) já virou aposta
 * alguma vez? Várias mensagens valem para o álbum, cuja aposta fica na foto
 * que venceu.
 */
export function findPostSourceUse(
  source: string,
  postIds: string | readonly string[],
  db: SourceUseClient = prisma,
): Promise<SourceUse | null> {
  return findSourceUse(db, source, postExternalIdsWhere(typeof postIds === "string" ? [postIds] : postIds));
}

async function findSourceDuplicateTx(
  tx: Prisma.TransactionClient,
  input: RegistrationInput,
  mercadoMatched: boolean,
): Promise<RegisterBetResult | null> {
  if (!input.sourceExternalId) return null;
  const used = await findSourceUse(tx, input.source, registrationConflictWhere(input.sourceExternalId));
  if (!used) return null;
  return {
    created: false,
    betId: used.betId,
    duplicateOfId: used.betId,
    duplicateWasDeleted: used.kind === "retired" || used.deleted,
    mercadoMatched,
    sportResolutionStatus: input.sportResolutionStatus,
  };
}

const EXACT_KICKOFF_TOLERANCE_MS = 60_000;
/** Do post até 36 h depois: onde cabe o kickoff real de uma tip. */
const POST_TO_KICKOFF_MAX_MS = 36 * 3_600_000;

type DuplicateMoment = { source: string; data: Date; kickoffInferido: boolean; esporte: string };

/**
 * O mesmo pick chegando por outra origem (canal × DM, a aposta passada à mão)
 * pode ter esporte e horário já confirmados de um lado e ainda não do outro:
 * esporte Unknown não separa, e o horário inferido (a hora do post) casa com o
 * kickoff que cabe entre o post e 36 h depois. Na mesma origem nada relaxa:
 * um repost no canal é outra aposta.
 */
function sameBetMoment(a: DuplicateMoment, b: DuplicateMoment): boolean {
  const gap = b.data.getTime() - a.data.getTime();
  const exactClose = Math.abs(gap) <= EXACT_KICKOFF_TOLERANCE_MS;
  if (a.source === b.source) return a.esporte === b.esporte && exactClose;
  if (a.esporte !== b.esporte && a.esporte !== UNKNOWN_SPORT && b.esporte !== UNKNOWN_SPORT) return false;
  if (!a.kickoffInferido && !b.kickoffInferido) return exactClose;
  if (a.kickoffInferido && b.kickoffInferido) return Math.abs(gap) <= POST_TO_KICKOFF_MAX_MS;
  const [post, kickoff] = a.kickoffInferido ? [a.data, b.data] : [b.data, a.data];
  const sincePost = kickoff.getTime() - post.getTime();
  return sincePost >= -EXACT_KICKOFF_TOLERANCE_MS && sincePost <= POST_TO_KICKOFF_MAX_MS;
}

/** Os termos de um lado da comparação, com o contexto dos nomes dos times. */
type DuplicateTerms = { evento: string; mercado: string; selecao: string; pais: string; competicao: string };

/** Os termos que a captura gravou na evidência da aposta (`registerCapturedBet`). */
const capturedDuplicateTermsSchema = capturedTermsSchema
  .pick({ evento: true, mercado: true, selecao: true })
  .extend({ pais: z.string().catch(""), competicao: z.string().catch("") });

/**
 * Os termos com que a captura gravou a aposta, quando eles mudaram depois: o
 * casamento com o fornecedor troca o evento e a seleção pelos da Pinnacle, o
 * mercado pelo dela, e o país e a competição pelos da liga. Só aposta
 * simples: a múltipla normaliza perna a perna.
 */
function capturedTermsBeforeMatch(candidate: {
  evento: string;
  mercado: string;
  selecao: string;
  legsJson: unknown;
  captureEvidence: { parsedJson: Prisma.JsonValue } | null;
}): DuplicateTerms | null {
  if (candidate.legsJson != null) return null;
  const parsed = capturedDuplicateTermsSchema.safeParse(candidate.captureEvidence?.parsedJson);
  if (!parsed.success) return null;
  const captured = parsed.data;
  const unchanged = (["evento", "mercado", "selecao"] as const)
    .every((field) => normalizeStr(captured[field]) === normalizeStr(candidate[field]));
  return unchanged ? null : captured;
}

/**
 * Conteúdo idêntico ATIVO na mesma banca (double-submit, mesmo post por
 * caminhos diferentes, `sameBetMoment`). Removidas não entram: a exclusão
 * manual permite recriar a mesma aposta.
 *
 * Os dois lados são comparados como a captura os grava: com os nomes do
 * tipster (só a seleção nacional em português é trocada) e o mercado do
 * catálogo do esporte. A ficha do time não entra nem para comparar: uma
 * tradução errada juntaria duas apostas diferentes, e a engolida some sem
 * aviso, enquanto a repetida que escapa aparece para o dono remover. A aposta que o fornecedor já
 * renomeou é comparada também pelos termos que a captura gravou.
 */
async function findExactDuplicate(
  tx: Prisma.TransactionClient,
  bet: DuplicateMoment & {
    bankrollId: string;
    evento: string;
    mercado: string;
    selecao: string;
    liveScoreHome: number | null;
    liveScoreAway: number | null;
    casaDeAposta: string;
    odds: number;
    stake: number;
    legsJson: unknown;
    /** Termos como chegaram, para reler sob o esporte do outro lado. */
    raw: DuplicateTerms;
    client?: MercadoCatalogClient;
  },
): Promise<{ id: string } | null> {
  const window = POST_TO_KICKOFF_MAX_MS + EXACT_KICKOFF_TOLERANCE_MS;
  const candidates = await tx.bet.findMany({
    where: {
      bankrollId: bet.bankrollId,
      ...(bet.esporte === UNKNOWN_SPORT ? {} : { esporte: { in: [bet.esporte, UNKNOWN_SPORT] } }),
      deletedAt: null,
      data: {
        gte: new Date(bet.data.getTime() - window),
        lte: new Date(bet.data.getTime() + window),
      },
      odds: roundMoney(bet.odds, 4),
      stake: roundMoney(bet.stake, 6),
    },
    select: {
      id: true,
      source: true,
      data: true,
      kickoffInferido: true,
      esporte: true,
      evento: true,
      mercado: true,
      selecao: true,
      pais: true,
      competicao: true,
      liveScoreHome: true,
      liveScoreAway: true,
      casaDeAposta: true,
      legsJson: true,
      captureEvidence: { select: { parsedJson: true } },
    },
  });
  const textOf = (fields: { evento: string; mercado: string; selecao: string }) =>
    [fields.evento, fields.mercado, fields.selecao, bet.casaDeAposta].map(normalizeStr);
  // Os nomes treinados e o catálogo dos mercados dependem do esporte: sem
  // ele, os nomes e o mercado ficam como chegaram. Os termos são canonizados
  // sob `sport` como a captura os teria gravado. País e competição que eles
  // não trazem vêm do outro lado: desempatam o nome ambíguo ("Atlético").
  const underSport = async (fields: DuplicateTerms, sport: string, context: { pais: string; competicao: string }) => {
    try {
      const canonical = await canonicalizeBetForRegistration({
        ...fields, esporte: sport, pais: fields.pais || context.pais, competicao: fields.competicao || context.competicao,
      });
      return textOf(await normalizeBetFields({
        evento: canonical.evento, mercado: canonical.mercado, selecao: canonical.selecao, esporte: sport,
        casaDeAposta: bet.casaDeAposta || undefined, client: bet.client,
        liveScore: bet.liveScoreHome != null && bet.liveScoreAway != null
          ? { home: bet.liveScoreHome, away: bet.liveScoreAway }
          : null,
      }));
    } catch {
      return null;
    }
  };
  // Na múltipla, o lado Unknown guarda o mercado de cada perna sem o catálogo
  // do esporte ("Moneyline" × "Money Line – Match"): as pernas dele são
  // relidas no esporte do outro lado. O evento e o mercado do cabeçalho saem
  // das pernas, então só a seleção, que fica como chegou, é comparada. Os
  // nomes dos times ficam como cada lado gravou.
  const sameTicketUnderSport = async (candidate: { esporte: string; selecao: string; legsJson: unknown }) => {
    if (candidate.esporte === bet.esporte || candidate.legsJson == null || bet.legsJson == null ||
      normalizeStr(candidate.selecao) !== normalizeStr(bet.selecao)) return false;
    const [unknownSide, knownSide, sport] = bet.esporte === UNKNOWN_SPORT
      ? [bet.legsJson, candidate.legsJson, candidate.esporte]
      : [candidate.legsJson, bet.legsJson, bet.esporte];
    const ticket = parseStoredLegs(unknownSide);
    if (!ticket) return false;
    try {
      return sameBetLegs(await normalizeTicketLegs(ticket, sport, bet.casaDeAposta, bet.client), knownSide);
    } catch {
      return false;
    }
  };
  const expected = textOf(bet);
  for (const candidate of candidates) {
    if (!sameBetMoment(candidate, bet) ||
      candidate.liveScoreHome !== bet.liveScoreHome || candidate.liveScoreAway !== bet.liveScoreAway ||
      normalizeStr(candidate.casaDeAposta) !== normalizeStr(bet.casaDeAposta)) continue;
    if (!sameBetLegs(candidate.legsJson, bet.legsJson)) {
      if (await sameTicketUnderSport(candidate)) return candidate;
      continue;
    }
    // O lado Unknown é relido sob o esporte do outro.
    const crossSport = bet.legsJson == null && candidate.esporte !== bet.esporte;
    const incomingUnknown = crossSport && bet.esporte === UNKNOWN_SPORT;
    const sport = incomingUnknown ? candidate.esporte : bet.esporte;
    const incoming = incomingUnknown ? await underSport(bet.raw, sport, candidate) : expected;
    if (!incoming) continue;
    const stored = [crossSport && candidate.esporte === UNKNOWN_SPORT ? await underSport(candidate, sport, bet.raw) : textOf(candidate)];
    const captured = capturedTermsBeforeMatch(candidate);
    if (captured) stored.push(await underSport(captured, sport, candidate));
    if (stored.some((terms) => terms?.every((value, index) => value === incoming[index]))) return candidate;
  }
  return null;
}

/**
 * Contexto financeiro conservado da origem (política de stake e valor da
 * unidade no instante da captura). A stake registrada precisa corresponder a
 * essa política; divergência é recusa, não reinterpretação.
 */
async function registrationFinancialHistory(
  tx: Prisma.TransactionClient,
  input: Pick<RegisterBetInput, "captureEvidence" | "stake" | "bankrollId" | "source" | "sourceExternalId">,
  contextId?: string,
) {
  const saved = preserveCaptureStakeSnapshot(input.captureEvidence?.parsed);
  if (!contextId) return { context: null, snapshot: saved, stake: input.stake };
  const context = await tx.captureFinancialContext.findUniqueOrThrow({ where: { id: contextId } });
  const postId = input.sourceExternalId ? postIdOfExternalId(input.sourceExternalId) : undefined;
  const albumId = context.sourceExternalId.startsWith("album:") ? context.sourceExternalId.slice(6) : null;
  const album = albumId ? await tx.telegramMediaAlbum.findUnique({ where: { mediaGroupId: albumId }, select: { winnerMessageId: true, chatId: true } }) : null;
  const belongsToSource = albumId
    ? album && String(album.winnerMessageId) === postId && telegramChannelSource(album.chatId) === input.source
    : context.sourceExternalId === postId;
  if (context.bankrollId !== input.bankrollId || context.source !== input.source || !belongsToSource) {
    throw new Error("Configuração financeira não corresponde à origem/tipster da captura.");
  }
  const settings = { stakePolicy: context.stakePolicy, defaultStakeUnits: context.defaultStakeUnits === null ? null : toNumber(context.defaultStakeUnits) };
  if (saved && (saved.stakePolicy !== settings.stakePolicy || saved.defaultStakeUnits !== settings.defaultStakeUnits)) {
    throw new Error("A leitura usou uma política de stake diferente da origem.");
  }
  const resolved = resolveCaptureStake(saved ? saved.originalStake : settings.stakePolicy === "ALWAYS" ? null : input.stake, settings, { zeroIsMissing: true });
  if (!resolved.snapshot || resolved.stake === null || resolved.stake <= 0 || Math.abs(resolved.stake - input.stake) > BET_UNIT_MIN_AMOUNT) {
    throw new Error("A stake não corresponde à política financeira da origem.");
  }
  return { context, snapshot: { ...resolved.snapshot, basis: "CAPTURE" as const }, stake: input.stake };
}

type RegistrationFinancial = Awaited<ReturnType<typeof registrationFinancialHistory>>;
type Bankroll = { id: string; nome: string; vincularContas: boolean; valorUnidade: Prisma.Decimal };

function captureReaderJson(evidence: RegistrationInput["captureEvidence"]): Prisma.InputJsonObject | undefined {
  const reader = evidence && !evidence.completedByOwner ? captureReaderOf(evidence.parser, evidence.parsed) : null;
  return reader ?? undefined;
}

/** Aposta, contrato de prop de jogador e evidência da captura. */
async function createBetTx(tx: Prisma.TransactionClient, params: {
  bankroll: Bankroll;
  contaId: string | null;
  input: RegistrationInput;
  normalized: NormalizedRegistration["normalized"];
  legsJson: BetLegsTicket | undefined;
  propTerms: PlayerPropTerms | null;
  financial: RegistrationFinancial;
}) {
  const { bankroll, input, financial, legsJson, propTerms } = params;
  const { evento, mercado, selecao } = params.normalized;
  const bet = await tx.bet.create({
    data: {
      bankrollId: bankroll.id,
      contaId: params.contaId,
      data: input.data,
      kickoffInferido: input.kickoffInferido,
      evento,
      esporte: input.esporte,
      sportResolutionStatus: input.sportResolutionStatus,
      sportConfidence: input.sportConfidence,
      sportSource: input.sportSource,
      sportEvidence:
        input.sportEvidence === undefined
          ? undefined
          : (input.sportEvidence as Prisma.InputJsonValue),
      sportResolvedAt:
        input.sportResolutionStatus === SportResolutionStatus.CONFIRMED
          ? new Date()
          : null,
      sportResolverVersion: input.sportResolverVersion,
      competicao: input.competicao,
      pais: input.pais,
      casaDeAposta: input.casaDeAposta,
      tipster: input.tipster || bankroll.nome,
      mercado,
      selecao,
      liveScoreHome: input.liveScoreHome,
      liveScoreAway: input.liveScoreAway,
      liveTextAtCapture: mentionsLiveEntryNearBet(input.captureEvidence?.caption, input.selecao),
      captureReader: captureReaderJson(input.captureEvidence),
      odds: input.odds,
      stake: input.stake,
      valorUnidade: financial.context?.valorUnidade ?? bankroll.valorUnidade,
      captureFinancialContextId: financial.context?.id,
      captureStakeSnapshot: financial.snapshot ?? undefined,
      status: "PENDING",
      legsJson: legsJson === undefined
        ? undefined
        : (legsJson as Prisma.InputJsonValue),
      source: input.source,
      sourceExternalId: input.sourceExternalId,
      sourcePostedAt: input.sourcePostedAt,
    },
    select: { id: true, valorUnidade: true, legsJson: true },
  });

  const playerProp = propTerms && !legsJson
    ? await tx.betPlayerProp.create({
        data: { betId: bet.id, terms: propTerms, rule: playerPropRule(input.casaDeAposta, propTerms.family) },
        select: { terms: true, rule: true },
      })
    : null;

  if (input.captureEvidence) {
    await tx.betCaptureEvidence.create({
      data: {
        betId: bet.id,
        parser: input.captureEvidence.parser,
        caption: input.captureEvidence.caption,
        mediaFileId: input.captureEvidence.mediaFileId,
        parsedJson: captureRegisteredOcrEvidence(input.captureEvidence.parsed, { evento, mercado, selecao,
          odds: input.odds, stake: input.stake, liveScoreHome: input.liveScoreHome, liveScoreAway: input.liveScoreAway }) as Prisma.InputJsonValue,
        candidatesJson:
          input.captureEvidence.candidates === undefined
            ? undefined
            : (input.captureEvidence.candidates as Prisma.InputJsonValue),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
  }
  return { ...bet, playerProp };
}

/**
 * A mesma aposta que chegou de novo por outro caminho (DM, outro item de
 * lote, painel) fica na que já existe. O registro na aposta que a engoliu diz
 * de onde veio a repetida: sem ele, o item de lote pulado pela dedupe some sem
 * rastro, e a trilha da aposta o mostra.
 */
async function auditAbsorbedDuplicateTx(tx: Prisma.TransactionClient, params: {
  betId: string;
  input: RegistrationInput;
  normalized: NormalizedRegistration["normalized"];
}): Promise<void> {
  const { betId, input, normalized } = params;
  if (input.sourceExternalId) {
    await tx.absorbedBetSource.create({ data: { source: input.source, sourceExternalId: input.sourceExternalId, betId } });
  }
  await tx.auditEvent.create({
    data: {
      actor: input.actor,
      action: "bet.duplicate_absorbed",
      resource: "bet",
      resourceId: betId,
      details: {
        source: input.source,
        sourceExternalId: input.sourceExternalId ?? null,
        sourcePostedAt: input.sourcePostedAt?.toISOString() ?? null,
        evento: normalized.evento,
        mercado: normalized.mercado,
        selecao: normalized.selecao,
        odds: input.odds,
        stake: input.stake,
      },
    },
  });
  log.info(
    { eventCode: LOG_EVENTS.BET_DUPLICATE_ABSORBED, betId, source: input.source, sourceExternalId: input.sourceExternalId ?? null },
    "aposta repetida: ficou na aposta que já existia",
  );
}

async function auditBetCreateTx(tx: Prisma.TransactionClient, params: {
  bet: Awaited<ReturnType<typeof createBetTx>>;
  bankrollId: string;
  contaId: string | null;
  input: RegistrationInput;
  normalized: NormalizedRegistration["normalized"];
  financial: RegistrationFinancial;
}): Promise<void> {
  const { input, normalized, financial } = params;
  await tx.auditEvent.create({
    data: {
      actor: input.actor,
      action: "bet.create",
      resource: "bet",
      resourceId: params.bet.id,
      details: {
        bankrollId: params.bankrollId,
        data: input.data.toISOString(),
        esporte: input.esporte,
        pais: input.pais,
        competicao: input.competicao,
        casaDeAposta: input.casaDeAposta,
        valorUnidade: toNumber(params.bet.valorUnidade),
        legsJson: params.bet.legsJson,
        playerProp: params.bet.playerProp,
        evento: normalized.evento,
        mercado: normalized.mercado,
        mercadoMatched: normalized.mercadoMatched,
        mercadoAliasConflict: normalized.mercadoAliasConflict ?? null,
        selecao: normalized.selecao,
        liveScoreHome: input.liveScoreHome,
        liveScoreAway: input.liveScoreAway,
        odds: input.odds,
        stake: input.stake,
        captureFinancialContextId: financial.context?.id,
        captureStakeBasis: financial.snapshot?.basis ?? "UNKNOWN",
        stakePolicySnapshot: (input.captureEvidence?.parsed as { stakePolicySnapshot?: Prisma.InputJsonValue } | undefined)?.stakePolicySnapshot,
        source: input.source,
        sourceExternalId: input.sourceExternalId ?? null,
        sourcePostedAt: input.sourcePostedAt?.toISOString(),
        contaId: params.contaId,
        kickoffInferido: input.kickoffInferido,
        sportResolutionStatus: input.sportResolutionStatus,
        sportConfidence: input.sportConfidence,
        sportSource: input.sportSource,
      },
    },
  });
}

export async function registerBet(
  rawInput: RegisterBetInput,
  options?: { client?: SerializableTransactionClient & MercadoCatalogClient; financialContextId?: string; captureFollowupOrigin?: CaptureFollowupOrigin },
): Promise<RegisterBetResult> {
  const { input, propTerms, normalizedLegs, normalized } = await normalizeRegistration(rawInput, options?.client);
  const { mercadoMatched } = normalized;

  return runSerializableTransaction(
    "registerBet",
    async (tx) => {
      const bankroll = await tx.bankroll.findFirst({
        where: { id: input.bankrollId },
        select: { id: true, nome: true, vincularContas: true, valorUnidade: true },
      });
      if (!bankroll) {
        throw new Error(`Tipster ${input.bankrollId} inexistente ou removido.`);
      }

      const sourceDuplicate = await findSourceDuplicateTx(tx, input, mercadoMatched);
      if (sourceDuplicate) return sourceDuplicate;

      const financial = await registrationFinancialHistory(tx, input, options?.financialContextId);
      const duplicate = await findExactDuplicate(tx, {
        legsJson: normalizedLegs,
        bankrollId: bankroll.id,
        source: input.source,
        esporte: input.esporte,
        data: input.data,
        kickoffInferido: input.kickoffInferido,
        raw: { evento: input.evento, mercado: input.mercado, selecao: input.selecao, pais: input.pais, competicao: input.competicao },
        client: options?.client,
        evento: normalized.evento,
        mercado: normalized.mercado,
        selecao: normalized.selecao,
        liveScoreHome: input.liveScoreHome,
        liveScoreAway: input.liveScoreAway,
        casaDeAposta: input.casaDeAposta,
        odds: input.odds,
        stake: input.stake,
      });
      if (duplicate) {
        await auditAbsorbedDuplicateTx(tx, { betId: duplicate.id, input, normalized });
        return {
          created: false,
          betId: duplicate.id,
          duplicateOfId: duplicate.id,
          mercadoMatched,
          sportResolutionStatus: input.sportResolutionStatus,
        };
      }

      const contaId =
        bankroll.vincularContas && input.casaDeAposta
          ? await findContaAtivaParaCasa(tx, {
              bankrollId: bankroll.id,
              casaDeAposta: input.casaDeAposta,
            })
          : null;
      const bet = await createBetTx(tx, {
        bankroll, contaId, input, normalized, financial, propTerms,
        legsJson: normalizedLegs ?? undefined,
      });

      if (normalized.mercadoAliasConflict) {
        await reportMercadoAliasConflictTx(tx, {
          betId: bet.id,
          mercadoRecebido: input.mercado,
          esporte: input.esporte,
          conflict: normalized.mercadoAliasConflict,
        });
      }
      await auditBetCreateTx(tx, { bet, bankrollId: bankroll.id, contaId, input, normalized, financial });

      const notTaken = await reconcileCapturedReactionTx(tx, input);
      const captureFollowupId = !notTaken && options?.captureFollowupOrigin
        ? await recordCaptureFollowupTx(tx, bet.id, options.captureFollowupOrigin, input.actor)
        : undefined;
      return {
        created: true,
        ...(captureFollowupId ? { captureFollowupId } : {}),
        ...(notTaken ? { notTaken: true } : {}),
        betId: bet.id,
        mercadoMatched,
        sportResolutionStatus: input.sportResolutionStatus,
      };
    },
    options,
  );
}
