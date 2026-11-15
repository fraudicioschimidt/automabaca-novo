CREATE TYPE "SportResolutionStatus" AS ENUM ('CONFIRMED', 'PENDING', 'CONFLICT');
CREATE TYPE "SportResolutionSource" AS ENUM (
    'LEGACY',
    'TEXT',
    'EMOJI',
    'COMPETITION',
    'LLM',
    'TEAM_ID',
    'PROVIDER',
    'WEB',
    'MANUAL',
    'UNRESOLVED'
);

ALTER TABLE "bets"
    ADD COLUMN "sportResolutionStatus" "SportResolutionStatus" NOT NULL DEFAULT 'CONFIRMED',
    ADD COLUMN "sportConfidence" INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN "sportSource" "SportResolutionSource" NOT NULL DEFAULT 'LEGACY',
    ADD COLUMN "sportEvidence" JSONB,
    ADD COLUMN "sportResolvedAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "sportResolverVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "bets"
    ADD CONSTRAINT "bets_sportConfidence_check"
    CHECK ("sportConfidence" >= 0 AND "sportConfidence" <= 100);

ALTER TABLE "bets"
    ADD CONSTRAINT "bets_sport_resolution_state_check"
    CHECK (
      ("sportResolutionStatus" = 'CONFIRMED' AND "esporte" <> 'Unknown')
      OR
      ("sportResolutionStatus" <> 'CONFIRMED' AND "esporte" = 'Unknown')
    );

CREATE INDEX "bets_sportResolutionStatus_registradoEm_idx"
    ON "bets"("sportResolutionStatus", "registradoEm");

CREATE TABLE "bet_capture_evidence" (
    "betId" TEXT NOT NULL,
    "parser" TEXT NOT NULL,
    "caption" TEXT,
    "mediaFileId" TEXT,
    "parsedJson" JSONB NOT NULL,
    "candidatesJson" JSONB,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_capture_evidence_pkey" PRIMARY KEY ("betId")
);

CREATE INDEX "bet_capture_evidence_expiresAt_idx"
    ON "bet_capture_evidence"("expiresAt");

ALTER TABLE "bet_capture_evidence"
    ADD CONSTRAINT "bet_capture_evidence_betId_fkey"
    FOREIGN KEY ("betId") REFERENCES "bets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
