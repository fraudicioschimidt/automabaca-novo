-- Invariantes de produto persistidos no PostgreSQL. A migration e somente
-- forward: primeiro repara o legado, depois fecha as novas escritas.
-- @migration-compat previous-writer-shims

ALTER TABLE "bet_sharp"
  ADD COLUMN "openingMaxBetCurrency" TEXT,
  ADD COLUMN "entryMaxBetCurrency" TEXT,
  ADD COLUMN "openingPriceObservedAt" TIMESTAMPTZ(3),
  ADD COLUMN "entryPriceObservedAt" TIMESTAMPTZ(3),
  ADD COLUMN "openingPriceSnapshot" JSONB,
  ADD COLUMN "entryPriceSnapshot" JSONB;

ALTER TABLE "bet_closing"
  ADD COLUMN "closingMaxBetCurrency" TEXT,
  ADD COLUMN "closingPriceSnapshot" JSONB;

-- Compatibilidade de UMA release: conexões v2 declaram o GUC no pool e recebem
-- rejeição normal dos CHECKs. A release anterior não conhece o GUC; os triggers
-- convertem somente seus payloads conhecidos durante rolling deploy/rollback.
CREATE FUNCTION "automabaca_compat_bet_writer_v1"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_settled_at TIMESTAMPTZ;
BEGIN
  IF current_setting('automabaca.writer_contract', true) IS DISTINCT FROM 'v2' THEN
    IF TG_OP = 'UPDATE' THEN previous_settled_at := OLD."settledAt"; END IF;
    IF NEW."status" = 'PENDING' THEN
      NEW."settledAt" := NULL;
    ELSIF NEW."settledAt" IS NULL THEN
      NEW."settledAt" := COALESCE(previous_settled_at, clock_timestamp());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "bets_compat_writer_v1"
BEFORE INSERT OR UPDATE OF "status", "settledAt" ON "bets"
FOR EACH ROW EXECUTE FUNCTION "automabaca_compat_bet_writer_v1"();

CREATE FUNCTION "automabaca_compat_sharp_writer_v1"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  has_entry_metric BOOLEAN;
BEGIN
  IF current_setting('automabaca.writer_contract', true) IS DISTINCT FROM 'v2' THEN
    NEW."confidence" := GREATEST(0, LEAST(100, NEW."confidence"));
    has_entry_metric := NEW."entryFairOdd" IS NOT NULL
      OR NEW."entryRawOdd" IS NOT NULL
      OR NEW."evEntrada" IS NOT NULL
      OR NEW."houseEdgeBps" IS NOT NULL
      OR NEW."entryMaxBet" IS NOT NULL
      OR NEW."entryMaxBetCurrency" IS NOT NULL
      OR NEW."entryPriceObservedAt" IS NOT NULL
      OR NEW."entryPriceSnapshot" IS NOT NULL;
    IF has_entry_metric
      AND NEW."entryFairOdd" IS NOT NULL
      AND NEW."entryRawOdd" IS NOT NULL THEN
      NEW."listedAtEntry" := TRUE;
    ELSIF has_entry_metric THEN
      NEW."listedAtEntry" := NULL;
      NEW."entryFairOdd" := NULL;
      NEW."entryRawOdd" := NULL;
      NEW."evEntrada" := NULL;
      NEW."houseEdgeBps" := NULL;
      NEW."entryMaxBet" := NULL;
      NEW."entryMaxBetCurrency" := NULL;
      NEW."entryPriceObservedAt" := NULL;
      NEW."entryPriceSnapshot" := NULL;
    ELSIF NEW."listedAtEntry" IS TRUE THEN
      NEW."listedAtEntry" := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "bet_sharp_compat_writer_v1"
BEFORE INSERT OR UPDATE ON "bet_sharp"
FOR EACH ROW EXECUTE FUNCTION "automabaca_compat_sharp_writer_v1"();

CREATE FUNCTION "automabaca_compat_alias_writer_v1"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('automabaca.writer_contract', true) IS DISTINCT FROM 'v2' THEN
    NEW."confidence" := GREATEST(0, LEAST(100, NEW."confidence"));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "team_aliases_compat_writer_v1"
BEFORE INSERT OR UPDATE OF "confidence" ON "team_aliases"
FOR EACH ROW EXECUTE FUNCTION "automabaca_compat_alias_writer_v1"();

CREATE TRIGGER "team_provider_aliases_compat_writer_v1"
BEFORE INSERT OR UPDATE OF "confidence" ON "team_provider_aliases"
FOR EACH ROW EXECUTE FUNCTION "automabaca_compat_alias_writer_v1"();

CREATE FUNCTION "automabaca_compat_closing_writer_v1"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('automabaca.writer_contract', true) IS DISTINCT FROM 'v2'
    AND NEW."resultMatchConfidence" IS NOT NULL
    AND (NEW."resultMatchConfidence" < 0 OR NEW."resultMatchConfidence" > 1) THEN
    NEW."resultMatchConfidence" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "bet_closing_compat_writer_v1"
BEFORE INSERT OR UPDATE OF "resultMatchConfidence" ON "bet_closing"
FOR EACH ROW EXECUTE FUNCTION "automabaca_compat_closing_writer_v1"();

CREATE FUNCTION "automabaca_compat_training_writer_v1"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('automabaca.writer_contract', true) IS DISTINCT FROM 'v2' THEN
    NEW."autoScore" := GREATEST(0, LEAST(100, NEW."autoScore"));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_cases_compat_writer_v1"
