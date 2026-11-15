CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACKED', 'RESOLVED');
CREATE TYPE "IncidentSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TABLE "incidents" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL DEFAULT 'WARNING',
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "owner" TEXT,
    "evidence" JSONB,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "autoResolve" BOOLEAN NOT NULL DEFAULT true,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "incidents_fingerprint_key" ON "incidents"("fingerprint");
CREATE INDEX "incidents_status_severity_lastSeenAt_idx"
ON "incidents"("status", "severity", "lastSeenAt" DESC);
CREATE INDEX "incidents_source_resource_resourceId_idx"
ON "incidents"("source", "resource", "resourceId");
CREATE INDEX "incidents_owner_status_idx" ON "incidents"("owner", "status");

-- Preserva os alertas críticos recentes que antes existiam apenas no ledger de
-- auditoria. Novas ocorrências passam a usar fingerprints semânticos no serviço.
INSERT INTO "incidents" (
  "id", "fingerprint", "title", "description", "severity", "status",
  "source", "resource", "resourceId", "evidence", "openedAt", "lastSeenAt",
  "createdAt", "updatedAt"
)
SELECT
  ae.id,
  'legacy:' || ae.id,
  CASE ae.action
    WHEN 'bet_lucro_drift' THEN 'Lucro divergente do status'
    WHEN 'conta_drift' THEN 'Saldo divergente do ledger'
    WHEN 'budget_alert' THEN 'Budget de provider no limite'
    ELSE ae.action
  END,
  'Importado do histórico de auditoria durante a criação do inbox.',
  CASE WHEN ae.action IN ('bet_lucro_drift', 'conta_drift')
    THEN 'CRITICAL'::"IncidentSeverity"
    ELSE 'WARNING'::"IncidentSeverity"
  END,
  'OPEN'::"IncidentStatus",
  ae.action,
  ae.resource,
  ae."resourceId",
  jsonb_build_object('auditEventId', ae.id, 'details', ae.details),
  ae."createdAt",
  ae."createdAt",
  ae."createdAt",
  ae."createdAt"
FROM audit_events ae
WHERE ae.action IN ('bet_lucro_drift', 'conta_drift', 'budget_alert')
  AND ae."createdAt" >= now() - interval '14 days';
