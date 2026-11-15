import type { Prisma } from "@/src/generated/prisma/client";
import { SportResolutionStatus, type SportResolutionSource } from "@/src/generated/prisma/enums";
import { spDayKey } from "@/src/domain/dates";
import { markSoccerReserveTeams } from "@/src/domain/text";
import { toNumber } from "@/src/domain/money";
import {
  canSearchSportOnWeb,
  nextWebSportSearchAt,
  WEB_SPORT_MEMORY_PROVIDER,
  webSportSearchTurn,
  type WebSportSearchTurn,
} from "@/src/domain/sport-resolution-retry";
import {
  SPORT_AUTO_CONFIRM_MIN_CONFIDENCE, SPORT_RESOLVER_VERSION, unresolvedSportDecision, type SportEvidence,
} from "@/src/domain/sports/detect";
import { canonicalSport, type CanonicalSport } from "@/src/domain/sports/registry";
import { isGeminiSearchAvailable } from "@/src/infra/llm/gemini-search";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { prisma } from "@/src/infra/prisma";
import { flashscoreDateRetryAt } from "@/src/providers/flashscore/date-window";
import { deleteProviderCache, readProviderCache, writeProviderCache } from "@/src/providers/provider-cache";
import { applyBetEdit, StaleSportResolutionError } from "@/src/services/bets/edit";
import {
  applyChannelSports, canonicalChannelSports, CHANNEL_SPORT_CONFIDENCE, postScores, postSignals, refutingPostSports,
} from "@/src/services/bets/sport-resolution/capture";
import { BetRemovedError } from "@/src/services/bets/settle";
import { collectSportCandidates } from "./collect-candidates";
import {
  bornInSportConflict,
  candidateHints,
  channelPicksHomonym,
  chooseSportCandidate,
  jsonObject,
  sportResolutionWindowOpen,
  type SportChoice,
} from "./decision";
import { persistCandidates } from "./persistence";
import { searchWebSportCandidate } from "./provider-candidates";
import type { SportBridgeCursor, SportCandidate, SportConfirmationIdentity, SportResolutionRun } from "./types";

/**
 * Resolução da modalidade de uma aposta: coleta candidatos nos catálogos (e,
 * quando eles falham, na web), decide e confirma pela porta única de edição.
 */

type ResolutionBet = {
  deletedAt: Date | null;
  esporte: string;
  data: Date;
  kickoffInferido: boolean;
  sportResolutionStatus: SportResolutionStatus;
};

/** Casos que terminam antes de qualquer consulta externa. */
export function earlySportResolutionResult(params: {
  bet: ResolutionBet | null;
  betId: string;
  now: Date;
  force: boolean;
}): SportResolutionRun | null {
  const { bet } = params;
  if (!bet || bet.deletedAt) {
    return { betId: params.betId, status: "ignored", candidate: null, candidates: [], reason: "missing_or_deleted" };
  }
  // Nem a resolução forçada reavalia esporte confirmado: correção é do dono, pelo painel.
  if (bet.sportResolutionStatus === SportResolutionStatus.CONFIRMED) {
    const sport = canonicalSport(bet.esporte);
    return {
      betId: params.betId,
      status: "ignored",
      candidate: sport ? { sport: sport as CanonicalSport, confidence: 100, source: "LEGACY" } : null,
      candidates: [],
      reason: "already_confirmed",
    };
  }
  if (!sportResolutionWindowOpen({
    kickoff: bet.data,
    kickoffInferido: bet.kickoffInferido,
    now: params.now,
  }) && !params.force) {
    return { betId: params.betId, status: "ignored", candidate: null, candidates: [], reason: "history_window_elapsed" };
  }
  return null;
}

type SportConfirmationBet = {
  id: string;
  manualSettlementVersion: number;
  evento: string;
  mercado: string;
  selecao: string;
  odds: Prisma.Decimal;
  stake: Prisma.Decimal;
  casaDeAposta: string;
};

/**
 * O que a confirmação grava além do esporte. Flashscore e web só confirmam a
 * modalidade: competição e país da aposta ficam. O horário do candidato só
 * substitui o provisório; em aposta já liquidada, a porta de edição mantém o
 * horário que a liquidou (`isSportResolverOnSettled`), porque o candidato pode
 * ser o próximo confronto.
 */
