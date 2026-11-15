import { bestSearchWord, canonicalizeTeamName } from "@/src/domain/text";
import { BudgetExhaustedError, ProviderCadenceDeferredError } from "@/src/domain/provider-error";
import { getEnv } from "@/src/infra/env";
import { readProviderCache, writeProviderCache } from "@/src/providers/provider-cache";
import { BRIDGE_CATALOG_FRESH_MS, getBridgeDayCatalog } from "./catalog";
import { queryOpeningClosing, unwrapOpeningClosing } from "./client";
import { scorePreparedCandidates, type BridgeMatchCandidate, type BridgeQueryFn } from "./scoring";
import {
  readBridgeMatchSnapshot,
  writeBridgeMatchSnapshot,
  withBridgeSnapshotSingleflight,
  type BridgeObservedMatch,
  type BridgeSnapshotPurpose,
} from "./snapshot-cache";
import type { BridgeMatch } from "./types";

/**
 * Localização de partida na BridgeOdds para um evento local: por nome
 * (`findBridgeMatch`, retomável) ou pelo `match_id` já conhecido
 * (`findBridgeMatchById`). A pontuação e os pisos vivem em `scoring.ts`; aqui
 * fica a estratégia de LEITURA da API.
 *
 * A fonte primária é a busca filtrada home+away, cacheada por identidade em
 * `catalog.ts`. O catálogo do dia inteiro não é rota síncrona: com o teto
 * horário da conta, um dia de futebol custa páginas demais para uma aposta.
 */

/**
 * Uma consulta ao catálogo. `home`/`away` são os nomes usados para PONTUAR —
 * quando a busca vai por uma grafia alternativa, pontuar pela grafia preferida
 * jogaria fora justamente a fixture recém-encontrada.
 */
type BridgeSearchAttempt = {
  date: string;
  filters: { home?: string; away?: string };
  home: string;
  away: string;
};

/** Teto por lado: cada tentativa é uma página de catálogo (recurso escasso). */
const MAX_ALTERNATIVE_ATTEMPTS_PER_SIDE = 2;

function alternativeAttempts(params: {
  anchorDate: string;
  home: string;
  away: string;
  homeWord: string;
  awayWord: string;
  homeAlternatives: string[];
  awayAlternatives: string[];
}): BridgeSearchAttempt[] {
  const attempts: BridgeSearchAttempt[] = [];
  const usados = new Set([params.homeWord, params.awayWord].filter(Boolean));
  const lados = [
    { alternativas: params.homeAlternatives, lado: "home" as const },
    { alternativas: params.awayAlternatives, lado: "away" as const },
  ];
  for (const { alternativas, lado } of lados) {
    let usadas = 0;
    for (const nome of alternativas) {
      if (usadas === MAX_ALTERNATIVE_ATTEMPTS_PER_SIDE) break;
      const word = bestSearchWord(nome);
      // Grafia que reduz à mesma palavra de busca não traz informação nova.
      if (!word || usados.has(word)) continue;
      usados.add(word);
      usadas += 1;
      attempts.push({
        date: params.anchorDate,
        filters: { [lado]: word },
        home: lado === "home" ? nome : params.home,
        away: lado === "away" ? nome : params.away,
      });
    }
  }
  return attempts;
}

/**
 * Janela de datas da fase 1. A data da aposta é a âncora do contrato; consultar
 * cinco a oito catálogos por miss chegou a custar 75 páginas para uma aposta.
 * Dia 0 e vizinhos cobrem virada UTC/fuso. Kickoff provisório usa a mesma janela
 * econômica e, se não resolver, segue para as outras fontes de calendário.
 */