BEFORE INSERT OR UPDATE OF "autoScore" ON "training_cases"
FOR EACH ROW EXECUTE FUNCTION "automabaca_compat_training_writer_v1"();

ALTER TABLE "bet_sharp"
  ADD CONSTRAINT "bet_sharp_max_bet_currency_check"
  CHECK (
    ("openingMaxBetCurrency" IS NULL OR (
      "openingMaxBet" IS NOT NULL AND "openingMaxBetCurrency" ~ '^[A-Z]{3}$'
    ))
    AND
    ("entryMaxBetCurrency" IS NULL OR (
      "entryMaxBet" IS NOT NULL AND "entryMaxBetCurrency" ~ '^[A-Z]{3}$'
    ))
  );

ALTER TABLE "bet_closing"
  ADD CONSTRAINT "bet_closing_max_bet_currency_check"
  CHECK (
    "closingMaxBetCurrency" IS NULL OR (
      "closingMaxBet" IS NOT NULL AND "closingMaxBetCurrency" ~ '^[A-Z]{3}$'
    )
  );

-- A liquidacao pertence ao instante da primeira saida de PENDING. Quando ha
-- evento auditavel, ele e a melhor fonte; updatedAt e o fallback conservador
-- para linhas anteriores ao ledger de settlement.
UPDATE "bets" AS b
SET "settledAt" = COALESCE(
  (
    SELECT MIN(se."createdAt")
    FROM "settlement_events" AS se
    WHERE se."betId" = b."id"
      AND se."type" = 'STATUS_CHANGED'
      AND se."payload"->>'to' <> 'PENDING'
  ),
  b."updatedAt",
  b."registradoEm"
)
WHERE b."status" <> 'PENDING'
  AND b."settledAt" IS NULL;

UPDATE "bets"
SET "settledAt" = NULL
WHERE "status" = 'PENDING'
  AND "settledAt" IS NOT NULL;

ALTER TABLE "bets"
  ADD CONSTRAINT "bets_status_settled_at_check"
  CHECK (
    ("status" = 'PENDING' AND "settledAt" IS NULL)
    OR ("status" <> 'PENDING' AND "settledAt" IS NOT NULL)
  );

-- listedAtEntry=true e a evidencia minima para qualquer metrica que descreva
-- a cotacao da entrada. Opening e identidade pertencem a outros instantes e
-- por isso nao sao apagados.
UPDATE "bet_sharp"
SET
  "entryFairOdd" = NULL,
  "entryRawOdd" = NULL,
  "evEntrada" = NULL,
  "houseEdgeBps" = NULL,
  "entryMaxBet" = NULL,
  "entryMaxBetCurrency" = NULL,
  "entryPriceObservedAt" = NULL,
  "entryPriceSnapshot" = NULL
WHERE "listedAtEntry" IS DISTINCT FROM TRUE;

UPDATE "bet_sharp"
SET "listedAtEntry" = NULL
WHERE "listedAtEntry" IS TRUE
  AND ("entryFairOdd" IS NULL OR "entryRawOdd" IS NULL);

ALTER TABLE "bet_sharp"
  ADD CONSTRAINT "bet_sharp_entry_metrics_require_listing_check"
  CHECK (
    ("listedAtEntry" IS TRUE
      AND "entryFairOdd" IS NOT NULL
      AND "entryRawOdd" IS NOT NULL)
    OR (
      "listedAtEntry" IS DISTINCT FROM TRUE
      AND "entryFairOdd" IS NULL
      AND "entryRawOdd" IS NULL
      AND "evEntrada" IS NULL
      AND "houseEdgeBps" IS NULL
      AND "entryMaxBet" IS NULL
      AND "entryMaxBetCurrency" IS NULL
      AND "entryPriceObservedAt" IS NULL
      AND "entryPriceSnapshot" IS NULL
    )
  );

-- Confianças precisam permanecer nos domínios declarados mesmo em SQL direto.
UPDATE "bet_sharp"
SET "confidence" = GREATEST(0, LEAST(100, "confidence"));

UPDATE "team_aliases"
SET "confidence" = GREATEST(0, LEAST(100, "confidence"));

UPDATE "team_provider_aliases"
SET "confidence" = GREATEST(0, LEAST(100, "confidence"));

UPDATE "training_cases"
SET "autoScore" = GREATEST(0, LEAST(100, "autoScore"));

UPDATE "bet_closing"
SET "resultMatchConfidence" = NULL
WHERE "resultMatchConfidence" < 0 OR "resultMatchConfidence" > 1;

ALTER TABLE "bet_sharp"
  ADD CONSTRAINT "bet_sharp_confidence_check"
  CHECK ("confidence" >= 0 AND "confidence" <= 100);

ALTER TABLE "team_aliases"
  ADD CONSTRAINT "team_aliases_confidence_check"
  CHECK ("confidence" >= 0 AND "confidence" <= 100);

ALTER TABLE "team_provider_aliases"
  ADD CONSTRAINT "team_provider_aliases_confidence_check"
  CHECK ("confidence" >= 0 AND "confidence" <= 100);

ALTER TABLE "bet_closing"
  ADD CONSTRAINT "bet_closing_result_match_confidence_check"
  CHECK (
    "resultMatchConfidence" IS NULL
    OR ("resultMatchConfidence" >= 0 AND "resultMatchConfidence" <= 1)
  );

ALTER TABLE "training_cases"
  ADD CONSTRAINT "training_cases_auto_score_check"
  CHECK ("autoScore" >= 0 AND "autoScore" <= 100);
