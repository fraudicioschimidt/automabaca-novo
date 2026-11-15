import { createLogger } from "@/src/infra/logger";
import { fonteDoEsporte } from "@/src/domain/sport-pending";
import { SPORT_AUTO_CONFIRM_MIN_CONFIDENCE } from "@/src/domain/sports/detect";
import { canonicalSport } from "@/src/domain/sports/registry";
import { canonicalCompetition, canonicalCountry } from "@/src/domain/national-teams";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { prisma } from "@/src/infra/prisma";
import { isActiveOperationalActionStatus } from "@/src/domain/operational-action-status";
import { operationalActionFingerprint, reportOperationalAction } from "@/src/services/ops/operational-actions";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { linkFlashscoreMatch } from "@/src/services/settlement/bet-result";
import { EnrichObsoleteError } from "./write-guard";
import type { BridgeQueryFn } from "@/src/providers/bridgeodds/scoring";
import { reopenSharpIdentityAfterKickoffChange } from "@/src/services/sharp/kickoff-revive";
import {
  bridgeKickoffCooldownActive,
  clearBridgeCooldown,
  recordKickoffResolveAttempt,
  setBridgeCooldown,
  setWebCooldown,
  webCooldownActive,
  WEB_KICKOFF_MISS_REASON,
  type KickoffResolveSource,
} from "./kickoff-attempts";
import { resolveKickoffViaBridgeSchedule } from "./kickoff-schedule";
import { resolveKickoffViaFlashscoreSchedule } from "./resolve-kickoff-flashscore";
import { resolveKickoffViaPinnacle17Schedule } from "./resolve-kickoff-pinnacle17";
import { resolveKickoffViaWebSearch, type KickoffWebSearchFn } from "./resolve-kickoff-web";

const log = createLogger("sharp-enrich");

type BetKickoffFields = {
  id: string;
  evento: string;
  esporte: string;
  /** Quem decidiu o esporte: vai no texto da ação quando o calendário discorda. */
  sportSource?: string | null;
  pais: string;
  competicao: string;
  data: Date;
  kickoffInferido: boolean;
};

export type KickoffDeps = {
  query?: BridgeQueryFn;
  webSearch?: KickoffWebSearchFn;
  /** Testes: força pular/usar cooldown. */
  now?: Date;
  /** Testes: substitui resolvers de catálogo. */
  flashscoreSchedule?: typeof resolveKickoffViaFlashscoreSchedule;
  pinnacle17Schedule?: typeof resolveKickoffViaPinnacle17Schedule;
};

type KickoffMetadata = {
  sport?: string | null;
  /** 0..1, a confiança do próprio provider. */
  confidence?: number | null;
  country: string | null;
  competition: string | null;
  sourceUrl?: string | null;
  matchId?: string | null;
};

/** A confiança do provider em 0..100, nunca arredondada para cima. */
function providerConfidence(metadata: KickoffMetadata): number {
  return Math.max(0, Math.min(100, Math.floor((metadata.confidence ?? 0) * 100)));
}

const SPORT_REVIEW_SOURCE = "kickoff.sport-disagreement";

/** O dono já fechou a ação deste mesmo candidato (esporte e horário): não reabre. */
async function sportReviewAlreadyClosed(betId: string, sport: string, kickoffIso: string): Promise<boolean> {
  const existing = await prisma.operationalAction.findUnique({
    where: { fingerprint: operationalActionFingerprint(SPORT_REVIEW_SOURCE, betId) },
    select: { status: true, evidence: true },
  });
  if (!existing || isActiveOperationalActionStatus(existing.status)) return false;
  const evidence = (existing.evidence ?? {}) as { esporteSugerido?: unknown; kickoffSugerido?: unknown };
  return evidence.esporteSugerido === sport && evidence.kickoffSugerido === kickoffIso;
}

