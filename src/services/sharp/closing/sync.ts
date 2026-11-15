import { CircuitOpenError } from "@/src/infra/circuit-breaker";
import { ProviderCadenceDeferredError } from "@/src/domain/provider-error";
import { sendOperationalAlert } from "@/src/services/ops/alerts";
import { reconcileOperationalActionSource } from "@/src/services/ops/operational-actions";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import type { Prisma } from "@/src/generated/prisma/client";
import { checkProviderBudgetAlerts } from "@/src/services/ops/budget-alerts";
import { adaptiveBatchSize } from "@/src/services/sharp/batch-size";
import { getSegmentPhaseMap, isSegmentSharpOff } from "@/src/services/sharp/segment-policy";
import { mapWithConcurrency } from "@/src/services/shared/concurrency";
import { bridgeOddsIsAuthoritative } from "@/src/providers/coverage";
import { BRIDGE_SYNC_AFTER_KICKOFF_MS } from "@/src/services/sharp/bridge-postgame";
import { processBridgeClosing, processNonBridgeClosing } from "./process-bet";
import type { ClosingDeps, ClosingSyncResult } from "./types";

const log = createLogger("closing");
const CLOSING_CONCURRENCY = 3;

/**
 * Ciclo de fechamento (job cron `closing.sync`, a cada 5 min), só depois do
 * kickoff: congela a linha de FECHAMENTO e o CLV contra a fair devigada, uma
 * vez por aposta (`fetchedAt`). A Pinnacle17 é consultada antes do apito só
 * pela agenda da série (`series.ts`); aqui ela congela o que a série gravou. A
 * BridgeOdds consolida o fechamento depois do início e é consultada aqui até
 * 30 min depois dele; dali em diante é da busca pós-jogo (`bridge-postgame.ts`).
 * Falha de uma aposta não derruba o lote. Resultado não pertence a este job:
 * a liquidação externa roda só no ciclo FlashScore.
 */

export const eligibleBetSelect = {
  id: true,
  evento: true,
  esporte: true,
  competicao: true,
  pais: true,
  mercado: true,
  selecao: true,
  legsJson: true,
  liveScoreHome: true,
  liveScoreAway: true,
  odds: true,
  stake: true,
  status: true,
  data: true,
  registradoEm: true, sourcePostedAt: true,
  kickoffInferido: true,
  liveTextAtCapture: true,
  bankroll: { select: { slug: true, sharpMode: true } },
  sharp: { select: { provider: true, providerMatchId: true, priceReference: true, identityStatus: true } },
  closing: {
    select: {
      fetchedAt: true,
      clv: true,
      closingOdd: true,
    },
  },
  sportResolutionStatus: true,
  deletedAt: true,
} as const;

/**
 * Escolhe a fonte do closing sem misturar namespaces de fixture: quem casou a
 * aposta pela Pinnacle17 fecha pela Pinnacle17; trocar o `providerMatchId` por
 * um rematch Bridge quebraria a proveniência da linha.
 */
export function shouldUseBridgeClosing(params: {
  persistedProvider: string | null | undefined;
  bridgeAuthoritative: boolean;
}): boolean {
  if (params.persistedProvider === "bridgeodds") return true;
  if (params.persistedProvider === "pinnacle17") return false;
  return params.bridgeAuthoritative;
}

type ClosingBetRow = Prisma.BetGetPayload<{ select: typeof eligibleBetSelect }>;

function closeBet(
  bet: ClosingBetRow,
  deps: ClosingDeps,
  now: Date,
  phaseMap: Awaited<ReturnType<typeof getSegmentPhaseMap>>,
): Promise<{ closed: boolean }> {
  const segmentOff = isSegmentSharpOff(bet.esporte, bet.mercado, phaseMap);
  const bridgeAuthoritative = bridgeOddsIsAuthoritative({
    esporte: bet.esporte,
    mercado: bet.mercado,
    selecao: bet.selecao,
  });
  return shouldUseBridgeClosing({ persistedProvider: bet.sharp?.provider, bridgeAuthoritative })
    ? processBridgeClosing(bet, deps, now, segmentOff)
    : processNonBridgeClosing(bet, deps, now, segmentOff);
}

