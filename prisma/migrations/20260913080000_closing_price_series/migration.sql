BEGIN;
CREATE TABLE closing_price_watches (
  id UUID PRIMARY KEY,
  "betId" TEXT NOT NULL REFERENCES bets(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "contextHash" TEXT NOT NULL CHECK ("contextHash" ~ '^[0-9a-f]{64}$'),
  "eventId" TEXT NOT NULL CHECK ("eventId" ~ '^[0-9]+$'),
  kickoff TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
  "leaseUntil" TIMESTAMPTZ(3),
  "leaseToken" UUID,
  "lastPhysicalAt" TIMESTAMPTZ(3),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  "completedAt" TIMESTAMPTZ(3),
  CHECK ("createdAt" < kickoff),
  UNIQUE ("betId", "contextHash")
);
CREATE INDEX ON closing_price_watches ("completedAt", "nextAttemptAt");
CREATE INDEX ON closing_price_watches ("eventId", "lastPhysicalAt");
CREATE INDEX ON closing_price_watches (kickoff);
CREATE TABLE closing_price_observations (
  id UUID PRIMARY KEY,
  "watchId" UUID NOT NULL REFERENCES closing_price_watches(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "attemptedAt" TIMESTAMPTZ(3) NOT NULL,
  "observedAt" TIMESTAMPTZ(3),
  source TEXT NOT NULL CHECK (source IN ('primary','extra','archive')),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','preserved','unavailable','quota','deferred','obsolete')),
  "rawOdd" DECIMAL(10,4),
  "fairOdd" DECIMAL(12,6),
  "archiveId" TEXT,
  CHECK (("rawOdd" IS NULL AND "fairOdd" IS NULL) OR ("rawOdd" > 1 AND "fairOdd" > 1 AND "observedAt" IS NOT NULL))
);
CREATE INDEX ON closing_price_observations ("watchId", "attemptedAt");
CREATE TABLE closing_price_budgets (
  day TEXT PRIMARY KEY CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  spent INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION closing_price_watch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['nextAttemptAt','leaseUntil','leaseToken','lastPhysicalAt','attempts','completedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['nextAttemptAt','leaseUntil','leaseToken','lastPhysicalAt','attempts','completedAt'])
     OR NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'closing watch context is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER closing_price_watch_immutable BEFORE UPDATE ON closing_price_watches
FOR EACH ROW EXECUTE FUNCTION closing_price_watch_immutable();
CREATE FUNCTION closing_price_observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'closing observation is immutable'; END $$;
CREATE TRIGGER closing_price_observation_immutable BEFORE UPDATE ON closing_price_observations
FOR EACH ROW EXECUTE FUNCTION closing_price_observation_immutable();
COMMIT;
