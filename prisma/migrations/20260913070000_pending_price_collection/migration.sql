BEGIN;
CREATE TABLE price_archive_collections (
  id UUID PRIMARY KEY,
  "intentId" UUID NOT NULL REFERENCES price_archive_intents(id) ON DELETE CASCADE ON UPDATE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('entry', 'closing')),
  "contextHash" TEXT NOT NULL CHECK ("contextHash" ~ '^[0-9a-f]{64}$'),
  "eventId" TEXT NOT NULL CHECK ("eventId" ~ '^[0-9]+$'),
  "eventContext" JSONB NOT NULL CHECK (octet_length("eventContext"::text) <= 16384),
  "eventObservedAt" TIMESTAMPTZ(3) NOT NULL,
  "windowStart" TIMESTAMPTZ(3) NOT NULL,
  deadline TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
  "lastAttemptAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  CHECK ("windowStart" < deadline AND "eventObservedAt" <= "createdAt" AND "eventObservedAt" < deadline),
  UNIQUE ("intentId", phase, "contextHash")
);
CREATE INDEX ON price_archive_collections ("completedAt", "nextAttemptAt");
CREATE INDEX ON price_archive_collections ("eventId", "lastAttemptAt");
CREATE INDEX ON price_archive_collections (deadline);
CREATE TABLE price_archive_collection_budgets (
  day TEXT PRIMARY KEY CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  spent INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION price_archive_collection_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['nextAttemptAt','lastAttemptAt','completedAt','attempts']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['nextAttemptAt','lastAttemptAt','completedAt','attempts'])
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'price collection context is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_archive_collection_immutable BEFORE UPDATE ON price_archive_collections
FOR EACH ROW EXECUTE FUNCTION price_archive_collection_immutable();
COMMIT;
