import { isMultiFixtureTicket, parseBetLegs, parseStoredLegs } from "@/src/domain/bet-legs";
import { PAST_EVENT_TERMINAL_DELAY_MS, PROVISIONAL_KICKOFF_DAY_MS } from "@/src/domain/enrich-cadence";
import { isPermanentNoOddsReason } from "@/src/domain/no-odds-reason";
import { ProviderRequestGateError } from "@/src/domain/provider-error";
import { splitEventoTeams } from "@/src/domain/text";
import { createLogger } from "@/src/infra/logger";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { prisma } from "@/src/infra/prisma";
import { getSharedBoss } from "@/src/infra/boss";
import { ensureClosingWatch } from "@/src/services/sharp/closing/series";
import { applyBridgeIdentity, bridgeMatchGameStart } from "./apply-identity";
import { applyBridgeOdds, retryClosingReference } from "./apply-odds";
import {
  resolveSharpIdentity,
  type BridgeIdentityResolved,
  type SharpIdentityOutcome,
} from "./sharp-identity";
import { SharpContinuationError, type EnrichDeps } from "./continuation";
import { resolveProvisionalKickoff } from "./kickoff-provisional";
import { linkEarlyFlashscoreMatch } from "./resolve-kickoff-flashscore";
import {
  historicalIdentityUpsert,
  isHistoricalIdentityRecovery,
  terminalizeUnmatched,
} from "./historical-identity";
import { closeOpenTrainingCase } from "./training-cases";
import { upsertSharp, type UpsertSharpFn } from "./upsert-sharp";
import { withEnrichWriteScope, expectEnrichTerms } from "./write-guard";

const log = createLogger("sharp-enrich");

function isNumericProviderMatchId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^\d+$/.test(id);
}

/**
 * Com a identidade confirmada, a agenda do fechamento nasce aqui: a série
 * consulta a Pinnacle17 nos minutos finais (`closing/series.ts`). A varredura
 * de minuto a recria se esta falhar.
 */
async function maybeEnsureClosingWatch(
  bet: { id: string; data: Date; kickoffInferido: boolean; liveScoreHome?: string | null; liveScoreAway?: string | null; bankroll: { sharpMode: string } },
  deps: EnrichDeps,
): Promise<void> {
  const now = deps.now ?? new Date();
  if (bet.data.getTime() <= now.getTime()) return;
  if (bet.liveScoreHome != null || bet.liveScoreAway != null) return;
  if (bet.bankroll.sharpMode !== "CLV_ONLY" || bet.kickoffInferido) return;
  try {
    const boss = deps.boss ?? (await getSharedBoss().catch(() => null));
    if (boss) await ensureClosingWatch(bet.id, boss, now);
  } catch (err) {
    log.warn({ err, betId: bet.id }, "falha ao agendar a série de fechamento");
  }
}

type EnrichSkipReason =
  | "deleted"
  | "bankroll_off"
  | "settled"
  | "terminal_identity"
  | "already_enriched";

/**
 * Decide, antes de consultar calendário e providers, se o job não tem o que
 * fazer. Identidade terminal ainda roda com kickoff provisório: o calendário
 * pode corrigir o horário e reabri-la.
 */
export function classifyEnrichSkip(bet: {
  deletedAt: Date | null;
  status: string;
  kickoffInferido: boolean;
  bankroll: { sharpMode: string };
  sharp: { identityStatus: string; noOddsReason: string | null } | null;
  /** Recupera somente a identidade de aposta liquidada recente. */
  allowSettledIdentityRecovery?: boolean;
}): EnrichSkipReason | null {
  if (bet.deletedAt) return "deleted";
  if (bet.bankroll.sharpMode === "OFF") return "bankroll_off";
  if (bet.status !== "PENDING" && !bet.allowSettledIdentityRecovery) return "settled";
  if (bet.sharp?.noOddsReason === "multipla") return "already_enriched";
  const id = bet.sharp?.identityStatus;
  if ((id === "UNMATCHED" || id === "UNSUPPORTED") && !bet.kickoffInferido) return "terminal_identity";
  if ((id === "MATCHED" || id === "MANUAL") && isPermanentNoOddsReason(bet.sharp?.noOddsReason)) {
    return "already_enriched";
  }
  return null;
}