/**
 * O calendário achou o jogo em outro esporte. A busca de horário não troca o
 * esporte, qualquer que seja a origem dele (quem decide é a captura, o
 * resolvedor ou o dono), e o horário achado não é aplicado: é o de um jogo de
 * outro esporte. Com a confiança que confirmaria aquele esporte
 * (`SPORT_AUTO_CONFIRM_MIN_CONFIDENCE`), a ação `sport.review` leva a
 * evidência para o dono decidir; abaixo, fica só a tentativa registrada.
 */
async function refuseOtherSport(
  bet: BetKickoffFields,
  via: KickoffResolveSource,
  metadata: KickoffMetadata & { sport: string },
  scheduled: Date,
) {
  const confidence = providerConfidence(metadata);
  const review = confidence >= SPORT_AUTO_CONFIRM_MIN_CONFIDENCE;
  await recordKickoffResolveAttempt({
    betId: bet.id, source: via, anterior: bet.data, resolvido: null, aplicado: false,
    esporteAnterior: bet.esporte, esporteResolvido: metadata.sport, missReason: "other_sport",
    ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
  });
  await recordOperationalMetric({
    kind: "action", name: "kickoff.resolve", outcome: "success",
    labels: { source: via, result: "other_sport", review },
  });
  if (!review || await sportReviewAlreadyClosed(bet.id, metadata.sport, scheduled.toISOString())) return;
  const origin = fonteDoEsporte({ source: bet.sportSource });
  await reportOperationalAction({
    source: SPORT_REVIEW_SOURCE, key: bet.id, area: "captura", actionType: "sport.review",
    title: `Conferir esporte: ${bet.evento}`,
    description: `A busca de horário achou o jogo em ${metadata.sport} (${confidence}%), mas a aposta está em ${bet.esporte}`
      + `${origin ? `, segundo ${origin}` : ""}. Nada foi trocado: nem o esporte, nem o horário.`,
    resource: "bet", resourceId: bet.id, autoResolve: false,
    evidence: {
      esporte: bet.esporte, sportSource: bet.sportSource ?? null, esporteSugerido: metadata.sport,
      kickoffSugerido: scheduled.toISOString(), confianca: confidence, via, sourceUrl: metadata.sourceUrl ?? null,
    },
  });
}

