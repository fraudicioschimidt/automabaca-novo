import type { NoOddsReason } from "@/src/domain/no-odds-reason";
import { entrouAoVivo } from "@/src/domain/entrada-ao-vivo";
import { sameKickoff } from "@/src/domain/kickoff-infer";
import { BudgetExhaustedError } from "@/src/domain/provider-error";
import type { SharpPhaseOdds } from "@/src/domain/sharp-price";
import { matchTeamsWithCategoryContext } from "@/src/domain/text";
import { rewriteSelecaoWithMatchedTeams } from "@/src/domain/national-teams";
import { marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { pinnacleizeSelecao } from "@/src/domain/mercados/selecao";
import { chargeProviderRequest } from "@/src/providers/budget";
import {
  consumeProviderBudgetReservation,
  releaseProviderBudgetReservation,
  reserveProviderBudget,
} from "@/src/providers/budget-reservations";
import {
  fetchPinnacle17EventsOutcome,
  fetchPinnacle17OddsOutcome,
  pinnacle17Enabled,
} from "./client";
import { findPinnacle17Event, rankPinnacle17Candidates, type Pinnacle17Match } from "./feed";
import { PINNACLE17_TRANSIENT_RETRIES } from "./limits";
import { resolvePinnacle17CurrentOdds } from "./odds";
import {
  encodePinnacle17PriceReference,
  pinnacle17SportId,
  type Pinnacle17Event,
  type Pinnacle17PriceReference,
} from "./types";

/**
 * Pinnacle17 como fonte sharp de uma aposta: identidade do evento, preço
 * atual e a reserva de cota que garante a consulta do fechamento.
 */

const PINNACLE17_CLOSING_PURPOSE = "closing";

export async function reservePinnacle17Closing(
  resourceKey: string,
): Promise<{ ok: boolean; created: boolean }> {
  return reserveProviderBudget({
    provider: "pinnacle17",
    purpose: PINNACLE17_CLOSING_PURPOSE,
    resourceKey,
  });
}

export function pinnacle17ClosingReservedAttempt(resourceKey: string): () => Promise<void> {
  let attempts = 0;
  return async () => {
    if (attempts > PINNACLE17_TRANSIENT_RETRIES) throw new Error("Pinnacle17 esgotou as tentativas de closing");
    if (attempts++ > 0) {
      // A reserva da primeira chamada já foi consumida. Retry precisa de cota
      // nova, sem gastar as reservas de fechamento das outras apostas.
      await chargeProviderRequest("pinnacle17", "closing-retry");
      return;
    }
    const consumed = await consumeProviderBudgetReservation({
      provider: "pinnacle17",
      purpose: PINNACLE17_CLOSING_PURPOSE,
      resourceKey,
    });
    if (!consumed) throw new BudgetExhaustedError("pinnacle17", "closing");
  };
}

export async function releasePinnacle17ClosingReservation(resourceKey: string): Promise<void> {
  await releaseProviderBudgetReservation({
    provider: "pinnacle17",
    purpose: PINNACLE17_CLOSING_PURPOSE,
    resourceKey,
  });
}

const SIDE_LABEL = /^(home|casa|mandante|away|fora|visitante|(?:time|team|equipe)\s*[12])(?=\s|[+−-]|$)/i;
const HOME_LABEL = /^(?:home|casa|mandante|.*1)$/i;

/** Resolve home/away against the original event before applying orientation. */
export function orientPinnacle17Selection(params: {
  mercado: string; selecao: string; home: string; away: string;
  providerHome: string; providerAway: string; swapped: boolean;
}): string {
  let selection = params.selecao;
  const kind = marketKindOf(params.mercado, selection);
  if (["moneyline", "draw_no_bet", "double_chance"].includes(kind) && marketPeriodOf(selection) === "FT") {
    selection = pinnacleizeSelecao({ selecao: selection, mercadoPinnacle: params.mercado,
      evento: `${params.home} vs ${params.away}` });
  } else if (["spread", "team_total", "moneyline"].includes(kind)) {
    selection = selection.replace(kind === "moneyline" && /^\s*[12]\s*$/.test(selection) ? /[12]/ : SIDE_LABEL,
      token => HOME_LABEL.test(token) ? params.home : params.away);
  }
  return rewriteSelecaoWithMatchedTeams({ selecao: selection,
    localHome: params.swapped ? params.away : params.home,
    localAway: params.swapped ? params.home : params.away,
    pinnacleHome: params.providerHome, pinnacleAway: params.providerAway });
}

const ORDER_FREE_KINDS = ["moneyline", "draw_no_bet", "double_chance", "spread", "total", "team_total", "btts"];
const POSITIONAL_SELECTION = new RegExp([
  "\\b(?:home|casa|mandante|away|fora|visitante)\\b",
  "\\b(?:time|team|equipe)\\s*[12]\\b",
  "\\d\\s*[-–:x×]\\s*\\d",
  "^\\s*[12x](?:\\s*[/-]\\s*[12x])?\\s*$",
].join("|"), "i");

/**
 * A seleção (já orientada) ainda fala pela posição dos times no evento: placar
 * exato, intervalo/final "1/2", "Time 1" num mercado que a orientação não
 * reescreve. Com o mando trocado, o evento dessa aposta fica na ordem do post
 * (`identityEventName`), ou a seleção passaria a apontar o outro time. Não vale
 * para os mercados com preço na Pinnacle, lidos pelo mandante dela.
 */
export function selectionFollowsEventOrder(mercado: string, selecao: string): boolean {
  const kind = marketKindOf(mercado, selecao);
  if (ORDER_FREE_KINDS.includes(kind)) return false;
  return kind === "correct_score" || POSITIONAL_SELECTION.test(selecao);
}

type Pinnacle17SharpResult = {
  matched: boolean;
  match: Pinnacle17Match | null;
  mainEvent: Pinnacle17Event | null;
  score: number;
  swapped: boolean;
  current: SharpPhaseOdds | null;
  currentObservedAt: Date | null;
  priceReference: Pinnacle17PriceReference | null;
  closingReservationCreated: boolean;
  unresolvedReason: NoOddsReason | null;
};

const NO_MATCH: Pinnacle17SharpResult = {
  matched: false,
  match: null,
  mainEvent: null,
  score: 0,
  swapped: false,
  current: null,
  currentObservedAt: null,
  priceReference: null,
  closingReservationCreated: false,
  unresolvedReason: null,
};

export async function releasePinnacle17ClosingIfCreated(
  reference: Pinnacle17PriceReference | null,
  created: boolean,
): Promise<void> {
  if (reference && created) {
    await releasePinnacle17ClosingReservation(encodePinnacle17PriceReference(reference));
  }
}

type Pinnacle17BetParams = {
  home: string;
  away: string;
  esporte: string;
  mercado: string;
  selecao: string;
  kickoffUtc: Date;
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  competicao?: string;
  pais?: string;
  needOdds?: boolean;
  matchId?: number;
  /**
   * Id de evento já conhecido por outra fonte do mesmo feed (a BridgeOdds usa
   * o id da Pinnacle17): só esse evento serve, e só no mesmo kickoff.
   */
  pinnedEventId?: number;
  judgeCandidates?: (candidates: Array<{ event: Pinnacle17Event; score: number; swapped: boolean }>) => Promise<number | null>;
};

/**
 * Identidade em três degraus: candidato claro do catálogo, o `matchId` já
 * conhecido (se os times forem compatíveis) e, por último, o juiz sobre a
 * zona cinzenta.
 */
async function findMatch(params: Pinnacle17BetParams, events: Pinnacle17Event[]): Promise<Pinnacle17Match | null> {
  if (params.pinnedEventId !== undefined) {
    const pinned = events.find((e) => e.id === params.pinnedEventId);
    if (!pinned || !sameKickoff(new Date(pinned.startTime), params.kickoffUtc)) return null;
    const teams = matchTeamsWithCategoryContext({
      betHome: params.home,
      betAway: params.away,
      fixtureHome: pinned.homeTeam.name,
      fixtureAway: pinned.awayTeam.name,
      betLeague: params.competicao,
      fixtureLeague: pinned.league.name,
    });
    return teams.compatible ? { event: pinned, score: 2.0, swapped: teams.swapped } : null;
  }
  const query = {
    events,
    home: params.home,
    away: params.away,
    kickoffUtc: params.kickoffUtc,
    competition: params.competicao,
    country: params.pais,
  };
  const found = findPinnacle17Event(query);
  if (found) return found;
  const directEvent = params.matchId ? events.find((e) => e.id === params.matchId) : undefined;
  if (directEvent) {
    const matchResult = matchTeamsWithCategoryContext({
      betHome: params.home,
      betAway: params.away,
      fixtureHome: directEvent.homeTeam.name,
      fixtureAway: directEvent.awayTeam.name,
      betLeague: params.competicao,
      fixtureLeague: directEvent.league.name,
    });
    if (matchResult.compatible) return { event: directEvent, score: 2.0, swapped: matchResult.swapped };
  }
  if (!params.judgeCandidates) return null;
  const grayCandidates = rankPinnacle17Candidates({ ...query, minScore: 1.0 });
  if (grayCandidates.length === 0) return null;
  const selectedIndex = await params.judgeCandidates(grayCandidates);
  const chosen = selectedIndex === null ? undefined : grayCandidates[selectedIndex];
  return chosen ? { event: chosen.event, score: chosen.score, swapped: chosen.swapped } : null;
}

export async function resolvePinnacle17SharpForBet(params: Pinnacle17BetParams): Promise<Pinnacle17SharpResult> {
  if (!pinnacle17Enabled()) return NO_MATCH;
  if (entrouAoVivo({ registradoEm: params.registradoEm,
      sourcePostedAt: params.sourcePostedAt, kickoff: params.kickoffUtc })) return NO_MATCH;
  const sportId = pinnacle17SportId(params.esporte);
  if (sportId === null) return NO_MATCH;
  const catalog = await fetchPinnacle17EventsOutcome({ sportId, kickoffUtc: params.kickoffUtc });
  // A lista que não veio não é "a Pinnacle não tem o jogo": sai com o motivo.
  if (catalog.kind === "failed") {
    return { ...NO_MATCH, unresolvedReason: catalog.budget ? "cota_pinnacle_esgotada" : "consulta_pinnacle_falhou" };
  }
  if (catalog.kind !== "observed") return NO_MATCH;
  const match = await findMatch(params, catalog.observed.data);
  if (!match) return NO_MATCH;
  const matched: Pinnacle17SharpResult = {
    ...NO_MATCH,
    matched: true,
    match,
    mainEvent: match.event,
    score: match.score,
    swapped: match.swapped,
  };
  if (params.needOdds === false) return matched;
  const selecao = orientPinnacle17Selection({
    ...params,
    swapped: match.swapped,
    providerHome: match.event.homeTeam.name,
    providerAway: match.event.awayTeam.name,
  });
  const outcome = await fetchPinnacle17OddsOutcome(match.event.id, undefined, match.event);
  if (outcome.kind === "failed") {
    return { ...matched, unresolvedReason: outcome.budget ? "cota_pinnacle_esgotada" : "consulta_pinnacle_falhou" };
  }
  const observed = outcome.kind === "observed" ? outcome.observed : null;
  const resolved = observed ? resolvePinnacle17CurrentOdds({
    event: match.event,
    markets: observed.data,
    esporte: params.esporte,
    mercado: params.mercado,
    selecao,
    observedAt: observed.observedAt,
  }) : null;
  if (!resolved?.ok) {
    return {
      ...matched,
      unresolvedReason: resolved?.reason === "stale_price" ? "no_prices" : (resolved?.reason ?? "no_prices"),
    };
  }
  const reservation = await reservePinnacle17Closing(
    encodePinnacle17PriceReference(resolved.value.reference),
  );
  if (!reservation.ok) {
    return { ...matched, priceReference: resolved.value.reference, unresolvedReason: "cota_pinnacle_esgotada" };
  }
  return {
    ...matched,
    current: resolved.value.current,
    currentObservedAt: observed?.observedAt ?? null,
    priceReference: resolved.value.reference,
    closingReservationCreated: reservation.created,
  };
}
