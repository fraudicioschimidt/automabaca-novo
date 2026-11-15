import { identityEventName } from "@/src/domain/live-score-at-tip";
import type { NoOddsReason } from "@/src/domain/no-odds-reason";
import type { Prisma } from "@/src/generated/prisma/client";
import {
  canonicalCompetition,
  canonicalCountry,
} from "@/src/domain/national-teams";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import type { BridgeMatchCandidate } from "@/src/providers/bridgeodds/scoring";
import {
  identityProviders,
  marketHasNoSharpReference,
  oddsProviders,
  providerCoversBet,
} from "@/src/providers/coverage";
import { pinnacle17Enabled } from "@/src/providers/pinnacle17/client";
import {
  orientPinnacle17Selection,
  releasePinnacle17ClosingIfCreated,
  selectionFollowsEventOrder,
  resolvePinnacle17SharpForBet,
} from "@/src/providers/pinnacle17/sharp";
import { encodePinnacle17PriceReference, type Pinnacle17Event } from "@/src/providers/pinnacle17/types";
import { judgeMatchCandidates } from "@/src/services/sharp/judge";
import { resolveTeamsForProvider } from "@/src/services/teams/resolve";
import { learnTipsterTeamNames } from "@/src/services/teams/tipster-names";
import { TEAM_PROVIDERS } from "@/src/services/teams/types";
import { identityDecisionIsNew, STORED_IDENTITY_SELECT } from "./apply-identity";
import { SharpContinuationError } from "./continuation";
import type { UpsertSharpFn } from "./upsert-sharp";
import { EnrichObsoleteError, expectEnrichTerms, lockActiveEnrichBet } from "./write-guard";

/**
 * A identidade pela Pinnacle17, a primeira tentativa do enrich
 * (`sharp-identity.ts`): o evento, com a referência de fechamento quando o
 * mercado tem linha. Para aposta que a Bridge casou num mercado que ela não
 * precifica, dá só a referência de fechamento.
 */

const log = createLogger("sharp-enrich");
const identityLog = createLogger("sharp-pinnacle17-identity");

export type Pinnacle17IdentityBet = {
  identityOnly?: boolean;
  id: string;
  evento: string;
  esporte: string;
  competicao: string;
  pais: string;
  mercado: string;
  selecao: string;
  odds: unknown;
  data: Date;
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  bankroll: { sharpMode: string };
  sharp?: { providerMatchId?: string | null } | null;
};

type Pinnacle17IdentityAttempt = {
  resolved: boolean;
  matched: boolean;
  identityApplied: boolean;
};

/**
 * Tenta a Pinnacle17 quando a cobertura do esporte e da família a permite.
 * `resolved` também vale para identidade gravada sem linha de preço. Falha do
 * provider não derruba o job: a Bridge ainda pode resolver.
 */
export async function tryPinnacle17Identity(
  bet: Pinnacle17IdentityBet,
  teams: { home: string; away: string },
  upsertSharp: UpsertSharpFn,
): Promise<{ resolved: boolean; provider?: "pinnacle17" }> {
  const permitted = identityProviders({
    esporte: bet.esporte,
    mercado: bet.mercado,
    selecao: bet.selecao,
  });
  if (!permitted.includes("pinnacle17") || !pinnacle17Enabled()) return { resolved: false };
  try {
    const attempt = await resolvePinnacle17Identity(bet, teams, upsertSharp);
    if (attempt.resolved || attempt.identityApplied) return { resolved: true, provider: "pinnacle17" };
  } catch (err) {
    if (err instanceof EnrichObsoleteError || err instanceof SharpContinuationError) throw err;
    log.warn({ err, provider: "pinnacle17", betId: bet.id }, "identidade pela Pinnacle17 falhou");
  }
  return { resolved: false };
}

