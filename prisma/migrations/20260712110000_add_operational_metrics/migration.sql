CREATE TABLE "operational_metrics" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "durationMs" INTEGER,
    "queueLagMs" INTEGER,
    "statusCode" INTEGER,
    "labels" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operational_metrics_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "operational_metrics_kind_name_occurredAt_idx"
ON "operational_metrics"("kind", "name", "occurredAt" DESC);

CREATE INDEX "operational_metrics_outcome_occurredAt_idx"
ON "operational_metrics"("outcome", "occurredAt" DESC);

CREATE INDEX "operational_metrics_occurredAt_idx"
ON "operational_metrics"("occurredAt");
