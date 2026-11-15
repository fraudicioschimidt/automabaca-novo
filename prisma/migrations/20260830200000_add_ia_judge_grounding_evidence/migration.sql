CREATE TYPE "IaJudgeEvidenceKind" AS ENUM ('FLASHSCORE_STRUCTURED', 'GROUNDED_WEB');

ALTER TABLE "ia_judge_suggestions"
  ADD COLUMN "evidenceKind" "IaJudgeEvidenceKind",
  ADD COLUMN "groundingQuery" TEXT,
  ADD COLUMN "groundingSources" JSONB,
  ADD COLUMN "groundedAt" TIMESTAMPTZ(3);