function confirmationIdentity(bet: SportConfirmationIdentity, candidate: SportCandidate): SportConfirmationIdentity {
  const auxiliaryProvider = candidate.provider === "flashscore" || candidate.provider === "web";
  const replacesKickoff = bet.kickoffInferido && Boolean(candidate.kickoffIso);
  return {
    data: replacesKickoff && candidate.kickoffIso ? new Date(candidate.kickoffIso) : bet.data,
    kickoffInferido: replacesKickoff ? false : bet.kickoffInferido,
    competicao: auxiliaryProvider ? bet.competicao : candidate.competition ?? bet.competicao,
    pais: auxiliaryProvider ? bet.pais : candidate.country ?? bet.pais,
  };
}

/**
 * Grava a modalidade confirmada, com a revisão lida antes da consulta, para
 * uma correção concorrente vencer.
 */
export async function confirmBetSport(params: {
  bet: SportConfirmationBet;
  candidate: SportCandidate;
  candidates: SportCandidate[];
  now: Date;
  identity: SportConfirmationIdentity;
  evidence?: Record<string, unknown>;
}, options?: Parameters<typeof applyBetEdit>[1]): Promise<void> {
  const { bet, candidate, candidates } = params;
  // O "R" de reserva do tipster só vira "Reserva" com o futebol confirmado,
  // antes de o enrich e a liquidação procurarem o jogo.
  const termos = candidate.sport === "Soccer" ? markSoccerReserveTeams(bet) : bet;
  await applyBetEdit({
    betId: bet.id,
    actor: "sport-resolver",
    fields: {
      data: params.identity.data,
      evento: termos.evento,
      esporte: candidate.sport,
      competicao: params.identity.competicao,
      pais: params.identity.pais,
      mercado: bet.mercado,
      selecao: termos.selecao,
      odds: toNumber(bet.odds),
      stake: toNumber(bet.stake),
      casaDeAposta: bet.casaDeAposta,
      kickoffInferido: params.identity.kickoffInferido,
    },
    sportResolution: {
      expectedVersion: bet.manualSettlementVersion,
      status: SportResolutionStatus.CONFIRMED,
      confidence: candidate.confidence,
      source: candidate.source as SportResolutionSource,
      evidence: {
        candidates,
        selected: candidate,
        evaluatedAt: params.now.toISOString(),
        ...params.evidence,
      } as Prisma.InputJsonValue,
      resolverVersion: SPORT_RESOLVER_VERSION,
    },
  }, options);
}

/**
 * Memória da busca web por aposta: as vezes já gastas (`webSportSearchTurn`) e
 * o último candidato achado, que volta como evidência nas tentativas sem
 * busca. Vale só para os mesmos termos: aposta editada começa de novo. Some
 * quando o esporte é confirmado; senão vence 3 dias depois do jogo (no mínimo
 * 30 h) e a purga diária a apaga.
 */
const WEB_SPORT_MEMORY_MIN_TTL_MS = 30 * 3_600_000;
const WEB_SPORT_MEMORY_AFTER_KICKOFF_MS = 3 * 86_400_000;

type WebSportMemory = { terms: string; candidate: SportCandidate | null; spent: WebSportSearchTurn[] };

function webSportTerms(bet: { evento: string; data: Date; competicao: string; pais: string; mercado: string; selecao: string }): string {
  return JSON.stringify([bet.evento, spDayKey(bet.data), bet.competicao, bet.pais, bet.mercado, bet.selecao]);
}

async function readWebSportMemory(betId: string, terms: string, now: Date): Promise<WebSportMemory> {
  const cached = await readProviderCache<Partial<WebSportMemory>>({ provider: WEB_SPORT_MEMORY_PROVIDER, key: betId, now });
  if (cached?.data.terms !== terms) return { terms, candidate: null, spent: [] };
  return { terms, candidate: cached.data.candidate ?? null, spent: cached.data.spent ?? [] };
}

async function writeWebSportMemory(betId: string, memory: WebSportMemory, kickoff: Date, now: Date): Promise<void> {
  await writeProviderCache({
    provider: WEB_SPORT_MEMORY_PROVIDER,
    key: betId,
    now,
    ttlMs: Math.max(WEB_SPORT_MEMORY_MIN_TTL_MS, kickoff.getTime() + WEB_SPORT_MEMORY_AFTER_KICKOFF_MS - now.getTime()),
    data: memory as unknown as Prisma.InputJsonValue,
  });
}

