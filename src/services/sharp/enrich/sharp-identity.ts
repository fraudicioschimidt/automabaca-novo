import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { findBridgeMatch, type FindBridgeMatchResult } from "@/src/providers/bridgeodds/match";
import { pinnacle17Configured } from "@/src/providers/pinnacle17/client";
import type { BridgeMatchCandidate } from "@/src/providers/bridgeodds/scoring";
import { bridgeSportFromEsporte } from "@/src/providers/bridgeodds/coverage-contract";
import { bridgeConfigured } from "@/src/providers/bridgeodds/client";
import {
  bridgeOddsIsAuthoritative,
  identityProviders,
} from "@/src/providers/coverage";
import { judgeMatchCandidates } from "@/src/services/sharp/judge";
import { tryPinnacle17Identity } from "./pinnacle17-identity";
import { isSegmentSharpOff } from "@/src/services/sharp/segment-policy";
import { applyTeamAliases } from "./identity-cache";
import { autoMatchAmbiguous, AUTO_MATCH_MIN_GAP, closeOpenTrainingCase, dedupeCandidates, recordTrainingCase } from "./training-cases";
import { upsertSharp, type UpsertSharpFn } from "./upsert-sharp";
import { SharpContinuationError, SHARP_BRIDGE_SLICE_MS, type EnrichDeps } from "./continuation";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";

const log = createLogger("sharp-enrich");

export type EnrichBetIdentity = {
  id: string;
  evento: string;
  esporte: string;
  competicao: string;
  pais: string;
  mercado: string;
  selecao: string;
  odds: unknown;
  data: Date;
  /** `data` é só o dia do jogo: o horário não desempata candidatos. */
  kickoffInferido?: boolean;
  /** Quando a tip entrou — decide se o preço de agora é "o da entrada". */
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  bankroll: { sharpMode: string };
  /** Recuperação histórica/fluxo que quer somente identidade, nunca preço. */
  identityOnly?: boolean;
};

export type BridgeIdentityResolved = {
  best: BridgeMatchCandidate;
  provider: "bridgeodds";
  via: "AUTO" | "LLM";
  teams: { home: string; away: string };
  /** Concordância TEXTUAL dos nomes (0–100), derivada do score do scoring. */
  confidence: number;
  /**
   * Confiança do JUIZ, quando foi ele quem decidiu. `null` no caminho AUTO.
   * Fica separada de `confidence` porque o juiz é chamado justamente para
   * sobrepor a concordância textual; sem ela não há como medir se ele acerta.
   */
  judgeConfidence: number | null;
  /** false = catálogo resolveu identidade, mas refresh do preço falhou. */
  priceFresh: boolean;
  priceObservedAt: Date;
  segmentOff: boolean;
};

export type SharpIdentityOutcome =
  | { status: "unsupported" }
  | { status: "pinnacle17_resolved" }
  | { status: "pending"; motivo: string }
  | { status: "bridge_resolved"; result: BridgeIdentityResolved };

/** Teto Bridge na entrada; preserva tempo para Pinnacle17 e persistência. */
export const BRIDGE_ENTRY_SEARCH_BUDGET_MS = SHARP_BRIDGE_SLICE_MS;
/**
 * Identidade sharp da aposta, na ordem das tentativas: a Pinnacle17 primeiro,
 * sempre que cobre o esporte, e a BridgeOdds quando ela não acha o jogo. Na
 * matriz comprovada da BridgeOdds (`bridgeOddsIsAuthoritative`) a Bridge dá
 * identidade e preço; fora dela, só identidade. A busca na Bridge passa pela
 * tradução das fichas e pelo juiz LLM na zona cinzenta, e cada falha ou
 * recusa ali devolve a vez à Pinnacle17 (no máximo uma consulta por minuto).
 */
