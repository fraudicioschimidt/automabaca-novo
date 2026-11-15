ALTER TABLE "bet_closing"
  ADD COLUMN "resultProvider" TEXT,
  ADD COLUMN "resultMatchId" TEXT,
  ADD COLUMN "resultMatchConfidence" DECIMAL(5,4),
  ADD COLUMN "resultSnapshot" JSONB,
  ADD COLUMN "resultCheckedAt" TIMESTAMPTZ(3),
  ADD COLUMN "resultFinal" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "bet_closing_resultCheckedAt_idx"
  ON "bet_closing"("resultCheckedAt");