/** true quando aplicou; false quando o calendário achou o jogo em outro esporte. */
async function applyKickoffCorrection(
  bet: BetKickoffFields,
  scheduled: Date,
  via: KickoffResolveSource,
  metadata?: KickoffMetadata,
): Promise<boolean> {
  const anterior = bet.data;
  if (metadata?.sport && canonicalSport(metadata.sport) !== canonicalSport(bet.esporte)) {
    await refuseOtherSport(bet, via, { ...metadata, sport: metadata.sport }, scheduled);
    return false;
  }
  // Calendários auxiliares localizam horário, mas os rótulos deles não
  // substituem o país e a competição da Pinnacle mostrados na aposta.
  const identityMetadata = via === "pinnacle17" ? metadata : undefined;
  const resolvedCountry = identityMetadata?.country ? canonicalCountry(identityMetadata.country) : bet.pais;
  const resolvedCompetition = identityMetadata?.competition ? canonicalCompetition(identityMetadata.competition) : bet.competicao;

  // Horário e vínculo são a mesma decisão: falha no vínculo reverte o
  // horário, e uma edição concorrente só passa depois de ambos gravados.
  await runSerializableTransaction("kickoff.correct", async (tx) => {
    const updated = await tx.bet.updateMany({
      where: { id: bet.id, deletedAt: null, data: anterior, evento: bet.evento, esporte: bet.esporte },
      data: {
        data: scheduled,
        kickoffInferido: false,
        ...(resolvedCountry ? { pais: resolvedCountry } : {}),
        ...(resolvedCompetition ? { competicao: resolvedCompetition } : {}),
      },
    });
    if (!updated.count) throw new EnrichObsoleteError();
    if (metadata?.matchId) await linkFlashscoreMatch(tx, bet.id, metadata.matchId);
  });
  bet.data = scheduled;
  bet.kickoffInferido = false;
  if (resolvedCountry) bet.pais = resolvedCountry;
  if (resolvedCompetition) bet.competicao = resolvedCompetition;
  await clearBridgeCooldown(bet.id);
  await recordKickoffResolveAttempt({
    betId: bet.id,
    source: via,
    anterior,
    resolvido: scheduled,
    aplicado: true,
    ...(metadata?.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
  });
  await reopenSharpIdentityAfterKickoffChange({
    betId: bet.id,
    anterior,
    novo: scheduled,
  });
  await recordOperationalMetric({
    kind: "action",
    name: "kickoff.resolve",
    outcome: "success",
    labels: { source: via, result: "applied" },
  });
  log.info(
    {
      betId: bet.id,
      via,
      anterior: anterior.toISOString(),
      novo: scheduled.toISOString(),
      pais: resolvedCountry,
      competicao: resolvedCompetition,
      ...(metadata?.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
    },
    `kickoff inferido corrigido via ${via}`,
  );
  return true;
}

/**
 * Kickoff provisório (post sem hora): corrige ANTES do matching. Ordem:
 * FlashScore → Bridge → Pinnacle17 → busca web (cooldown de 6h).
 * Um calendário confiável basta; a web não é confirmação obrigatória.
 */
export async function resolveProvisionalKickoff(
  bet: BetKickoffFields,
  deps: KickoffDeps = {},
): Promise<void> {
  if (!bet.kickoffInferido) return;

  const now = deps.now ?? new Date();
  const base = {
    evento: bet.evento,
    esporte: bet.esporte,
    pais: bet.pais,
    competicao: bet.competicao,
    data: bet.data,
  };
  const flashscore = deps.flashscoreSchedule ?? resolveKickoffViaFlashscoreSchedule;
  const fromFs = await flashscore(base);
  if (fromFs && await applyKickoffCorrection(bet, fromFs.kickoff, "flashscore", fromFs)) return;

  if (await bridgeKickoffCooldownActive(bet.id, now)) {
    log.debug({ betId: bet.id }, "kickoff-bridge em cooldown — pulando Bridge");
  } else {
    const scheduled = await resolveKickoffViaBridgeSchedule({
      ...base,
      query: deps.query,
    });
    if (scheduled) {
      await applyKickoffCorrection(bet, scheduled, "bridge");
      return;
    }
    await setBridgeCooldown(bet.id, bet.data, now, "bridge_kickoff_miss");
  }

  const pinnacle17 = deps.pinnacle17Schedule ?? resolveKickoffViaPinnacle17Schedule;
  const fromPinn = await pinnacle17(base);
  if (fromPinn) {
    await applyKickoffCorrection(bet, fromPinn.kickoff, fromPinn.source, fromPinn);
    return;
  }

  if (await webCooldownActive(bet.id, now)) {
    log.debug({ betId: bet.id }, "kickoff-web em cooldown — adiando");
    await recordOperationalMetric({
      kind: "action",
      name: "kickoff.resolve",
      outcome: "success",
      labels: { source: "web", result: "cooldown", missReason: "catalogs_miss" },
    });
    return;
  }

  const anterior = bet.data;
  const fromWeb = await resolveKickoffViaWebSearch({
    ...base,
    search: deps.webSearch,
  });
  if (fromWeb) {
    // Jogo achado em outro esporte: a mesma resposta voltaria a cada ciclo.
    if (!await applyKickoffCorrection(bet, fromWeb.kickoff, "web", fromWeb)) {
      await setWebCooldown(bet.id, WEB_KICKOFF_MISS_REASON, now);
    }
    return;
  }

  await recordKickoffResolveAttempt({
    betId: bet.id,
    source: "web",
    anterior,
    resolvido: null,
    aplicado: false,
    missReason: "catalogs_and_web_miss",
  });
  await recordOperationalMetric({
    kind: "action",
    name: "kickoff.resolve",
    outcome: "success",
    labels: { source: "web", result: "miss", missReason: "catalogs_and_web_miss" },
  });
  await setWebCooldown(bet.id, WEB_KICKOFF_MISS_REASON, now);
}
