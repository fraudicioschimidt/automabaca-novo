import { bestSearchWord, splitEventoTeams } from "@/src/domain/text";
import { ticketFixtureEventos } from "@/src/domain/settlement/ticket-resolution";
import { getEnv } from "@/src/infra/env";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { findBridgeMatch, findBridgeMatchByIdWithEvidence } from "@/src/providers/bridgeodds/match";
import { writeBridgeMatchSnapshot } from "@/src/providers/bridgeodds/snapshot-cache";
import { bridgeSportFromEsporte } from "@/src/providers/bridgeodds/coverage-contract";
import type { BridgeMatch } from "@/src/providers/bridgeodds/types";
import { parseBridgeLeague } from "@/src/providers/bridgeodds/types";
import {
  canonicalCompetition,
  canonicalCountry,
} from "@/src/domain/national-teams";
import { snapshotClosingForBet } from "./pinnacle17-snapshot";
import { sameBetAsRead, writeClosingOnce } from "@/src/services/sharp/closing-guard";
import { applyTeamAliases } from "@/src/services/sharp/enrich/identity-cache";
import { processBridgeClv } from "./bridge-clv";
import type { ClosingDeps, ClosingSyncBet } from "./types";

const log = createLogger("closing");

/**
 * Quanto uma aposta pode gastar procurando o jogo na Bridge num ciclo: cabem
 * três vagas do portão de ~40 s. Sem o teto, o id que a Bridge não devolve
 * custava a cascata inteira (3 dias, com e sem filtro) a cada ciclo.
 */
const CLOSING_BRIDGE_LOOKUP_MS = 2 * 60_000;

/**
 * Segmento SHARP_OFF: congela uma vez como não confiável, sem consulta (as APIs
 * servem só à identidade).
 */
async function freezeSegmentOff(bet: ClosingSyncBet, now: Date): Promise<boolean> {
  if (bet.closing?.fetchedAt) return false;
  return writeClosingOnce(bet, "fetchedAt", {
    clvReliable: false,
    noOddsReason: "sharp_off",
    source: "CRON",
    fetchedAt: now,
  });
}

/**
 * Múltipla de jogos diferentes não tem um fechamento só: congela no kickoff
 * como `multipla`, sem consulta. Pulá-la a deixava no lote para sempre.
 */
async function freezeMultiFixtureTicket(bet: ClosingSyncBet, now: Date): Promise<boolean> {
  if (bet.closing?.fetchedAt || bet.kickoffInferido || now < bet.data) return false;
  return writeClosingOnce(bet, "fetchedAt", {
    clvReliable: false,
    noOddsReason: "multipla",
    source: "CRON",
    fetchedAt: now,
  });
}

export async function processNonBridgeClosing(
  bet: ClosingSyncBet,
  _deps: ClosingDeps,
  now: Date,
  segmentOff: boolean,
): Promise<{ closed: boolean }> {
  if (ticketFixtureEventos(bet).length > 0) {
    return { closed: await freezeMultiFixtureTicket(bet, now) };
  }

  let closed = false;
  if (!bet.closing?.fetchedAt) {
    if (segmentOff) {
      if (!bet.kickoffInferido) closed = await freezeSegmentOff(bet, now);
    } else {
      closed = (await snapshotClosingForBet(bet, now)).closed;
    }
  }

  return { closed };
}

export async function processBridgeClosing(
  bet: ClosingSyncBet,
  deps: ClosingDeps,
  now: Date,
  segmentOff = false,
): Promise<{ closed: boolean }> {
  if (bet.kickoffInferido) {
    log.debug({ betId: bet.id }, "kickoffInferido — closing Bridge adiado");
    return { closed: false };
  }

  // A BridgeOdds só consolida o fechamento depois do início. O `closing.sync`,
  // do cron ou do botão da banca, já só traz aposta que começou.
  if (now.getTime() < bet.data.getTime()) {
    return { closed: false };
  }

  if (ticketFixtureEventos(bet).length > 0) {
    return { closed: await freezeMultiFixtureTicket(bet, now) };
  }
  if (segmentOff) return { closed: await freezeSegmentOff(bet, now) };

  const teams = splitEventoTeams(bet.evento);
  const bridgeSport = bridgeSportFromEsporte(bet.esporte);
  if (!teams || !bridgeSport) {
    log.warn({ betId: bet.id }, "aposta MATCHED sem evento/esporte utilizável — pulando");
    return { closed: false };
  }

  const aliased = await applyTeamAliases(teams, bet.esporte, bet.pais, bet.competicao);
  // Aposta da Pinnacle17 não chega aqui: fecha pela série (`shouldUseBridgeClosing`),
  // e a repescagem a acha na Bridge pelo mesmo id de evento (`bridge-rematch.ts`).
  const providerMatchId = bet.sharp?.provider === "bridgeodds"
    ? bet.sharp.providerMatchId
    : null;
  if (bet.closing?.fetchedAt) return { closed: false };
  const found = await findClosingBridgeMatch(bet, providerMatchId, bridgeSport, aliased, deps, now);
  if (!found) return { closed: false };
  const { match, priceObservedAt } = found;

  await syncCanonicalLeague(bet, match);
  const closed = await processBridgeClv(bet, match, now, { priceObservedAt });
  return { closed };
}

