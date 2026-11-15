BEGIN;
CREATE TABLE "price_archive_usage" (
  "id" INTEGER PRIMARY KEY CHECK (id = 1),
  "bytes" BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  "observations" INTEGER NOT NULL DEFAULT 0 CHECK (observations >= 0),
  "intents" INTEGER NOT NULL DEFAULT 0 CHECK (intents >= 0)
);
INSERT INTO price_archive_usage (id) VALUES (1);
CREATE TABLE "price_archive_observations" (
  "id" UUID PRIMARY KEY,
  "provider" TEXT NOT NULL CHECK (provider IN ('pinnacle17', 'bridgeodds')),
  "endpoint" TEXT NOT NULL,
  "eventIds" TEXT[] NOT NULL CHECK (cardinality("eventIds") BETWEEN 1 AND 500),
  "requestedAt" TIMESTAMPTZ(3) NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "payload" BYTEA NOT NULL,
  "payloadBytes" INTEGER NOT NULL CHECK ("payloadBytes" = octet_length(payload) AND "payloadBytes" BETWEEN 1 AND 4194304),
  "unpackedBytes" INTEGER NOT NULL CHECK ("unpackedBytes" BETWEEN 1 AND 8388608),
  "sha256" TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CHECK ("requestedAt" <= "observedAt" AND "observedAt" < "expiresAt")
);
CREATE INDEX ON price_archive_observations (provider, "observedAt");
CREATE INDEX ON price_archive_observations USING gin ("eventIds");
CREATE INDEX ON price_archive_observations ("expiresAt");
CREATE TABLE "price_archive_intents" (
  "id" UUID PRIMARY KEY,
  "betId" TEXT NOT NULL REFERENCES bets(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "bankrollId" TEXT NOT NULL,
  "bankrollUpdatedAt" TIMESTAMPTZ(3) NOT NULL,
  "sourceHash" TEXT NOT NULL CHECK ("sourceHash" ~ '^[0-9a-f]{64}$'),
  "sourcePostedAt" TIMESTAMPTZ(3) NOT NULL,
  "mode" "SharpMode" NOT NULL CHECK (mode IN ('FULL', 'CLV_ONLY')),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "lastAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("createdAt" < "expiresAt"),
  UNIQUE ("betId", "sourceHash")
);
CREATE INDEX ON price_archive_intents ("lastAttemptAt", id);
CREATE INDEX ON price_archive_intents ("expiresAt");
CREATE FUNCTION price_archive_count_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'price_archive_observations' THEN
    IF TG_OP = 'INSERT' THEN
      UPDATE price_archive_usage SET bytes = bytes + NEW."payloadBytes", observations = observations + 1 WHERE id = 1;
    ELSE
      UPDATE price_archive_usage SET bytes = bytes - OLD."payloadBytes", observations = observations - 1 WHERE id = 1;
    END IF;
  ELSE
    UPDATE price_archive_usage SET intents = intents + CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END WHERE id = 1;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER price_archive_observation_count AFTER INSERT OR DELETE ON price_archive_observations FOR EACH ROW EXECUTE FUNCTION price_archive_count_rows();
CREATE TRIGGER price_archive_intent_count AFTER INSERT OR DELETE ON price_archive_intents FOR EACH ROW EXECUTE FUNCTION price_archive_count_rows();
CREATE FUNCTION price_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'price_archive_observations' OR
    (to_jsonb(NEW) - 'lastAttemptAt') IS DISTINCT FROM (to_jsonb(OLD) - 'lastAttemptAt') THEN
    RAISE EXCEPTION 'price archive evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_archive_observation_immutable BEFORE UPDATE ON price_archive_observations FOR EACH ROW EXECUTE FUNCTION price_archive_immutable();
CREATE TRIGGER price_archive_intent_immutable BEFORE UPDATE ON price_archive_intents FOR EACH ROW EXECUTE FUNCTION price_archive_immutable();
COMMIT;
