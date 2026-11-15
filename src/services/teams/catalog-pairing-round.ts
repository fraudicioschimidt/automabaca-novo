import { OperationalRisk } from "@/src/generated/prisma/client";
import { spDayKey } from "@/src/domain/dates";
import { isBreakerOpen } from "@/src/infra/circuit-breaker";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { pgPool, prisma } from "@/src/infra/prisma";
import { findProviderCap, periodKeyFor } from "@/src/providers/budget-config";
import { getFlashscoreCatalog } from "@/src/providers/flashscore/catalog";
import { flashscoreConfigured } from "@/src/providers/flashscore/client";
import type { FlashscoreCatalogMatch } from "@/src/providers/flashscore/types";
import { fetchPinnacle17Events, pinnacle17Enabled } from "@/src/providers/pinnacle17/client";
import type { Pinnacle17Event } from "@/src/providers/pinnacle17/types";
import { raiseOperationalAlertOnce } from "@/src/services/ops/alerts";
import { saveCatalogRound, type CardNameDivergence } from "@/src/services/teams/catalog-links";
import { learnWaitingTipsterNames } from "@/src/services/teams/tipster-names";
import {
  CATALOG_PAIRING_METRIC,
  catalogPairingSports,
  flashscoreDaysFor,
  flashscoreDaysOf,
  pairablePinnacleEvents,
  pairCatalogEvent,
  pairingWindow,
  pinnacleDaysOf,
  type CatalogPair,
  type CatalogSport,
  type CatalogWindow,
} from "@/src/services/teams/catalog-pairing";

/**
 * `teams.catalog_pairing`: quatro rodadas por dia ligam os jogos da Pinnacle17
 * aos do FlashScore e gravam as fichas dos times. Cada rodada olha de agora até
 * o fim do dia de São Paulo ou 12 h à frente, o que for mais longe
 * (`pairingWindow`): a das 20:37 cobre a madrugada, que nenhuma outra veria
 * antes do jogo.
 *
 * Trabalho de baixa prioridade: chamadas em série, o circuito de cada
 * fornecedor conferido antes de cada uma, a rodada para na primeira falha e
 * não começa com o gasto do dia acima de 60% do teto. Falha de fornecedor não
 * derruba o job (a rodada seguinte refaz o dia); falha do banco derruba.
 */

const log = createLogger("catalog-pairing");

const LOCK_KEY = "teams.catalog_pairing";
const BUDGET_SHARE_LIMIT = 0.6;
const RECENT_BET_DAYS = 30;
const DAY_MS = 86_400_000;
const ALERT_SOURCE = "teams.catalog_pairing";

type Provider = "pinnacle17" | "flashscore";
type StopReason = "breaker" | "budget" | "failure";

export type CatalogPairingRound = {
  /** Dia de São Paulo da rodada. */
  day: string;
  /** Fim da janela da rodada (ISO). */
  until: string;
  stoppedBy: StopReason | "locked" | "disabled" | null;
  stoppedAt: Provider | null;
  sports: number;
  /** Eventos da Pinnacle17 tentados: do dia, não começados, em tempo normal. */
  pinnacleEvents: number;
  paired: number;
  base: number;
  noCandidate: number;
  weak: number;
  ambiguous: number;
  country: number;
  /** Eventos sem o catálogo do FlashScore de algum dia da janela deles (catálogo vazio). */
  withoutCatalog: number;
  conflicts: number;
  moved: number;
  newCards: number;
  /** Apostas cujo nome de tipster esperava a ligação do jogo e aprenderam nesta rodada. */
  delayedTipsterNames: number;
  nameDivergences: number;
  sportsSkippedBreaker: number;
  sportsSkippedBudget: number;
  emptyCatalogs: number;
};

type Deps = {
  now: () => Date;
  providersEnabled: () => boolean;
  fetchEvents: (params: { sportId: number; kickoffUtc: Date }) => Promise<{ data: Pinnacle17Event[] } | null>;
  fetchCatalog: (dayKey: string, sportId: number) => Promise<FlashscoreCatalogMatch[] | null>;
};

const defaultDeps: Deps = {
  now: () => new Date(),
  providersEnabled: () => pinnacle17Enabled() && flashscoreConfigured(),
  fetchEvents: fetchPinnacle17Events,
  fetchCatalog: getFlashscoreCatalog,
};