async function persistMatchedBetUpdate(
  betId: string,
  betUpdate: Prisma.BetUpdateInput,
  sharpData: Parameters<UpsertSharpFn>[1],
  upsertSharp: UpsertSharpFn,
  orientation: { providerHome: string; providerAway: string; swapped: boolean; selectionFollowsOrder: boolean },
  audit?: { via: "AUTO" | "LLM"; judgeConfidence: number | null },
): Promise<void> {
  const updated = await prisma.$transaction(async (tx) => {
    const freshBet = await lockActiveEnrichBet(tx, betId);
    const bet = await tx.bet.update({ where: { id: betId }, data: {
      ...betUpdate, evento: identityEventName({ ...orientation, ...freshBet }),
    } });
    const stored = audit
      ? await tx.betSharp.findUnique({ where: { betId }, select: STORED_IDENTITY_SELECT })
      : null;
    await upsertSharp(betId, sharpData, tx);
    const before = { evento: freshBet.evento, esporte: freshBet.esporte, pais: freshBet.pais, competicao: freshBet.competicao,
      mercado: freshBet.mercado, selecao: freshBet.selecao, data: freshBet.data.toISOString(), kickoffInferido: freshBet.kickoffInferido };
    const after = { evento: bet.evento, esporte: bet.esporte, pais: bet.pais, competicao: bet.competicao,
      mercado: bet.mercado, selecao: bet.selecao, data: bet.data.toISOString(), kickoffInferido: bet.kickoffInferido };
    if (audit && identityDecisionIsNew({
      stored, provider: "pinnacle17", providerMatchId: String(sharpData.providerMatchId), before, after,
    })) {
      await tx.auditEvent.create({ data: {
        actor: "system", action: audit.via === "LLM" ? "identidade_llm" : "identidade_auto",
        resource: "bet", resourceId: betId,
        details: {
          via: audit.via, provider: "pinnacle17", confidence: sharpData.confidence,
          confiancaDoJuiz: audit.judgeConfidence, match: bet.evento, providerMatchId: sharpData.providerMatchId,
          antes: before,
          depois: after,
        },
      } });
    }
    return bet;
  });
  expectEnrichTerms(updated);
}

