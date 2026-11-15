CREATE TYPE "CaptureStakePolicy" AS ENUM ('MESSAGE', 'WHEN_MISSING', 'ALWAYS');
ALTER TABLE "bankrolls"
  ADD COLUMN "stakePolicy" "CaptureStakePolicy" NOT NULL DEFAULT 'MESSAGE',
  ADD COLUMN "defaultStakeUnits" DECIMAL(14,6);
ALTER TABLE "bankrolls" ADD CONSTRAINT "bankroll_capture_stake_valid"
  CHECK (("defaultStakeUnits" IS NULL OR ("defaultStakeUnits" > 0 AND "defaultStakeUnits" <= 100))
    AND ("stakePolicy" = 'MESSAGE' OR "defaultStakeUnits" IS NOT NULL));
