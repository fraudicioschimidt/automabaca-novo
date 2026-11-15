-- AlterTable
ALTER TABLE "bets" ADD COLUMN     "deletedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "bets_deletedAt_idx" ON "bets"("deletedAt");
