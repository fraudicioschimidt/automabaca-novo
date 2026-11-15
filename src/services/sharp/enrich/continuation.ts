import type { PgBoss } from "pg-boss";
import type { BridgeSearchResume } from "@/src/providers/bridgeodds/match";
import type { BridgeQueryFn } from "@/src/providers/bridgeodds/scoring";
import type { KickoffWebSearchFn } from "./resolve-kickoff-web";
import type {
  findFlashscoreMatchIdForBet,
  resolveKickoffViaFlashscoreSchedule,
} from "./resolve-kickoff-flashscore";

/** Fatia de busca Bridge por execução do job; o resto continua num job novo. */
export const SHARP_BRIDGE_SLICE_MS = 5_000;

export type SharpContinuation = {
  betSignature?: string;
  bridge?: BridgeSearchResume;
  pinnacle17TriedAt?: number;
};

export class SharpContinuationError extends Error {
  constructor(readonly retryAt: Date, readonly continuation: SharpContinuation = {}) {
    super("Enriquecimento aguardando continuação durável.");
    this.name = "SharpContinuationError";
  }
}

/** Estado da execução do job de enrich e substituições usadas pelos testes. */
export type EnrichDeps = {
  continuation?: SharpContinuation;
  query?: BridgeQueryFn;
  webSearch?: KickoffWebSearchFn;
  now?: Date;
  /** Agenda a captura de fechamento. */
  boss?: PgBoss;
  findFlashscoreMatchId?: typeof findFlashscoreMatchIdForBet;
  flashscoreSchedule?: typeof resolveKickoffViaFlashscoreSchedule;
};