export async function runClosingSyncOnce(
  deps: ClosingDeps = {},
): Promise<ClosingSyncResult> {
  const now = deps.now ?? new Date();

  const base: Prisma.BetWhereInput = {
    deletedAt: null,
    sportResolutionStatus: "CONFIRMED",
    ...(deps.bankrollId ? { bankrollId: deps.bankrollId } : {}),
    bankroll: { is: { sharpMode: "CLV_ONLY" } },
  };
  const matchedClosing: Prisma.BetWhereInput = {
    // MANUAL (identidade resolvida pelo operador) é tão confiável quanto
    // MATCHED. Identidade sem provider não tem de onde fechar.
    sharp: { is: { identityStatus: { in: ["MATCHED", "MANUAL"] }, provider: { not: null } } },
    kickoffInferido: false,
    // Só depois do apito, uma vez por aposta. Resultado não reabre o lote.
    data: { lte: now },
    OR: [{ closing: null }, { closing: { is: { fetchedAt: null } } }],
    // A aposta da Bridge passa à busca pós-jogo 30 min depois do início.
    NOT: {
      sharp: { is: { provider: "bridgeodds" } },
      data: { lte: new Date(now.getTime() - BRIDGE_SYNC_AFTER_KICKOFF_MS) },
    },
  };
  const where: Prisma.BetWhereInput = {
    AND: [base, matchedClosing],
  };

  const batchSize =
    deps.batchSize ??
    adaptiveBatchSize(await prisma.bet.count({ where }));

  const bets = await prisma.bet.findMany({
    where,
    select: eligibleBetSelect,
    orderBy: { data: "asc" },
    take: batchSize,
  });

  const result: ClosingSyncResult = {
    processed: bets.length,
    closed: 0,
    failures: 0,
    adiadas: 0,
  };
  const falhas: Array<{ betId: string; evento: string; motivo: string }> = [];
  const phaseMap = await getSegmentPhaseMap();

  const outcomes = await mapWithConcurrency(bets, CLOSING_CONCURRENCY, async (bet) => {
    if (deps.signal?.aborted) return { kind: "deferred" as const };
    try {
      const outcome = await closeBet(bet, deps, now, phaseMap);
      return { kind: "ok" as const, ...outcome };
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        log.info(
          { betId: bet.id, evento: bet.evento, err: err.message },
          "breaker aberto no closing — aposta adiada sem queimar o lote",
        );
        return { kind: "skipped_circuit" as const };
      }
      // Orçamento do provedor estourou: a aposta não coube nesta volta. Não é
      // falha — a cadência recusou antes de reservar vaga.
      if (err instanceof ProviderCadenceDeferredError) {
        log.info(
          { betId: bet.id, evento: bet.evento, retryAt: err.retryAt },
          "sem tempo no orçamento — aposta fica para o ciclo automático",
        );
        return { kind: "deferred" as const };
      }
      const failure = {
        betId: bet.id,
        evento: bet.evento,
        motivo: err instanceof Error ? err.message : String(err),
      };
      log.error({ err, betId: bet.id, evento: bet.evento }, "falha no closing desta aposta — lote continua");
      return { kind: "failure" as const, failure };
    }
  });

  for (const outcome of outcomes) {
    if (outcome.kind === "failure") {
      result.failures += 1;
      falhas.push(outcome.failure);
      continue;
    }
    if (outcome.kind === "skipped_circuit") continue;
    if (outcome.kind === "deferred") {
      result.adiadas += 1;
      continue;
    }
    if (outcome.closed) result.closed += 1;
  }

  if (result.processed > 0) {
    log.info(result, "ciclo de closing concluído");
  }

  if (falhas.length > 0) {
    const amostra = falhas
      .slice(0, 10)
      .map((f) => `• ${f.evento} (${f.betId}): ${f.motivo}`)
      .join("\n");
    const resto = falhas.length > 10 ? `\n… e mais ${falhas.length - 10}.` : "";
    await sendOperationalAlert(
      `⚠️ Fechamento: ${falhas.length} aposta(s) ficaram sem CLV\nAs demais seguiram normalmente.\n${amostra}${resto}\n`
        + "👉 Nada a fazer agora: o próximo ciclo tenta de novo e a repescagem cobre o que sobrar.",
      {
        source: "closing.sync",
        key: "batch-failure",
        title: "Falhas no fechamento ou CLV",
        resource: "closing-sync",
        evidence: { failed: falhas.length, betIds: falhas.slice(0, 20).map((f) => f.betId) },
        autoResolve: true,
      },
    );
  } else {
    await reconcileOperationalActionSource("closing.sync", []);
  }

  await checkProviderBudgetAlerts(now);

  // Fail-loud: provider morto não pode parecer “ok” no job (DLQ/retry).
  if (
    result.processed >= 3 &&
    result.failures > 0 &&
    result.failures / result.processed >= 0.5
  ) {
    throw new Error(
      `closing.sync: taxa de falha crítica (${result.failures}/${result.processed}) — job vai para DLQ`,
    );
  }
  return result;
}