async function observeEnrichStage<T>(
  stage: "kickoff" | "identity" | "identity_kickoff" | "persist_identity" | "price",
  run: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let outcome: "success" | "error" | "expected_retry" = "success";
  try { return await run(); } catch (error) {
    outcome = error instanceof ProviderRequestGateError || error instanceof SharpContinuationError ? "expected_retry" : "error";
    throw error;
  } finally {
    await recordOperationalMetric({ kind: "action", name: `sharp.stage.${stage}`, outcome, durationMs: Date.now() - start });
  }
}

export class PrePinnacleRetryError extends Error {
  constructor(reason: string) {
    super(`Match não encontrado nos providers (${reason}) — aguardando Pinnacle listar.`);
    this.name = "PrePinnacleRetryError";
  }
}

/**
 * Enriquecimento sharp de UMA aposta (job `sharp.enrich`): kickoff, identidade
 * e referência de fechamento. A identidade tenta a Pinnacle17 primeiro e a
 * BridgeOdds quando a Pinnacle17 não acha o jogo (`sharp-identity.ts`;
 * cobertura em `providers/coverage.ts`). As saídas antecipadas evitam que job
 * atrasado gaste cota.
 */
export async function enrichBetSharp(
  params: { betId: string },
  deps: EnrichDeps = {},
): Promise<void> {
  return withEnrichWriteScope(() => enrichBetSharpCurrent(params, deps));
}

type EnrichBet = NonNullable<Awaited<ReturnType<typeof loadEnrichBet>>>;

const sharpSelect = { identityStatus: true, provider: true, noOddsReason: true, providerMatchId: true, confidence: true } as const;

function loadEnrichBet(betId: string) {
  return prisma.bet.findUnique({
    where: { id: betId },
    select: {
      id: true, deletedAt: true, status: true, evento: true, esporte: true,
      sportResolutionStatus: true, sportSource: true, competicao: true, pais: true, mercado: true,
      selecao: true, legsJson: true, odds: true, data: true, kickoffInferido: true,
      registradoEm: true, sourcePostedAt: true,
      sharp: { select: sharpSelect },
      bankroll: { select: { sharpMode: true } },
    },
  });
}

async function enrichBetSharpCurrent(
  params: { betId: string },
  deps: EnrichDeps,
): Promise<void> {
  const bet = await loadEnrichBet(params.betId);
  if (!bet) return;
  // Antes até do `sport_pending`: job atrasado não muda aposta removida.
  if (bet.deletedAt) return;
  expectEnrichTerms(bet);
  if (bet.sportResolutionStatus !== "CONFIRMED") {
    await upsertSharp(bet.id, {
      identityStatus: "PENDING",
      confidence: 0,
      noOddsReason: "sport_pending",
    });
    log.info(
      { betId: bet.id, status: bet.sportResolutionStatus },
      "enrich bloqueado — esporte ainda não confirmado",
    );
    return;
  }

  const now = deps.now ?? new Date();
  let historicalIdentityRecovery = isHistoricalIdentityRecovery(bet, now);
  const skip = classifyEnrichSkip({
    ...bet,
    allowSettledIdentityRecovery: historicalIdentityRecovery,
  });
  if (skip) {
    log.info({ betId: bet.id, reason: skip }, "enrich early-exit — sem provider");
    return;
  }

  const wasProvisional = bet.kickoffInferido;
  await observeEnrichStage("kickoff", () => resolveProvisionalKickoff(bet, { ...deps, now }));
  expectEnrichTerms(bet);

  if (wasProvisional) {
    await reloadAfterKickoffCycle(bet);
    // O kickoff da captura é o horário do post, já passado. Se o calendário o
    // corrigiu para o futuro, a aposta segue o caminho comum, não a recuperação.
    historicalIdentityRecovery = isHistoricalIdentityRecovery(bet, now);
    const skipAfter = classifyEnrichSkip({
      deletedAt: null,
      status: bet.status,
      kickoffInferido: bet.kickoffInferido,
      bankroll: bet.bankroll,
      sharp: bet.sharp,
      allowSettledIdentityRecovery: historicalIdentityRecovery,
    });
    if (skipAfter === "terminal_identity" || skipAfter === "already_enriched") {
      log.info(
        { betId: bet.id, reason: skipAfter },
        "enrich early-exit pós-kickoff — sem provider",
      );
      return;
    }
  }

  const teams = await teamsToMatch(bet, now);
  if (!teams) return;

  await linkEarlyFlashscoreMatch(bet, deps);

  const recoveryUpsert = historicalIdentityRecovery
    ? historicalIdentityUpsert(bet.bankroll.sharpMode)
    : upsertSharp;
  const alreadyMatched =
    !historicalIdentityRecovery &&
    (bet.sharp?.identityStatus === "MATCHED" || bet.sharp?.identityStatus === "MANUAL") &&
    bet.sharp?.provider === "bridgeodds" &&
    isNumericProviderMatchId(bet.sharp.providerMatchId);
  // Já casada: não há preço de entrada a buscar, só a referência de fechamento
  // que ainda falte e o fechamento a agendar.
  if (alreadyMatched && bet.sharp && isNumericProviderMatchId(bet.sharp.providerMatchId)) {
    const sharp = { ...bet.sharp, providerMatchId: bet.sharp.providerMatchId };
    await observeEnrichStage("price", () => retryClosingReference({ ...bet, sharp }, now));
    await maybeEnsureClosingWatch(bet, deps);
    return;
  }

  const identity = await observeEnrichStage("identity", () => resolveSharpIdentity(
    { ...bet, identityOnly: historicalIdentityRecovery },
    teams,
    deps,
    recoveryUpsert,
  ));
  if (identity.status !== "bridge_resolved") {
    await finishWithoutBridgeMatch(bet, identity, now, deps);
    return;
  }
  await persistBridgeMatch(bet, teams, identity.result, { historicalIdentityRecovery, recoveryUpsert }, deps);
}