function bridgeSearchDateKeys(kickoffUtc: Date): string[] {
  return [0, 1, -1].map((deltaDays) =>
    new Date(kickoffUtc.getTime() + deltaDays * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Somente dados serializáveis; a observação nunca ganha a data da retomada. */
export type BridgeSearchResume = {
  signature: string;
  nextSearchAt: number;
  candidates: Array<{ candidate: BridgeMatchCandidate; observedAt: number }>;
  sawResults: boolean;
  sawTruncated: boolean;
};

type FindBridgeMatchParams = {
  home: string;
  away: string;
  bridgeSport: string;
  kickoffUtc: Date;
  query?: BridgeQueryFn;
  skipKickoffWindow?: boolean;
  now?: number;
  homeAlternatives?: string[];
  awayAlternatives?: string[];
  alternativeNameMode?: "immediate" | "deferred";
  maxSearchDurationMs?: number;
  /** Índice da busca filtrada a retomar após devolver o consumidor à fila. */
  startSearchAt?: number;
  resume?: BridgeSearchResume;
  /** Entrega candidatos ao juiz antes de gastar outras buscas. */
  stopAtCandidates?: boolean;
  /** Campeonato da aposta: com "Liga Pro Reserves", a reserva não perde para o principal. */
  competition?: string | null;
  kickoffInferido?: boolean;
};

export type FindBridgeMatchResult =
  | {
      ok: true;
      best: BridgeMatchCandidate;
      candidates: BridgeMatchCandidate[];
      /** Odds do candidato vieram de catálogo em cache — revalidar antes de usar. */
      stalePrices: boolean;
      /** Instante da resposta/cache que carregava as odds do candidato. */
      priceObservedAt: Date;
      resume?: BridgeSearchResume;
    }
  | {
      ok: false;
      reason:
        | "no_results"
        | "below_threshold"
        | "truncated"
        | "search_budget"
        | "deferred_alternatives";
      candidates: BridgeMatchCandidate[];
      /** Com `truncated`: a cota ou o prazo cortaram a busca, e não o teto de páginas. */
      incomplete?: boolean;
      nextSearchAt?: number;
      retryAt?: Date;
      resume?: BridgeSearchResume;
    };

/**
 * A Bridge respondeu, mas a resposta parou no nosso teto de páginas antes do
 * jogo: não dá para dizer que ele não está lá. Vale só para esta consulta,
 * e não para o serviço.
 */
export class BridgeAnswerCappedError extends Error {
  constructor() {
    super("BridgeOdds: a resposta parou no teto de páginas sem o jogo");
    this.name = "BridgeAnswerCappedError";
  }
}

/**
 * Debounce compartilhado (web, worker, processos) de busca sem nenhum
 * resultado: o mesmo par de nomes não gasta páginas de novo antes do TTL.
 */
type BridgeMiss = { version: 1; reason: "no_results" };

function missKey(params: {
  home: string;
  away: string;
  sport: string;
  kickoffUtc: Date;
}): string {
  return [
    "miss:v1",
    params.sport,
    params.kickoffUtc.toISOString().slice(0, 10),
    canonicalizeTeamName(params.home),
    canonicalizeTeamName(params.away),
  ].join(":");
}

export function bridgeMissTtlMs(kickoffUtc: Date, now = new Date()): number {
  const distance = kickoffUtc.getTime() - now.getTime();
  if (distance < 0) return 6 * 60 * 60_000;
  if (distance <= 8 * 60 * 60_000) return 30 * 60_000;
  return 60 * 60_000;
}

export async function hasFreshBridgeMiss(params: {
  home: string;
  away: string;
  sport: string;
  kickoffUtc: Date;
  now?: Date;
}): Promise<boolean> {
  const cached = await readProviderCache<unknown>({
    provider: "bridgeodds",
    key: missKey(params),
    now: params.now,
  });
  if (!cached || !cached.data || typeof cached.data !== "object" || Array.isArray(cached.data)) {
    return false;
  }
  const value = cached.data as Partial<BridgeMiss>;
  return value.version === 1 && value.reason === "no_results";
}

export async function rememberBridgeMiss(params: {
  home: string;
  away: string;
  sport: string;
  kickoffUtc: Date;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const payload: BridgeMiss = { version: 1, reason: "no_results" };
  await writeProviderCache({
    provider: "bridgeodds",
    key: missKey(params),
    data: payload,
    ttlMs: bridgeMissTtlMs(params.kickoffUtc, now),
    now,
  });
}

/** Busca retomável: uma espera de cota não apaga candidatos nem repete páginas concluídas. */
export async function findBridgeMatch(params: FindBridgeMatchParams): Promise<FindBridgeMatchResult> {
  const { home, away } = params;
  const homeWord = bestSearchWord(home);
  const awayWord = bestSearchWord(away);
  const dates = bridgeSearchDateKeys(params.kickoffUtc);
  const anchorDate = dates[0] ?? params.kickoffUtc.toISOString().slice(0, 10);
  const baseAttempts: BridgeSearchAttempt[] = [
    { date: anchorDate, filters: { home: homeWord, away: awayWord }, home, away },
    { date: anchorDate, filters: { home: homeWord }, home, away },
    { date: anchorDate, filters: { away: awayWord }, home, away },
    ...dates.slice(1).map((date) => ({ date, filters: { home: homeWord, away: awayWord }, home, away })),
  ];
  const alternatives = alternativeAttempts({
    anchorDate, home, away, homeWord, awayWord,
    homeAlternatives: params.homeAlternatives ?? [], awayAlternatives: params.awayAlternatives ?? [],
  });
  const attempts = [...baseAttempts, ...(params.alternativeNameMode === "deferred" ? [] : alternatives)];
  const signature = JSON.stringify([params.bridgeSport, params.kickoffUtc.toISOString(), params.skipKickoffWindow ?? false, attempts]);
  const prior = params.resume?.signature === signature ? params.resume : undefined;
  const candidates = new Map<string, { candidate: BridgeMatchCandidate; observedAt: number }>();
  for (const item of prior?.candidates ?? []) candidates.set(String(item.candidate.match.match_id), item);
  let sawResults = prior?.sawResults ?? false;
  let sawTruncated = prior?.sawTruncated ?? false;
  const start = Math.max(0, Math.min(attempts.length, Math.trunc(prior?.nextSearchAt ?? params.startSearchAt ?? 0)));
  const maxDurationMs = params.maxSearchDurationMs;
  const deadlineMs = maxDurationMs != null && Number.isFinite(maxDurationMs) && maxDurationMs > 0
    ? Date.now() + maxDurationMs
    : undefined;
  const ranked = () => [...candidates.values()].sort((a, b) => b.candidate.score - a.candidate.score).slice(0, 50);
  const resume = (nextSearchAt: number): BridgeSearchResume => ({
    signature, nextSearchAt, candidates: ranked(), sawResults, sawTruncated,
  });
  const deferred = (nextSearchAt: number, retryAt?: Date): FindBridgeMatchResult => ({
    ok: false, reason: "search_budget", candidates: ranked().map((item) => item.candidate),
    nextSearchAt, retryAt, resume: resume(nextSearchAt),
  });
  const hit = (best: BridgeMatchCandidate, nextSearchAt: number): FindBridgeMatchResult => {
    const observation = candidates.get(String(best.match.match_id));
    if (!observation) throw new Error("Candidato Bridge sem observação correspondente.");
    const observedAt = observation.observedAt;
    return {
      ok: true, best, candidates: ranked().map((item) => item.candidate),
      stalePrices: (params.now ?? Date.now()) - observedAt > BRIDGE_CATALOG_FRESH_MS,
      priceObservedAt: new Date(observedAt),
      ...(nextSearchAt < attempts.length ? { resume: resume(nextSearchAt) } : {}),
    };
  };

  if (!prior && !params.query && await hasFreshBridgeMiss({
    home, away, sport: params.bridgeSport, kickoffUtc: params.kickoffUtc, now: new Date(params.now ?? Date.now()),
  })) return { ok: false, reason: "no_results", candidates: [] };

  for (let index = start; index < attempts.length; index++) {
    // Grafias alternativas só são necessárias quando a grafia preferida não trouxe candidatos.
    if (index >= baseAttempts.length && candidates.size > 0) break;
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) return deferred(index);
    const attempt = attempts[index];
    if (!attempt) break;
    try {
      const catalog = await getBridgeDayCatalog({
        sport: params.bridgeSport, date: attempt.date, filters: attempt.filters,
        ...(params.query ? { query: params.query } : {}),
        ...(params.now != null ? { now: params.now } : {}),
        ...(deadlineMs != null ? { deadlineMs } : {}),
      });
      sawTruncated ||= catalog.truncated;
      sawResults ||= catalog.prepared.length > 0;
      const scored = scorePreparedCandidates(catalog.prepared, attempt.home, attempt.away,
        params.skipKickoffWindow ? undefined : params.kickoffUtc,
        { competition: params.competition, kickoffInferido: params.kickoffInferido });
      let newCandidate = false;
      for (const candidate of scored) {
        const key = String(candidate.match.match_id);
        const previous = candidates.get(key);
        newCandidate ||= !previous || candidate.score > previous.candidate.score;
        // Emparelha o corpo da resposta com seu próprio relógio, inclusive na retomada.
        const observedAt = catalog.observedAtByMatchId?.[key] ?? catalog.fetchedAt;
        if (!previous || observedAt >= previous.observedAt) {
          candidates.set(key, { candidate, observedAt });
        }
      }
      if (catalog.truncated) {
        return { ok: false, reason: "truncated", candidates: ranked().map((item) => item.candidate),
          ...(catalog.incomplete ? { incomplete: true } : {}) };
      }
      const strong = scored.find((candidate) => candidate.score >= getEnv().SHARP_AUTO_MATCH_MIN_SCORE);
      if (strong) return hit(strong, index + 1);
      const best = ranked()[0]?.candidate;
      if (params.stopAtCandidates && newCandidate && best) return hit(best, index + 1);
    } catch (error) {
      if (!(error instanceof ProviderCadenceDeferredError)) throw error;
      return deferred(index, error.retryAt);
    }
  }
  if (sawTruncated) return { ok: false, reason: "truncated", candidates: ranked().map((item) => item.candidate) };
  const best = ranked()[0]?.candidate;
  if (best) return hit(best, attempts.length);
  if (params.alternativeNameMode === "deferred" && alternatives.length) {
    return { ok: false, reason: "deferred_alternatives", candidates: [] };
  }
  if (!sawResults && !params.query && start === 0) await rememberBridgeMiss({
    home, away, sport: params.bridgeSport, kickoffUtc: params.kickoffUtc, now: new Date(params.now ?? Date.now()),
  });
  return { ok: false, reason: sawResults ? "below_threshold" : "no_results", candidates: [] };
}

// Busca pelo match_id já conhecido

/**
 * Caminho rápido de re-localização: a partida já foi resolvida antes e o
 * `providerMatchId` está salvo. Por dia da janela estreita: filtra por UMA
 * palavra de busca; se o id não aparecer e havia filtro, tenta sem filtro
 * (alias/rename) — evita cascata cara de findBridgeMatch. Para no 1º hit.
 *
 * `mode: "cheap"` (score-check): só o dia do kickoff, 1 GET filtrado — sem
 * cascata unfiltered × 3 dias (cap operacional compartilhado de 90/h).
 */
type FindBridgeMatchByIdParams = {
  providerMatchId: string;
  searchWord: string;
  bridgeSport: string;
  kickoffUtc: Date;
  query?: BridgeQueryFn;
  mode?: "full" | "cheap";
  purpose?: BridgeSnapshotPurpose;
  now?: Date;
  /**
   * Quem conta a busca como tentativa (a busca pós-jogo) precisa de resposta
   * completa. Sem o jogo, a cota ou o prazo acabando no meio viram
   * `BudgetExhaustedError`, e o teto de páginas vira `BridgeAnswerCappedError`,
   * em vez de "não achou".
   */
  requireComplete?: boolean;
  /** Prazo do chamador: depois dele nenhuma página nova é pedida, e a busca sai incompleta. */
  deadlineMs?: number;
};

async function findBridgeMatchByIdUncached(
  params: FindBridgeMatchByIdParams,
): Promise<BridgeMatch | null> {
  const query = params.query ?? queryOpeningClosing;
  const isTarget = (m: BridgeMatch) => String(m.match_id) === params.providerMatchId;
  let incomplete = false;
  let capped = false;
  const find = async (date: string, filters?: { home: string }) => {
    if (params.deadlineMs != null && Date.now() >= params.deadlineMs) {
      incomplete = true;
      return undefined;
    }
    const result = unwrapOpeningClosing(await query({
      date,
      sport: params.bridgeSport,
      ...(filters ? { filters } : {}),
      stopWhen: (all) => all.some(isTarget),
      ...(params.deadlineMs != null ? { deadlineMs: params.deadlineMs } : {}),
    }));
    incomplete ||= result.incomplete === true;
    capped ||= result.truncated && result.incomplete !== true;
    return result.matches.find(isTarget);
  };
  const cheap = params.mode === "cheap";
  const dates = bridgeSearchDateKeys(params.kickoffUtc);
  for (const date of cheap ? dates.slice(0, 1) : dates) {
    const match = await find(date, params.searchWord ? { home: params.searchWord } : undefined)
      ?? (!cheap && params.searchWord ? await find(date) : undefined);
    if (match) return match;
  }
  if (params.requireComplete && incomplete) throw new BudgetExhaustedError("bridgeodds", "bridge-lookup-incomplete");
  if (params.requireComplete && capped) throw new BridgeAnswerCappedError();
  return null;
}

/**
 * Mesmo snapshot é compartilhado por `match_id` entre apostas/processos.
 * Preço atual expira rápido; closing pós-kickoff é final e pode ser reutilizado.
 * Query injetada ignora persistência para testes/consumidores determinísticos.
 */
export async function findBridgeMatchByIdWithEvidence(
  params: FindBridgeMatchByIdParams,
): Promise<BridgeObservedMatch | null> {
  const purpose = params.purpose ?? "current_price";
  const now = params.now ?? new Date();
  if (params.query) {
    const match = await findBridgeMatchByIdUncached(params);
    return match ? { match, observedAt: now } : null;
  }

  const betKickoffUtc = purpose === "closing" ? params.kickoffUtc : null;
  const cached = await readBridgeMatchSnapshot({
    providerMatchId: params.providerMatchId,
    purpose,
    now,
    betKickoffUtc,
  });
  if (cached) return cached;

  // Quem pede resposta completa não pode herdar o "não achou" de uma busca
  // curta ou sem essa exigência.
  const variant = `${params.mode ?? "full"}:${params.requireComplete ? "complete" : "partial"}`;
  return withBridgeSnapshotSingleflight(params.providerMatchId, purpose, variant, async () => {
    const afterWait = await readBridgeMatchSnapshot({
      providerMatchId: params.providerMatchId,
      purpose,
      now: new Date(),
      betKickoffUtc,
    });
    if (afterWait) return afterWait;
    const match = await findBridgeMatchByIdUncached(params);
    if (!match) return null;
    const observedAt = new Date();
    const cachePurpose: BridgeSnapshotPurpose =
      purpose === "closing" && observedAt.getTime() >= params.kickoffUtc.getTime()
        ? "closing"
        : "current_price";
    return writeBridgeMatchSnapshot({ match, purpose: cachePurpose, observedAt });
  });
}
