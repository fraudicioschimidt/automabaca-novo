ALTER TABLE "provider_budgets"
  ADD COLUMN "reserved" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "provider_budget_reservations" (
  "provider" TEXT NOT NULL,
  "periodKey" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "resourceKey" TEXT NOT NULL,
  "units" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_budget_reservations_pkey"
    PRIMARY KEY ("provider", "periodKey", "purpose", "resourceKey"),
  CONSTRAINT "provider_budget_reservations_units_check" CHECK ("units" > 0)
);

CREATE INDEX "provider_budget_reservations_provider_periodKey_purpose_idx"
  ON "provider_budget_reservations"("provider", "periodKey", "purpose");

CREATE TABLE "provider_caches" (
  "provider" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_caches_pkey" PRIMARY KEY ("provider", "key")
);

CREATE INDEX "provider_caches_expiresAt_idx" ON "provider_caches"("expiresAt");

CREATE TABLE "provider_request_gates" (
  "provider" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "nextAllowedAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_request_gates_pkey" PRIMARY KEY ("provider", "route")
);

ALTER TABLE "provider_budgets"
  ADD CONSTRAINT "provider_budgets_nonnegative_check"
  CHECK ("spent" >= 0 AND "reserved" >= 0);
