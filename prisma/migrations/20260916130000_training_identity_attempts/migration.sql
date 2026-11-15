ALTER TABLE "training_cases"
  ADD COLUMN "identityAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "identityLastAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "identityNextAttemptAt" TIMESTAMPTZ(3);
CREATE INDEX "training_cases_status_identityNextAttemptAt_idx"
  ON "training_cases"("status", "identityNextAttemptAt");