export async function resolveSharpIdentity(
  bet: EnrichBetIdentity,
  teams: { home: string; away: string },
  deps: EnrichDeps,
  upsert: UpsertSharpFn = upsertSharp,
): Promise<SharpIdentityOutcome> {
  const idProviders = identityProviders({
    esporte: bet.esporte,
    mercado: bet.mercado,
    selecao: bet.selecao,
  });
  if (idProviders.length === 0) {
    // Esporte que nenhum provider cobre nunca terá CLV: o motivo terminal
    // explica a ausência e impede reprocessar.
    await upsert(bet.id, {
      identityStatus: "UNSUPPORTED",
      confidence: 0,
      noOddsReason: "unsupported_market",
    });
    log.info({ betId: bet.id, esporte: bet.esporte }, "esporte fora da cobertura de todos os providers");
    return { status: "unsupported" };
  }

  const betSignature = JSON.stringify([bet.evento, bet.esporte, bet.mercado, bet.selecao,
    String(bet.odds), bet.data.toISOString(), bet.pais, bet.competicao, bet.bankroll.sharpMode]);
  const previous = deps.continuation?.betSignature === betSignature ? deps.continuation : undefined;
  let pinnacle17TriedAt = previous?.pinnacle17TriedAt;

  // Pinnacle17 primeiro: a Bridge (100 chamadas/h) fica para a abertura e a
  // reserva de CLV, e a Pinnacle17 (10 mil/dia) dá a identidade que a série de
  // fechamento usa. A Bridge só entra se a Pinnacle17 não achar o jogo.
  const pinnacleFirst = idProviders.includes("pinnacle17") && pinnacle17Configured()
    && (pinnacle17TriedAt == null || Date.now() - pinnacle17TriedAt >= 60_000);
  if (pinnacleFirst) {
    const startedAt = Date.now();
    pinnacle17TriedAt = startedAt;
    const first = await tryPinnacle17Identity(bet, teams, upsert);
    await recordOperationalMetric({
      kind: "action", name: "sharp.pinnacle17_first",
      outcome: first.resolved ? "success" : "expected_retry",
      durationMs: Date.now() - startedAt, labels: { provider: "pinnacle17", resolved: first.resolved },
    });
    if (first.resolved) {
      await closeOpenTrainingCase(bet.id, "AUTO_APPLIED");
      return { status: "pinnacle17_resolved" };
    }
  }

  const bridgeSport = bridgeSportFromEsporte(bet.esporte);
  const bridgeAvailable =
    idProviders.includes("bridgeodds") && bridgeSport !== null && bridgeConfigured();
  const isBridgeAuthoritative = bridgeOddsIsAuthoritative({
    esporte: bet.esporte,
    mercado: bet.mercado,
    selecao: bet.selecao,
  });
  const useBridgeFirst = bridgeAvailable && (idProviders[0] === "bridgeodds" || isBridgeAuthoritative);
  if (!useBridgeFirst) {
    const pinnacle17 = pinnacleFirst ? { resolved: false } : await tryPinnacle17Identity(bet, teams, upsert);
    if (pinnacle17.resolved) {
      await closeOpenTrainingCase(bet.id, "AUTO_APPLIED");
      return { status: "pinnacle17_resolved" };
    }
    // Fora da matriz da Bridge, ela é só a última chance de achar a identidade.
    if (bridgeAvailable) {
      log.info({ betId: bet.id }, "Pinnacle17 sem o jogo — tenta a Bridge só para identidade");
    } else {
      const motivo = `esporte_${bet.esporte}_sem_match_nos_tiers`;
      await recordTrainingCase(bet, [], "OPEN", null, motivo);
      await upsert(bet.id, { identityStatus: "PENDING", confidence: 0 });
      return { status: "pending", motivo };
    }
  }

  const aliased = await applyTeamAliases(teams, bet.esporte, bet.pais, bet.competicao);
  const segmentOff = await isSegmentSharpOff(bet.esporte, bet.mercado);
  // A Bridge falhou ou recusou: a Pinnacle17 tem mais uma vez, no máximo uma por minuto.
  const retryPinnacle17 = async () => {
    if (!idProviders.includes("pinnacle17") || !pinnacle17Configured() ||
      (pinnacle17TriedAt != null && Date.now() - pinnacle17TriedAt < 60_000)) return { resolved: false };
    pinnacle17TriedAt = Date.now();
    const result = await tryPinnacle17Identity(bet, teams, upsert);
    await recordOperationalMetric({ kind: "action", name: "sharp.fallback", outcome: "success",
      durationMs: Date.now() - pinnacle17TriedAt, labels: { provider: "pinnacle17", resolved: result.resolved } });
    return result;
  };
  const searchBridge = () => findBridgeMatch({
    home: aliased.home, away: aliased.away, bridgeSport, kickoffUtc: bet.data, query: deps.query,
    homeAlternatives: aliased.homeResolution.alternativeNames,
    awayAlternatives: aliased.awayResolution.alternativeNames,
    maxSearchDurationMs: BRIDGE_ENTRY_SEARCH_BUDGET_MS,
    resume: previous?.bridge, stopAtCandidates: true,
    competition: bet.competicao, kickoffInferido: bet.kickoffInferido,
  });
  let found: FindBridgeMatchResult;
  try {
    found = await searchBridge();
  } catch (error) {
    // Indisponibilidade técnica da Bridge também devolve a vez à Pinnacle17.
    if ((await retryPinnacle17()).resolved) return { status: "pinnacle17_resolved" };
    throw error;
  }
  const continueSearch = () => {
    throw new SharpContinuationError(!found.ok && found.retryAt ? found.retryAt : new Date(Date.now() + 1_000), {
      betSignature, bridge: found.resume, pinnacle17TriedAt,
    });
  };

  // Soft-cap mid-paginação: miss pode ser falso — não UNMATCHED / treino prematuro.
  if (!found.ok && found.reason === "truncated") {
    if ((await retryPinnacle17()).resolved) return { status: "pinnacle17_resolved" };
    log.warn(
      { betId: bet.id, evento: bet.evento },
      "BridgeOdds truncated — adiando matching (budget_truncated)",
    );
    await upsert(bet.id, { identityStatus: "PENDING", confidence: 0 });
    return { status: "pending", motivo: "budget_truncated" };
  }

  if (!found.ok && found.reason === "search_budget") {
    if ((await retryPinnacle17()).resolved) return { status: "pinnacle17_resolved" };
    continueSearch();
  }

  let best = found.ok ? found.best : null;
  let via: "AUTO" | "LLM" = "AUTO";
  let judgeConfidence: number | null = null;
  const autoConfident = best !== null && best.score >= getEnv().SHARP_AUTO_MATCH_MIN_SCORE;
  // Empate 1º/2º (≥ piso, gap < 0.1): não AUTO — LLM / fila humana.
  const ambiguous = found.ok && autoMatchAmbiguous(found.candidates);

  if (!autoConfident || ambiguous) {
    const candidates = dedupeCandidates(found.candidates);
    const judged = await judgeMatchCandidates({
      eventoLocal: bet.evento,
      esporte: bet.esporte,
      competicaoLocal: bet.competicao,
      paisLocal: bet.pais,
      kickoffUtc: bet.data,
      candidates,
    });
    if (judged.applied) {
      best = judged.applied;
      via = "LLM";
      judgeConfidence = judged.verdict?.confidence ?? null;
      await recordTrainingCase(bet, candidates, "LLM_APPLIED", judged.verdict);
    } else {
      const pinnacle17 = await retryPinnacle17();
      if (pinnacle17.resolved) {
        await closeOpenTrainingCase(bet.id, "AUTO_APPLIED");
        return { status: "pinnacle17_resolved" };
      }
      if (found.resume) continueSearch();
      const verdict = ambiguous && !judged.verdict ? ambiguousPairVerdict(candidates) : judged.verdict;
      const motivo = unresolvedMotivo(ambiguous, judged.reason, found);
      await recordTrainingCase(bet, candidates, "OPEN", verdict, motivo);
      await upsert(bet.id, { identityStatus: "PENDING", confidence: 0 });
      return { status: "pending", motivo };
    }
  }

  if (!best) return { status: "pending", motivo: "identidade não resolvida (estado inesperado)" };

  // Persistência da identidade precede qualquer refresh de preço.
  const priceFresh = found.ok && !found.stalePrices;
  const priceObservedAt = found.ok ? found.priceObservedAt : new Date();

  const { score } = best;
  const confidence = Math.min(100, Math.round(score * 50));

  return {
    status: "bridge_resolved",
    result: {
      best, provider: "bridgeodds" as const, via, teams, confidence, judgeConfidence,
      priceFresh, priceObservedAt,
      segmentOff,
    },
  };
}

function candidateSummary(candidate: BridgeMatchCandidate | undefined) {
  return candidate
    ? {
        matchId: candidate.match.match_id,
        score: candidate.score,
        home: candidate.match.home,
        away: candidate.match.away,
      }
    : null;
}

/** Evidência gravada no caso de treino quando 1º e 2º candidatos empatam. */
function ambiguousPairVerdict(candidates: BridgeMatchCandidate[]) {
  return {
    reason: "ambiguous_pair",
    gap: AUTO_MATCH_MIN_GAP,
    first: candidateSummary(candidates[0]),
    second: candidateSummary(candidates[1]),
  };
}

function unresolvedMotivo(ambiguous: boolean, judgeReason: string | undefined, found: FindBridgeMatchResult): string {
  if (ambiguous) return "auto_ambiguo_gap";
  if (judgeReason === "unavailable") return "llm_indisponivel";
  return found.ok ? "zona_cinzenta_recusada" : found.reason;
}