/** Etapa do waterfall que achou o esporte, para medir o peso de cada fonte. */
function resolutionStage(candidate: SportCandidate, fromMemory: boolean): string {
  if (candidate.strategy === "two_provider_agreement") return "flashscore+pinnacle17";
  if (candidate.provider === "web") return fromMemory ? "web_memory" : "web";
  if (candidate.strategy === "channel_only_sport") return "channel_only_sport";
  return candidate.provider ?? candidate.source.toLowerCase();
}

type ResolveOptions = {
  attempt?: number;
  continuation?: number;
  now?: Date;
  force?: boolean;
  evaluateOnly?: boolean;
  bridgeCursor?: SportBridgeCursor;
};

/** A evidência de esporte que a captura gravou, no formato da decisão. */
function captureEvidence(parsed: ReturnType<typeof jsonObject>): SportEvidence[] {
  return (parsed.sportResolution?.evidence ?? []).flatMap((item): SportEvidence[] => {
    const sport = canonicalSport(typeof item.sport === "string" ? item.sport : null);
    const value = (item as { value?: unknown }).value;
    return sport && typeof item.source === "string" && typeof item.confidence === "number"
      ? [{ source: item.source as SportResolutionSource, sport, confidence: item.confidence, value: typeof value === "string" ? value : "" }]
      : [];
  });
}

