-- CreateEnum
CREATE TYPE "SegmentPhase" AS ENUM ('PROBATION', 'SHARP_ACTIVE', 'SHARP_OFF');

-- CreateTable
CREATE TABLE "market_segment_policies" (
    "id" TEXT NOT NULL,
    "esporte" TEXT NOT NULL,
    "mercado" TEXT NOT NULL,
    "phase" "SegmentPhase" NOT NULL DEFAULT 'PROBATION',
    "source" TEXT NOT NULL DEFAULT 'AUTO',
    "betsAvaliadas" INTEGER NOT NULL DEFAULT 0,
    "clvReliablePct" DECIMAL(5,1),
    "evaluatedAt" TIMESTAMPTZ(3),
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_segment_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_segment_policies_esporte_mercado_key" ON "market_segment_policies"("esporte", "mercado");