export async function runCatalogPairingRound(overrides: Partial<Deps> = {}): Promise<CatalogPairingRound> {
  const deps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const horizon = pairingWindow(now);
  const round = emptyRound(spDayKey(now), horizon.end.toISOString());
  if (!deps.providersEnabled()) return { ...round, stoppedBy: "disabled" };

  const locked = await withRoundLock(async () => {
    const sports = catalogPairingSports(await readRecentBetSports(now));
    round.sports = sports.length;
    const divergences: CardNameDivergence[] = [];
    for (const [index, sport] of sports.entries()) {
      const stop = await pairSport(sport, horizon, now, deps, round, divergences);
      if (!stop) continue;
      round.stoppedBy = stop.reason;
      round.stoppedAt = stop.provider;
      const skipped = sports.length - index;
      if (stop.reason === "breaker") round.sportsSkippedBreaker = skipped;
      if (stop.reason === "budget") round.sportsSkippedBudget = skipped;
      log.warn({ eventCode: LOG_EVENTS.ACTION_DEFERRED, ...round, sport: sport.sport },
        "pareamento dos catálogos parou; a rodada seguinte refaz o dia");
      break;
    }
    round.nameDivergences = divergences.length;
    for (const divergence of divergences) {
      // A evidência já foi gravada e a rodada repetida não a veria de novo: o
      // aviso que falha fica no log, sem derrubar o job.
      await alertNameDivergence(divergence).catch((err: unknown) => {
        log.error({ err, ...divergence }, "aviso de nome novo na ficha não enviado");
      });
    }
  });
  if (locked === "busy") round.stoppedBy = "locked";
  // Rodada que parou (fornecedor, circuito, orçamento, trava) é espera, não
  // erro: a seguinte refaz. Só a rodada inteira é sucesso.
  await recordOperationalMetric({
    kind: "action",
    name: CATALOG_PAIRING_METRIC,
    outcome: round.stoppedBy ? "expected_retry" : "success",
    labels: { ...round },
  });
  return round;
}

function emptyRound(day: string, until: string): CatalogPairingRound {
  return {
    day, until, stoppedBy: null, stoppedAt: null, sports: 0, pinnacleEvents: 0, paired: 0, base: 0, noCandidate: 0,
    weak: 0, ambiguous: 0, country: 0, withoutCatalog: 0, conflicts: 0, moved: 0, newCards: 0, delayedTipsterNames: 0, nameDivergences: 0,
    sportsSkippedBreaker: 0, sportsSkippedBudget: 0, emptyCatalogs: 0,
  };
}

/**
 * Uma rodada por vez, também fora da fila (disparo manual, dois workers numa
 * troca): trava de sessão numa conexão só dela, solta no fim. Se soltar falhar,
 * a conexão é descartada, e a trava cai com ela.
 */
async function withRoundLock(run: () => Promise<void>): Promise<"done" | "busy"> {
  const client = await pgPool.connect();
  let unlockError: Error | undefined;
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [LOCK_KEY]);
    if (!rows[0]?.acquired) return "busy";
    try {
      await run();
      return "done";
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_KEY])
        .catch((err: unknown) => { unlockError = err instanceof Error ? err : new Error(String(err)); });
    }
  } finally {
    client.release(unlockError);
  }
}

async function readRecentBetSports(now: Date): Promise<string[]> {
  const rows = await prisma.bet.findMany({
    where: { deletedAt: null, data: { gte: new Date(now.getTime() - RECENT_BET_DAYS * DAY_MS) } },
    distinct: ["esporte"],
    select: { esporte: true },
  });
  return rows.map((row) => row.esporte);
}

/** Circuito aberto ou gasto do dia acima de 60% do teto: a chamada nem sai. */
async function providerGate(provider: Provider, now: Date): Promise<"breaker" | "budget" | null> {
  if (await isBreakerOpen(provider)) return "breaker";
  return (await budgetShare(provider, now)) > BUDGET_SHARE_LIMIT ? "budget" : null;
}

/**
 * Parte do teto do período já comprometida (gasto mais reservas), como o
 * alerta de cota lê `provider_budgets`. Janela do fornecedor já virada conta
 * como gasto zerado, que é o que a próxima cobrança faria.
 */
async function budgetShare(provider: Provider, now: Date): Promise<number> {
  const cap = findProviderCap(provider);
  if (!cap || !Number.isFinite(cap.cap) || cap.cap <= 0) return 0;
  const row = await prisma.providerBudget.findUnique({
    where: { provider_periodKey: { provider, periodKey: periodKeyFor(cap.period, now) } },
    select: { spent: true, reserved: true, windowResetAt: true },
  });
  if (!row) return 0;
  const spent = row.windowResetAt && row.windowResetAt <= now ? 0 : row.spent;
  return (spent + row.reserved) / cap.cap;
}

type Stop = { reason: StopReason; provider: Provider };

/**
 * Um esporte: os eventos da Pinnacle17 dos dias UTC que a janela toca, os
 * catálogos do FlashScore dos dias de São Paulo que os eventos tocam (±15 min),
 * o par de cada evento e a gravação. Nada é gravado do esporte em que a rodada
 * parou.
 */