/**
 * País e competição canônicos da Pinnacle, quando a aposta ainda guarda os
 * locais. A aposta editada no meio da consulta pode ser de outro jogo e fica
 * como o dono a deixou.
 */
async function syncCanonicalLeague(bet: ClosingSyncBet, match: BridgeMatch): Promise<void> {
  const parsedLeague = parseBridgeLeague(match.league ?? "");
  const canonicalPais = canonicalCountry(parsedLeague.pais);
  const canonicalComp = canonicalCompetition(parsedLeague.competicao);
  if ((canonicalPais && canonicalPais !== bet.pais) || (canonicalComp && canonicalComp !== bet.competicao)) {
    const updated = await prisma.bet.updateMany({
      where: sameBetAsRead(bet),
      data: {
        ...(canonicalPais ? { pais: canonicalPais } : {}),
        ...(canonicalComp ? { competicao: canonicalComp } : {}),
      },
    });
    if (updated.count === 0) return;
    if (canonicalPais) bet.pais = canonicalPais;
    if (canonicalComp) bet.competicao = canonicalComp;
  }
}

/**
 * A partida da aposta na Bridge com preço observado depois do kickoff: pelo id
 * quando a aposta já foi casada ali, senão pela busca (exigindo o mesmo id, ou
 * o melhor candidato acima do limiar AUTO quando não há id). Null adia para o
 * próximo ciclo.
 */
async function findClosingBridgeMatch(
  bet: ClosingSyncBet,
  providerMatchId: string | null,
  bridgeSport: NonNullable<ReturnType<typeof bridgeSportFromEsporte>>,
  aliased: { home: string; away: string },
  deps: ClosingDeps,
  now: Date,
): Promise<{ match: BridgeMatch; priceObservedAt: Date } | null> {
  let match: BridgeMatch | null = null;
  let priceObservedAt = now;
  let byIdFailed = false;
  const deadlineMs = Date.now() + CLOSING_BRIDGE_LOOKUP_MS;
  if (providerMatchId) {
    const observed = await findBridgeMatchByIdWithEvidence({
      providerMatchId,
      searchWord: bestSearchWord(aliased.home),
      bridgeSport,
      kickoffUtc: bet.data,
      ...(deps.query ? { query: deps.query } : {}),
      mode: "full",
      purpose: "closing",
      now,
      deadlineMs,
    });
    match = observed?.match ?? null;
    if (observed) priceObservedAt = observed.observedAt;
    if (!match) byIdFailed = true;
  }

  if (!match && Date.now() >= deadlineMs) {
    log.info({ betId: bet.id, providerMatchId }, "closing: prazo da busca na Bridge acabou — aposta fica para o próximo ciclo");
    return null;
  }
  if (!match) {
    const found = await findBridgeMatch({
      home: aliased.home,
      away: aliased.away,
      bridgeSport,
      kickoffUtc: bet.data,
      competition: bet.competicao,
      ...(deps.query ? { query: deps.query } : {}),
    });
    const exact = found.candidates.find(
      (candidate) => providerMatchId && String(candidate.match.match_id) === providerMatchId,
    );
    if (exact) {
      match = exact.match;
    } else if (found.ok && !providerMatchId) {
      const minScore = getEnv().SHARP_AUTO_MATCH_MIN_SCORE;
      if (found.best.score < minScore) {
        log.warn(
          { betId: bet.id, score: found.best.score, minScore, ...(byIdFailed ? { providerMatchId } : {}) },
          byIdFailed
            ? "closing: matchId Bridge falhou e best abaixo do limiar AUTO — skip"
            : "closing: best abaixo do limiar AUTO — skip",
        );
        return null;
      }
      match = found.best.match;
    }
    if (!match) {
      log.warn(
        { betId: bet.id, reason: found.ok ? "sem_candidato" : found.reason },
        "closing sem match neste ciclo",
      );
      return null;
    }
    if (exact && !found.ok) {
      log.warn(
        { betId: bet.id, providerMatchId },
        "closing achou o ID só em resultado sem evidência de frescor — adiando",
      );
      return null;
    }
    if (found.ok) {
      const fetchedBeforeKickoff = found.priceObservedAt.getTime() < bet.data.getTime();
      if (found.stalePrices || fetchedBeforeKickoff) {
        const refreshed = await findBridgeMatchByIdWithEvidence({
          providerMatchId: String(match.match_id),
          searchWord: bestSearchWord(match.home),
          bridgeSport,
          kickoffUtc: bet.data,
          ...(deps.query ? { query: deps.query } : {}),
          mode: "cheap",
          purpose: "closing",
          now,
          deadlineMs,
        });
        if (!refreshed) {
          log.warn({ betId: bet.id, providerMatchId: match.match_id },
            "closing sem preço final fresco; revalidação por ID falhou");
          return null;
        }
        match = refreshed.match;
        priceObservedAt = refreshed.observedAt;
      } else {
        priceObservedAt = found.priceObservedAt;
        if (!deps.query) {
          await writeBridgeMatchSnapshot({
            match,
            purpose: "closing",
            observedAt: priceObservedAt,
          });
        }
      }
    }
  }
  return { match, priceObservedAt };
}
