-- DropForeignKey
ALTER TABLE "training_cases" DROP CONSTRAINT "training_cases_betId_fkey";

-- CreateTable
CREATE TABLE "retired_bet_sources" (
    "source" TEXT NOT NULL,
    "sourceExternalId" TEXT NOT NULL,
    "retiredBetId" TEXT NOT NULL,
    "retiredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retired_bet_sources_pkey" PRIMARY KEY ("source","sourceExternalId")
);

-- CreateIndex
CREATE INDEX "retired_bet_sources_retiredAt_idx" ON "retired_bet_sources"("retiredAt");

-- AddForeignKey
ALTER TABLE "training_cases" ADD CONSTRAINT "training_cases_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
