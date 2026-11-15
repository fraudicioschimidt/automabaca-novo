CREATE TYPE "OperationalActionStatus" AS ENUM (
  'OPEN', 'ACKED', 'RUNNING', 'RESOLVED', 'DISMISSED', 'EXPIRED'
);
CREATE TYPE "OperationalRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "CommandPlanStatus" AS ENUM (
  'READY', 'EXECUTING', 'EXECUTED', 'STALE', 'EXPIRED', 'FAILED'
);
CREATE TYPE "WebAuthnChallengePurpose" AS ENUM ('REGISTRATION', 'AUTHENTICATION');

CREATE TABLE "operational_actions" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "area" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 50,
  "risk" "OperationalRisk" NOT NULL DEFAULT 'LOW',
  "status" "OperationalActionStatus" NOT NULL DEFAULT 'OPEN',
  "resource" TEXT,
  "resourceId" TEXT,
  "owner" TEXT,
  "correlationId" TEXT,
  "evidence" JSONB,
  "command" JSONB,
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMPTZ(3),
  "resolvedAt" TIMESTAMPTZ(3),
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operational_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operational_actions_fingerprint_key" ON "operational_actions"("fingerprint");
CREATE INDEX "operational_actions_status_priority_lastSeenAt_idx"
  ON "operational_actions"("status", "priority", "lastSeenAt" DESC);
CREATE INDEX "operational_actions_area_status_idx" ON "operational_actions"("area", "status");
CREATE INDEX "operational_actions_resource_resourceId_idx" ON "operational_actions"("resource", "resourceId");
CREATE INDEX "operational_actions_owner_status_idx" ON "operational_actions"("owner", "status");

CREATE TABLE "command_plans" (
  "id" TEXT NOT NULL,
  "command" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "snapshot" JSONB NOT NULL,
  "effects" JSONB NOT NULL,
  "risk" "OperationalRisk" NOT NULL,
  "planHash" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" "CommandPlanStatus" NOT NULL DEFAULT 'READY',
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "executedAt" TIMESTAMPTZ(3),
  "result" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "command_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "command_plans_planHash_key" ON "command_plans"("planHash");
CREATE UNIQUE INDEX "command_plans_idempotencyKey_key" ON "command_plans"("idempotencyKey");
CREATE INDEX "command_plans_actor_status_createdAt_idx"
  ON "command_plans"("actor", "status", "createdAt" DESC);
CREATE INDEX "command_plans_status_expiresAt_idx" ON "command_plans"("status", "expiresAt");

CREATE TABLE "saved_views" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "state" JSONB NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saved_views_username_route_name_key" ON "saved_views"("username", "route", "name");
CREATE INDEX "saved_views_username_route_isDefault_idx" ON "saved_views"("username", "route", "isDefault");

CREATE TABLE "auth_passkey_credentials" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "publicKey" BYTEA NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "transports" TEXT[],
  "deviceType" TEXT NOT NULL,
  "backedUp" BOOLEAN NOT NULL DEFAULT false,
  "name" TEXT NOT NULL DEFAULT 'Passkey',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMPTZ(3),
  CONSTRAINT "auth_passkey_credentials_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "auth_passkey_credentials_username_createdAt_idx"
  ON "auth_passkey_credentials"("username", "createdAt" DESC);

CREATE TABLE "auth_webauthn_challenges" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "challengeHash" TEXT NOT NULL,
  "purpose" "WebAuthnChallengePurpose" NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_webauthn_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_webauthn_challenges_challengeHash_key"
  ON "auth_webauthn_challenges"("challengeHash");
CREATE INDEX "auth_webauthn_challenges_username_purpose_consumedAt_expiresAt_idx"
  ON "auth_webauthn_challenges"("username", "purpose", "consumedAt", "expiresAt");
CREATE INDEX "auth_webauthn_challenges_expiresAt_idx" ON "auth_webauthn_challenges"("expiresAt");