export async function resolvePinnacle17Identity(
  bet: Pinnacle17IdentityBet,
  teams: { home: string; away: string },
  upsertSharp: UpsertSharpFn,
): Promise<Pinnacle17IdentityAttempt> {
  // O preço consultado aqui só serve à referência do fechamento (CLV).
  const needsPrice = !bet.identityOnly && bet.bankroll.sharpMode === "CLV_ONLY";
  const coversPrice = providerCoversBet("pinnacle17", {
    esporte: bet.esporte,
    mercado: bet.mercado,
    selecao: bet.selecao,
  });
  const semReferenciaSharp = marketHasNoSharpReference({ esporte: bet.esporte, mercado: bet.mercado });
  // Nome com mais de uma ficha não traduz: o lado segue com o nome original e
  // a busca acontece.
  const resolvedTeams = await resolveTeamsForProvider(
    teams,
    TEAM_PROVIDERS.PINNACLE17,
    { sport: bet.esporte, pais: bet.pais, competicao: bet.competicao },
  );
  const request = {
    home: resolvedTeams.home,
    away: resolvedTeams.away,
    esporte: bet.esporte,
    mercado: bet.mercado,
    selecao: bet.selecao,
    kickoffUtc: bet.data,
    registradoEm: bet.registradoEm,
    sourcePostedAt: bet.sourcePostedAt,
    competicao: bet.competicao,
    pais: bet.pais,
  };
  const matchIdNum = bet.sharp?.providerMatchId && /^\d+$/.test(bet.sharp.providerMatchId)
    ? Number(bet.sharp.providerMatchId)
    : undefined;
  // `confidence` é a concordância textual; a certeza do juiz fica à parte.
  let judgeApplied = false;
  let judgeConfidence: number | null = null;
  const judgeCallback = async (candidates: Array<{ event: Pinnacle17Event; score: number; swapped: boolean }>) => {
    const bridgeCandidates: BridgeMatchCandidate[] = candidates.slice(0, 5).map((c) => ({
      match: {
        match_id: c.event.id,
        home: c.event.homeTeam.name,
        away: c.event.awayTeam.name,
        league: c.event.league.name,
        match_date: c.event.startTime,
        sport: bet.esporte,
        home_score: null,
        away_score: null,
      },
      score: c.score,
      swapped: c.swapped,
    }));
    const judged = await judgeMatchCandidates({
      eventoLocal: bet.evento,
      esporte: bet.esporte,
      competicaoLocal: bet.competicao,
      paisLocal: bet.pais,
      kickoffUtc: bet.data,
      candidates: bridgeCandidates,
    });
    if (judged.applied) {
      judgeApplied = true;
      judgeConfidence = judged.verdict?.confidence ?? null;
      const idx = candidates.findIndex((c) => c.event.id === judged.applied.match.match_id);
      return idx >= 0 ? idx : null;
    }
    return null;
  };
  let result = await resolvePinnacle17SharpForBet({
    ...request,
    needOdds: false,
    ...(matchIdNum ? { matchId: matchIdNum } : {}),
    judgeCandidates: judgeCallback,
  });
  if (!result.matched || !result.mainEvent) {
    return { resolved: false, matched: false, identityApplied: false };
  }
  const event = result.mainEvent;
  const kickoff = new Date(event.startTime);
  const localHome = result.swapped ? teams.away : teams.home;
  const localAway = result.swapped ? teams.home : teams.away;
  // A seleção que só diz o lado ("Casa") vira o nome do time antes da troca:
  // com o mando trocado, o rótulo passaria a apontar o outro time.
  const selecaoFinal = orientPinnacle17Selection({
    mercado: bet.mercado,
    selecao: bet.selecao,
    home: teams.home,
    away: teams.away,
    providerHome: event.homeTeam.name,
    providerAway: event.awayTeam.name,
    swapped: result.swapped,
  });
  const orientation = { providerHome: event.homeTeam.name, providerAway: event.awayTeam.name, swapped: result.swapped,
    selectionFollowsOrder: selectionFollowsEventOrder(bet.mercado, selecaoFinal) };
  const pais = canonicalCountry(event.league.country ?? "");
  const competicao = canonicalCompetition(event.league.name);
  const confidence = Math.min(100, Math.round(result.score * 50));
  const betUpdate: Prisma.BetUpdateInput = {
    evento: `${event.homeTeam.name} vs ${event.awayTeam.name}`,
    ...(selecaoFinal !== bet.selecao ? { selecao: selecaoFinal } : {}),
    ...(pais ? { pais } : {}),
    ...(competicao ? { competicao } : {}),
    ...(Number.isNaN(kickoff.getTime()) ? {} : { data: kickoff, kickoffInferido: false }),
  };

  let identityApplied = false;
  try {
    if (judgeApplied) {
      identityLog.info({
        betId: bet.id,
        provider: "pinnacle17",
        providerMatchId: String(event.id),
        confidence,
        judgeConfidence,
      }, "identidade Pinnacle17 decidida pelo juiz");
    }
    // A identidade confirmada entra antes da consulta de odds.
    await persistMatchedBetUpdate(bet.id, betUpdate, {
      identityStatus: "MATCHED", confidence, provider: "pinnacle17",
      providerMatchId: String(event.id), noOddsReason: "no_prices",
    }, upsertSharp, orientation, { via: judgeApplied ? "LLM" : "AUTO", judgeConfidence });
    identityApplied = true;
    // Aqui só o casamento automático ensina o nome do tipster (o Vincular
    // ensina pelo caminho dele): a partida que o juiz de IA escolheu vale só
    // para esta aposta, e a de id já conhecido não foi casada agora.
    if (!judgeApplied && !matchIdNum) {
      await learnTipsterTeamNames({
        betId: bet.id,
        pinnacleEventId: String(event.id),
        tipster: { home: localHome, away: localAway },
        pinnacle: { home: event.homeTeam.name, away: event.awayTeam.name },
        kickoff,
      });
    }
    if (needsPrice && coversPrice && !semReferenciaSharp) {
      const priced = await resolvePinnacle17SharpForBet({ ...request, matchId: event.id });
      if (priced.mainEvent?.id !== event.id || priced.swapped !== result.swapped) {
        await releasePinnacle17ClosingIfCreated(priced.priceReference, priced.closingReservationCreated);
        return { resolved: false, matched: true, identityApplied: true };
      }
      result = priced;
    }
    const priceReference = result.priceReference ? encodePinnacle17PriceReference(result.priceReference) : null;
    const noOddsReason = semReferenciaSharp
      ? "sem_referencia_sharp"
      : !coversPrice
        ? "unsupported_market"
        : result.current
          ? "clv_only"
          : (result.unresolvedReason ?? "no_prices");
    await persistMatchedBetUpdate(bet.id, betUpdate, {
      identityStatus: "MATCHED",
      confidence,
      provider: "pinnacle17",
      providerMatchId: String(event.id),
      priceReference,
      noOddsReason,
    }, upsertSharp, orientation);
    return {
      resolved: !needsPrice || semReferenciaSharp || result.current !== null,
      matched: true,
      identityApplied: true,
    };
  } catch (error) {
    await releasePinnacle17ClosingIfCreated(result.priceReference, result.closingReservationCreated);
    if (identityApplied && !(error instanceof EnrichObsoleteError)) {
      const deferred = new SharpContinuationError(new Date(Date.now() + 30_000));
      deferred.cause = error;
      throw deferred;
    }
    throw error;
  }
}