/** O ciclo de kickoff pode ter corrigido o horário e reaberto a identidade. */
async function reloadAfterKickoffCycle(bet: EnrichBet): Promise<void> {
  const [sharp, kick] = await Promise.all([
    prisma.betSharp.findUnique({ where: { betId: bet.id }, select: sharpSelect }),
    prisma.bet.findUnique({
      where: { id: bet.id },
      select: { kickoffInferido: true, data: true },
    }),
  ]);
  if (kick) {
    bet.data = kick.data;
    bet.kickoffInferido = kick.kickoffInferido;
  }
  bet.sharp = sharp;
}

function hasOpenIdentity(bet: EnrichBet): boolean {
  return bet.sharp?.identityStatus !== "MATCHED" && bet.sharp?.identityStatus !== "MANUAL";
}

/**
 * Os dois times a procurar nos providers, ou null quando a aposta se resolve
 * sem eles: múltipla, evento fora do formato "A vs B" ou horário provisório.
 */
async function teamsToMatch(bet: EnrichBet, now: Date): Promise<{ home: string; away: string } | null> {
  const ticket = parseStoredLegs(bet.legsJson) ?? parseBetLegs(bet.evento, bet.selecao);
  if (ticket && isMultiFixtureTicket(ticket)) {
    await upsertSharp(bet.id, {
      identityStatus: "UNSUPPORTED",
      confidence: 0,
      noOddsReason: "multipla",
    });
    log.info({ betId: bet.id, pernas: ticket.legs.length }, "múltipla — sem matching de um único jogo");
    return null;
  }

  const teams = splitEventoTeams(bet.evento);
  if (!teams) {
    await upsertSharp(bet.id, {
      identityStatus: "UNMATCHED",
      confidence: 0,
      noOddsReason: "evento_sem_formato",
    });
    log.warn({ betId: bet.id, evento: bet.evento }, "evento sem formato A vs B");
    return null;
  }

  // Sem hora real, meia-noite SP é apenas a âncora do dia. Não consulta
  // providers com esse horário falso e não encerra antes de o dia completar.
  if (bet.kickoffInferido && hasOpenIdentity(bet)) {
    const dayExpired = now.getTime() >= bet.data.getTime() + PROVISIONAL_KICKOFF_DAY_MS;
    if (dayExpired) {
      await terminalizeUnmatched(bet, "provisional_kickoff_day_expired");
      return null;
    }
    await upsertSharp(bet.id, { identityStatus: "PENDING", confidence: 0 });
    log.info(
      { betId: bet.id, anchor: bet.data },
      "kickoff ainda provisório — aguardando nova resolução no mesmo dia",
    );
    return null;
  }
  return teams;
}

