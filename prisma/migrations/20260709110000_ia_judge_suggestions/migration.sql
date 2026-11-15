-- CreateEnum
CREATE TYPE "IaJudgeSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ia_judge_suggestions" (
    "id" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "suggestedStatus" "BetStatus" NOT NULL,
    "valueFound" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'gemini',
    "status" "IaJudgeSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ia_judge_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ia_judge_cooldowns" (
    "key" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ia_judge_cooldowns_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "ia_judge_suggestions_status_createdAt_idx" ON "ia_judge_suggestions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ia_judge_suggestions_betId_idx" ON "ia_judge_suggestions"("betId");

-- Uma sugestão PENDING por aposta (homologação em andamento).
CREATE UNIQUE INDEX "ia_judge_suggestions_betId_pending_uidx"
  ON "ia_judge_suggestions"("betId")
  WHERE "status" = 'PENDING';

-- CreateIndex
CREATE INDEX "ia_judge_cooldowns_expiresAt_idx" ON "ia_judge_cooldowns"("expiresAt");

-- AddForeignKey
ALTER TABLE "ia_judge_suggestions"
  ADD CONSTRAINT "ia_judge_suggestions_betId_fkey"
  FOREIGN KEY ("betId") REFERENCES "bets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