async function pairSport(
  sport: CatalogSport,
  horizon: CatalogWindow,
  now: Date,
  deps: Deps,
  round: CatalogPairingRound,
  divergences: CardNameDivergence[],
): Promise<Stop | null> {
  const listed: Pinnacle17Event[] = [];
  for (const kickoffUtc of pinnacleDaysOf(horizon)) {
    const gate = await providerGate("pinnacle17", now);
    if (gate) return { reason: gate, provider: "pinnacle17" };
    const feed = await deps.fetchEvents({ sportId: sport.pinnacleSportId, kickoffUtc });
    if (!feed) return { reason: "failure", provider: "pinnacle17" };
    listed.push(...feed.data);
  }
  const events = pairablePinnacleEvents(listed, horizon);

  const catalogs = new Map<string, FlashscoreCatalogMatch[]>();
  for (const dayKey of flashscoreDaysFor(events)) {
    const gate = await providerGate("flashscore", now);
    if (gate) return { reason: gate, provider: "flashscore" };
    let matches: FlashscoreCatalogMatch[] | null;
    try {
      matches = await deps.fetchCatalog(dayKey, sport.flashscoreSportId);
    } catch (err) {
      log.warn({ err, sport: sport.sport, dayKey }, "catálogo do FlashScore falhou no pareamento");
      return { reason: "failure", provider: "flashscore" };
    }
    if (!matches) return { reason: "failure", provider: "flashscore" };
    // Catálogo vazio não prova que o dia não tem jogo: os eventos que dependem dele ficam de fora.
    if (matches.length === 0) round.emptyCatalogs += 1;
    else catalogs.set(dayKey, matches);
  }

  const pairs: CatalogPair[] = [];
  round.pinnacleEvents += events.length;
  for (const event of events) {
    const days = flashscoreDaysOf(event);
    if (!days.every((key) => catalogs.has(key))) {
      round.withoutCatalog += 1;
      continue;
    }
    const decision = pairCatalogEvent(event, days.flatMap((key) => catalogs.get(key) ?? []));
    if (decision.outcome === "paired") pairs.push(decision.pair);
    round[OUTCOME_COUNTER[decision.outcome]] += 1;
  }

  const flashscoreKickoffs = new Map([...catalogs.values()].flat().map((match) => [match.match_id, new Date(match.timestamp * 1_000)]));
  const seen = listed
    .filter((event) => Date.parse(event.startTime) >= horizon.start.getTime() && Date.parse(event.startTime) < horizon.end.getTime())
    .map((event) => ({ pinnacleEventId: String(event.id), kickoffPinnacle: new Date(event.startTime) }));
  const write = await saveCatalogRound({ sport: sport.sport, pairs, seen, flashscoreKickoffs, now });
  round.conflicts += write.conflicts;
  round.moved += write.moved;
  round.newCards += write.newCards;
  round.delayedTipsterNames += await learnWaitingTipsterNames(pairs.map((pair) => String(pair.event.id)));
  divergences.push(...write.divergences);
  return null;
}

const OUTCOME_COUNTER = {
  paired: "paired",
  base: "base",
  no_candidate: "noCandidate",
  weak: "weak",
  ambiguous: "ambiguous",
  country: "country",
} as const satisfies Record<ReturnType<typeof pairCatalogEvent>["outcome"], keyof CatalogPairingRound>;

/** Só avisa: o nome novo fica gravado na ficha. */
async function alertNameDivergence(divergence: CardNameDivergence): Promise<void> {
  const previous = divergence.previousNames.map((name) => `"${name}"`).join(", ");
  await raiseOperationalAlertOnce(
    `🔗 Ficha de time com nome novo da Pinnacle\n` +
      `${divergence.flashscoreName} (${divergence.sport}, id FlashScore ${divergence.flashscoreTeamId}) ` +
      `apareceu na Pinnacle como "${divergence.pinnacleName}", que não se parece com ${previous}.\n` +
      "O nome novo já está na ficha, e a tradução do nome das apostas usa o nome da Pinnacle mais recente dela.\n" +
      "👉 Confira se a Pinnacle renomeou o time ou se o jogo foi ligado ao do FlashScore errado.",
    {
      source: ALERT_SOURCE,
      key: `name:${divergence.sport}:${divergence.flashscoreTeamId}`,
      title: `Ficha ${divergence.flashscoreName}: nome novo na Pinnacle`,
      risk: OperationalRisk.LOW,
      resource: "team_card",
      resourceId: divergence.cardId,
      evidence: {
        pinnacleName: divergence.pinnacleName,
        previousNames: divergence.previousNames,
        pinnacleEventId: divergence.pinnacleEventId,
        flashscoreTeamId: divergence.flashscoreTeamId,
      },
    },
  );
}