async function resolvePendingBetSportCore(
  betId: string,
  options: ResolveOptions = {},
): Promise<SportResolutionRun> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const attempt = options.attempt ?? 0;
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: {
      id: true,
      manualSettlementVersion: true,
      deletedAt: true,
      status: true,
      evento: true,
      esporte: true,
      data: true,
      kickoffInferido: true,
      competicao: true,
      pais: true,
      mercado: true,
      selecao: true,
      odds: true,
      stake: true,
      casaDeAposta: true,
      liveScoreHome: true,
      liveScoreAway: true,
      source: true,
      bankrollId: true,
      registradoEm: true,
      sportResolutionStatus: true,
      sportEvidence: true,
      captureEvidence: { select: { parsedJson: true, caption: true } },
      bankroll: { select: { channelSports: true } },
    },
  });
  const early = earlySportResolutionResult({
    bet,
    betId,
    now,
    force: options.force === true,
  });
  if (early) return early;
  if (!bet) throw new Error("Invariante: aposta ausente após elegibilidade.");

  // A simulação do operador não entra nas métricas da operação.
  const metric = async (labels: Record<string, string | number | boolean | null>) => {
    if (options.evaluateOnly) return;
    await recordOperationalMetric({
      kind: "action",
      name: "sport.resolve",
      outcome: "success",
      durationMs: Date.now() - startedAt,
      labels,
    });
  };

  const parsed = jsonObject(bet.captureEvidence?.parsedJson ?? null);
  // Esportes marcados no canal: a busca começa por eles, candidato forte
  // dentro deles desempata homônimos, e só candidato de fora vira conflito.
  const channelSports = canonicalChannelSports(bet.bankroll.channelSports);
  const hints = [...new Set([
    ...candidateHints({ ...parsed, mercado: bet.mercado, selecao: bet.selecao }),
    ...channelSports,
  ])];
  // O que a leitura do post apontou: desmente a identidade local e, de outro
  // esporte, segura a confirmação (`chooseSportCandidate`).
  const signals = postSignals((parsed.sportResolution?.evidence ?? []).flatMap((item) => {
    const sport = canonicalSport(typeof item.sport === "string" ? item.sport : null);
    const confidence = typeof item.confidence === "number" ? item.confidence : 0;
    return sport && typeof item.source === "string" ? [{ source: item.source, sport, confidence }] : [];
  }));
  const postSports = refutingPostSports(signals);
  const terms = { competicao: bet.competicao, pais: bet.pais, kickoffInferido: bet.kickoffInferido };
  // A execução forçada é o dono pedindo a resolução: a leitura do post não a
  // segura, como o conflito da captura (a discordância dela ainda aparece no
  // resultado, `overriddenPostDissent`).
  const choice = (list: SportCandidate[]) => chooseSportCandidate(list, { postSignals: options.force ? [] : signals, bet: terms });
  const withinChannel = (list: SportCandidate[]) => {
    const inside = list.filter((candidate) => channelSports.includes(candidate.sport));
    return inside.some((candidate) => candidate.confidence >= SPORT_AUTO_CONFIRM_MIN_CONFIDENCE) ? inside : list;
  };
  const progress: { bridgeCursor?: SportBridgeCursor; retryAt?: Date } = {};
  const windowRetryAt = flashscoreDateRetryAt(spDayKey(bet.data), now);
  const providerCandidates = await collectSportCandidates(bet, hints, {
    now,
    postSports,
    postScores: postScores(bet, bet.captureEvidence?.caption ?? ""),
    readTerms: typeof parsed.mercado === "string" && typeof parsed.selecao === "string"
      ? { mercado: parsed.mercado, selecao: parsed.selecao }
      : undefined,
    bridgeCursor: options.bridgeCursor,
    onBridgeDeferred: (cursor, retryAt) => { progress.bridgeCursor = cursor; progress.retryAt = retryAt; },
  });
  const preliminary = choice(withinChannel(providerCandidates));
  const catalogsMiss = !preliminary.candidate && !preliminary.conflict;
  const memory = await readWebSportMemory(betId, webSportTerms(bet), now);
  const turn = webSportSearchTurn({ attempt, kickoff: bet.data, kickoffInferido: bet.kickoffInferido, now });
  const searchWeb = catalogsMiss && isGeminiSearchAvailable() && canSearchSportOnWeb({
    turn,
    spent: memory.spent,
    continuation: options.continuation ?? 0,
    outsideWindow: Boolean(windowRetryAt),
    capacityDeferred: Boolean(progress.retryAt),
    force: options.force,
  });
  let webCandidate: SportCandidate | null = null;
  let spent = memory.spent;
  if (searchWeb) {
    const web = await searchWebSportCandidate(bet);
    webCandidate = web.candidate;
    if (web.answered) {
      spent = turn && !spent.includes(turn) ? [...spent, turn] : spent;
      if (!options.evaluateOnly) {
        await writeWebSportMemory(betId, { ...memory, candidate: web.candidate ?? memory.candidate, spent }, bet.data, now);
      }
    }
    await metric({
      result: web.candidate ? "web_fallback" : web.answered ? "web_miss" : "web_unavailable",
      missReason: "catalogs_miss",
      captureSource: bet.source,
      attempt,
      ...(turn ? { webTurn: turn } : {}),
    });
  }
  // Sem busca nesta tentativa (ou sem achado nela), vale o último candidato achado.
  const webFromMemory = catalogsMiss && !webCandidate && memory.candidate !== null;
  if (webFromMemory) webCandidate = memory.candidate;
  const candidates = withinChannel([
    ...providerCandidates,
    ...(webCandidate ? [webCandidate] : []),
  ]);
  const byCandidates = choice(candidates);
  const overridden = options.force ? chooseSportCandidate(candidates, { postSignals: signals, bet: terms }) : null;
  const overriddenPostDissent = overridden?.reason === "post_dissent" ? overridden.dissent : undefined;
  // Os esportes do canal desempatam o time homônimo só quando nenhum
  // candidato é forte. Homônimo que a leitura do post desmente não entra.
  const picked = byCandidates.reason === "no_strong_candidate" ? channelPicksHomonym(candidates, channelSports) : null;
  // Canal de um esporte só, marcado depois da captura: a mesma regra dela,
  // quando nenhum candidato achado é de outro esporte.
  const onlyChannelSport = !picked && !byCandidates.candidate && !byCandidates.conflict &&
    candidates.every((candidate) => channelSports.includes(candidate.sport))
    ? applyChannelSports(unresolvedSportDecision("PENDING", captureEvidence(parsed)), channelSports, {
        evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao,
        scores: postScores(bet, bet.captureEvidence?.caption ?? ""),
      })
    : null;
  const channelSport = picked ?? (onlyChannelSport?.status === "CONFIRMED" ? onlyChannelSport.sport : null);
  const chosen: SportChoice = channelSport
    ? {
        candidate: {
          sport: channelSport, confidence: CHANNEL_SPORT_CONFIDENCE, source: "CHANNEL",
          strategy: picked ? "channel_homonym" : "channel_only_sport",
        },
        conflict: false,
        reason: "confirmed",
      }
    : byCandidates;
  // Candidato forte fora dos esportes do canal é conflito: o escolhido, ou o
  // que a discordância ou a web sem detalhe seguraram.
  const strongest = chosen.candidate ?? chosen.leader ?? null;
  const outsideChannel = channelSports.length > 0 && strongest !== null && !channelSports.includes(strongest.sport);
  // Os candidatos ficam gravados para o dono decidir; a execução forçada é o
  // próprio dono pedindo a resolução.
  const captureConflict = !options.force && bornInSportConflict(bet);

  if (chosen.conflict || outsideChannel || captureConflict) {
    const reason = chosen.conflict ? chosen.reason : outsideChannel ? "outside_channel_sports" : "capture_conflict";
    const dissent = chosen.conflict ? chosen.dissent : undefined;
    if (!options.evaluateOnly) {
      await persistCandidates(bet, candidates, SportResolutionStatus.CONFLICT, null, { reason, ...(dissent ? { dissent } : {}) });
    }
    await metric({ result: "conflict", missReason: reason, captureSource: bet.source, bankrollId: bet.bankrollId, attempt });
    return { betId, status: "conflict", candidate: null, candidates, reason, ...(dissent ? { dissent } : {}) };
  }
  if (!chosen.candidate) {
    const reason = windowRetryAt ? "outside_provider_window" : progress.retryAt ? "provider_capacity" : chosen.reason;
    const retryAt = windowRetryAt ?? progress.retryAt;
    const { dissent } = chosen;
    if (!options.evaluateOnly) {
      await persistCandidates(
        bet,
        candidates,
        SportResolutionStatus.PENDING,
        null,
        { reason, ...(retryAt ? { retryAt: retryAt.toISOString() } : {}), ...(dissent ? { dissent } : {}) },
      );
    }
    await metric({
      result: "pending",
      missReason: reason,
      bankrollId: bet.bankrollId,
      ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
      captureSource: bet.source,
      attempt,
    });
    const nextWebSearchAt = nextWebSportSearchAt({ kickoff: bet.data, kickoffInferido: bet.kickoffInferido, now, spent });
    return {
      betId,
      status: "pending",
      candidate: null,
      candidates,
      reason,
      ...(dissent ? { dissent } : {}),
      ...(overriddenPostDissent ? { overriddenPostDissent } : {}),
      ...(retryAt ? { retryAt } : {}),
      ...(nextWebSearchAt ? { nextWebSearchAt } : {}),
      ...(progress.bridgeCursor ? { bridgeCursor: progress.bridgeCursor } : {}),
    };
  }
  const candidate = chosen.candidate;
  const identity = confirmationIdentity(bet, candidate);
  if (options.evaluateOnly) {
    // A revisão lida e o que seria gravado: o plano do operador aplica isto.
    return {
      betId, status: "evaluated", candidate, candidates, reason: "evaluation_only",
      expectedVersion: bet.manualSettlementVersion, identity,
      ...(overriddenPostDissent ? { overriddenPostDissent } : {}),
    };
  }

  try {
    await confirmBetSport({ bet, candidate, candidates, now, identity });
  } catch (err) {
    if (err instanceof BetRemovedError) {
      return { betId, status: "ignored", candidate: null, candidates, reason: "missing_or_deleted" };
    }
    throw err;
  }
  await deleteProviderCache({ provider: WEB_SPORT_MEMORY_PROVIDER, keyPrefix: betId });
  await metric({
    result: "resolved",
    stage: resolutionStage(candidate, webFromMemory && candidate === webCandidate),
    bankrollId: bet.bankrollId,
    captureToResolutionMs: Math.max(0, Date.now() - bet.registradoEm.getTime()),
    sport: candidate.sport,
    source: candidate.source,
    provider: candidate.provider ?? candidate.source,
    captureSource: bet.source,
    attempt,
  });
  return {
    betId, status: "resolved", candidate, candidates, reason: "strong_candidate_applied",
    ...(overriddenPostDissent ? { overriddenPostDissent } : {}),
  };
}

export async function resolvePendingBetSport(
  betId: string,
  options: ResolveOptions = {},
): Promise<SportResolutionRun> {
  try {
    return await resolvePendingBetSportCore(betId, options);
  } catch (error) {
    if (!(error instanceof StaleSportResolutionError)) throw error;
    // O job seguinte relê a aposta: uma confirmação humana encerra naturalmente;
    // uma edição ainda pendente recebe uma decisão calculada sobre os novos termos.
    return { betId, status: "pending", candidate: null, candidates: [],
      reason: "stale_bet", retryAt: new Date(Date.now() + 30_000) };
  }
}