async function finishWithoutBridgeMatch(
  bet: EnrichBet,
  identity: Exclude<SharpIdentityOutcome, { status: "bridge_resolved" }>,
  now: Date,
  deps: EnrichDeps,
): Promise<void> {
  if (identity.status === "unsupported") return;
  if (identity.status === "pinnacle17_resolved") {
    const updated = await prisma.bet.findUnique({
      where: { id: bet.id },
      select: { data: true, kickoffInferido: true },
    });
    if (updated) {
      bet.data = updated.data;
      bet.kickoffInferido = updated.kickoffInferido;
    }
    await maybeEnsureClosingWatch(bet, deps);
    return;
  }
  // Paginação truncada não é UNMATCHED: tenta de novo quando houver cota.
  if (identity.motivo === "budget_truncated") {
    throw new PrePinnacleRetryError(identity.motivo);
  }
  if (
    hasOpenIdentity(bet) &&
    !bet.kickoffInferido &&
    bet.data.getTime() < now.getTime() - PAST_EVENT_TERMINAL_DELAY_MS &&
    bet.registradoEm.getTime() < now.getTime() - 60 * 60_000
  ) {
    await terminalizeUnmatched(bet, `past_event:${identity.motivo}`);
    return;
  }
  throw new PrePinnacleRetryError(identity.motivo);
}

async function persistBridgeMatch(
  bet: EnrichBet,
  teams: { home: string; away: string },
  result: BridgeIdentityResolved,
  recovery: { historicalIdentityRecovery: boolean; recoveryUpsert: UpsertSharpFn },
  deps: EnrichDeps,
): Promise<void> {
  const {
    best, provider, via, confidence, judgeConfidence, priceObservedAt, segmentOff,
  } = result;
  // O horário atual do jogo, na Pinnacle17 pelo mesmo id: consulta de rede,
  // fora da gravação.
  const gameStart = await observeEnrichStage("identity_kickoff", () => bridgeMatchGameStart(best.match, bet.data));
  const applied = await observeEnrichStage("persist_identity", () => applyBridgeIdentity({
    // MANUAL prevalece sobre AUTO: o apply não reescreve o que o operador resolveu.
    bet: { ...bet, identityStatus: bet.sharp?.identityStatus ?? null },
    best,
    via,
    teams,
    confidence,
    judgeConfidence,
    gameStart,
  }));

  if (hasOpenIdentity(bet)) {
    await recovery.recoveryUpsert(bet.id, {
      identityStatus: "MATCHED", confidence, provider: "bridgeodds",
      providerMatchId: String(best.match.match_id), noOddsReason: "no_prices",
    });
  }

  // O caso aberto só fecha com a identidade gravada: a gravação recusada
  // (aposta editada no meio) deixa o caso para a próxima tentativa.
  if (via === "AUTO") await closeOpenTrainingCase(bet.id, "AUTO_APPLIED");

  if (recovery.historicalIdentityRecovery) {
    await recovery.recoveryUpsert(bet.id, {
      identityStatus: "MATCHED",
      confidence,
      provider: provider ?? "bridgeodds",
      providerMatchId: String(best.match.match_id),
      priceReference: null,
    });
    return;
  }

  await observeEnrichStage("price", () => applyBridgeOdds({
    // A identidade canoniza uma cópia; a referência de fechamento precisa dos
    // mesmos termos persistidos.
    bet: { ...bet, mercado: applied.mercado, selecao: applied.selecao, data: applied.data },
    match: best.match,
    esporteCanonico: applied.esporteCanonico,
    competicao: applied.competicao,
    pais: applied.pais,
    confidence,
    kickoffValido: applied.kickoffValido,
    kickoff: applied.kickoff,
    priceObservedAt,
    segmentOff,
  }));

  await maybeEnsureClosingWatch(
    {
      id: bet.id,
      data: applied.kickoffValido ? applied.kickoff : bet.data,
      kickoffInferido: applied.kickoffInferido,
      bankroll: bet.bankroll,
    },
    deps,
  );
}
