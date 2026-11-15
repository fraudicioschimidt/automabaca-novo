import type { NoOddsReason } from "@/src/domain/no-odds-reason";
import { createLogger } from "@/src/infra/logger";
import { recordTrainingFailure } from "./training-cases";
import { upsertSharp, type UpsertSharpFn } from "./upsert-sharp";

const log = createLogger("sharp-enrich");
const HISTORICAL_IDENTITY_WINDOW_MS = 30 * 24 * 3_600_000;

export type TrainingBet = {
  id: string;
  evento: string;
  esporte: string;
  pais: string;
  competicao: string;
};

export function isHistoricalIdentityRecovery(
  bet: Pick<TrainingBet, "id"> & {
    data: Date;
    registradoEm?: Date;
    sourcePostedAt?: Date | null;
    sharp: { identityStatus: string } | null;
  },
  now: Date,
): boolean {
  if (bet.sharp !== null && bet.sharp.identityStatus !== "PENDING") {
    return false;
  }
  const kickoff = bet.data.getTime();
  const nowMs = now.getTime();
  if (kickoff < nowMs - HISTORICAL_IDENTITY_WINDOW_MS) {
    return false;
  }
  // Se a aposta foi postada antes do kickoff (registradoEm < data), concede tolerância
  // de até 5 minutos para não classificar como recuperação histórica nem apagar priceReference.
  const entryTime = bet.sourcePostedAt ?? bet.registradoEm;
  if (entryTime && entryTime.getTime() < kickoff) {
    if (nowMs - kickoff <= 5 * 60_000) {
      return false;
    }
  }
  return kickoff <= nowMs;
}

export async function terminalizeUnmatched(bet: TrainingBet, reason: string): Promise<void> {
  // O motivo fino (`past_event:…`, `provisional_kickoff_day_expired`) vive no
  // TrainingCase; o vocabulário fechado é o que a tela e a base de cobertura
  // leem; sem ele a aposta terminaria sem provider e sem explicação.
  await upsertSharp(bet.id, {
    identityStatus: "UNMATCHED",
    confidence: 0,
    noOddsReason: "identidade_nao_casada",
  });
  await recordTrainingFailure(bet, reason);
  log.info({ betId: bet.id, evento: bet.evento, reason }, "identidade não resolvida");
}

/** Na recuperação histórica o motivo da ausência de preço é o modo da banca. */
function historicalNoOddsReason(sharpMode: string): NoOddsReason {
  return sharpMode === "IDENTITY_ONLY" ? "identity_only" : "clv_only";
}

export function historicalIdentityUpsert(sharpMode: string): UpsertSharpFn {
  return (betId, data, db) => upsertSharp(betId, {
    identityStatus: data.identityStatus,
    confidence: data.confidence,
    ...(data.provider ? { provider: data.provider } : {}),
    ...(data.providerMatchId ? { providerMatchId: data.providerMatchId } : {}),
    ...(data.priceReference !== undefined ? { priceReference: data.priceReference } : {}),
    // MATCHED na recuperação histórica tem motivo PRÓPRIO (o modo da banca
    // decide). Os demais status preservam o motivo de quem chamou — senão o
    // wrapper apagaria justamente a explicação terminal (`unsupported_market`).
    ...(data.identityStatus === "MATCHED"
      ? { noOddsReason: historicalNoOddsReason(sharpMode) }
      : data.noOddsReason !== undefined
        ? { noOddsReason: data.noOddsReason }
        : {}),
  }, db);
}