export type ClosingReferenceParams = {
  betId: string;
  /** `match_id` da BridgeOdds: é o id do evento na Pinnacle17. */
  matchId: number;
  home: string;
  away: string;
  esporte: string;
  competicao: string;
  pais: string;
  mercado: string;
  selecao: string;
  kickoffUtc: Date;
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  confidence: number;
  upsertSharp: UpsertSharpFn;
};

/**
 * Referência de FECHAMENTO na Pinnacle17 para aposta casada pela Bridge num
 * mercado ou linha que a Bridge não precifica (escanteios, cartões, linha
 * fora do book). A série de fechamento só roda para `provider = pinnacle17`;
 * sem esta troca a aposta ficaria sem CLV. O evento é o do mesmo id da Bridge,
 * no mesmo kickoff; a busca por nome poderia trocar de jogo.
 *
 * Sem a referência, `reason` é o que a Pinnacle17 respondeu (a linha que ela
 * ainda não lista, a consulta que falhou): o motivo que fica na aposta e, se
 * não for permanente, a faz tentar de novo até o kickoff. Null quando a
 * Pinnacle17 não serve a esta aposta.
 */
export async function tryClosingReferenceFallback(params: ClosingReferenceParams):
  Promise<{ done: true } | { done: false; reason: NoOddsReason | null }> {
  if (!oddsProviders(params).includes("pinnacle17") || !pinnacle17Enabled()) return { done: false, reason: null };
  const teams = { home: params.home, away: params.away };
  let reference: Awaited<ReturnType<typeof resolvePinnacle17SharpForBet>>["priceReference"] = null;
  let reservationCreated = false;
  try {
    const resolvedTeams = await resolveTeamsForProvider(
      teams,
      TEAM_PROVIDERS.PINNACLE17,
      { sport: params.esporte, pais: params.pais, competicao: params.competicao },
    );
    const result = await resolvePinnacle17SharpForBet({
      home: resolvedTeams.home,
      away: resolvedTeams.away,
      esporte: params.esporte,
      mercado: params.mercado,
      selecao: params.selecao,
      kickoffUtc: params.kickoffUtc,
      registradoEm: params.registradoEm,
      sourcePostedAt: params.sourcePostedAt,
      competicao: params.competicao,
      pais: params.pais,
      pinnedEventId: params.matchId,
    });
    reference = result.priceReference;
    reservationCreated = result.closingReservationCreated;
    if (!result.matched || !result.priceReference || !result.mainEvent) {
      await releasePinnacle17ClosingIfCreated(reference, reservationCreated);
      // Sem o jogo no feed, a Pinnacle17 ainda não o listou neste horário.
      return { done: false, reason: result.matched ? (result.unresolvedReason ?? "no_prices") : "market_not_listed" };
    }
    const event = result.mainEvent;
    await params.upsertSharp(params.betId, {
      identityStatus: "MATCHED",
      confidence: params.confidence,
      provider: "pinnacle17",
      providerMatchId: String(event.id),
      priceReference: encodePinnacle17PriceReference(result.priceReference),
      noOddsReason: "clv_only",
    });
    log.info(
      { betId: params.betId, mercado: params.mercado },
      "referência de fechamento na Pinnacle17 (Bridge não precifica o mercado)",
    );
    return { done: true };
  } catch (err) {
    await releasePinnacle17ClosingIfCreated(reference, reservationCreated);
    log.warn({ err, betId: params.betId }, "referência de fechamento Pinnacle17 falhou — segue com a Bridge");
    return { done: false, reason: "consulta_pinnacle_falhou" };
  }
}
