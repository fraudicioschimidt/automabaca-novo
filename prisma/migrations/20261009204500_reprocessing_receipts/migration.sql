CREATE TABLE "absorbed_bet_sources" (
    "source" TEXT NOT NULL,
    "sourceExternalId" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "absorbed_bet_sources_pkey" PRIMARY KEY ("source", "sourceExternalId")
);

CREATE INDEX "absorbed_bet_sources_betId_idx" ON "absorbed_bet_sources"("betId");

ALTER TABLE "absorbed_bet_sources" ADD CONSTRAINT "absorbed_bet_sources_betId_fkey"
    FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Consulta das origens anteriores ao recibo, sem varrer toda a auditoria.
CREATE INDEX "audit_events_absorbed_source_idx"
    ON "audit_events" ((details->>'source'), (details->>'sourceExternalId'))
    WHERE action = 'bet.duplicate_absorbed' AND resource = 'bet';

CREATE TABLE "creation_receipts" (
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "creation_receipts_pkey" PRIMARY KEY ("action", "actor", "requestId")
);
