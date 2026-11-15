-- Expande o envelope de proveniência para a PinBook sem alterar dados antigos.
-- @migration-compat previous-writer-shims

-- O writer anterior continua protegido pelo mesmo trigger. A única expansão é
-- aceitar o novo provider quando a referência e o envelope são completos.
CREATE OR REPLACE FUNCTION "automabaca_compat_price_writer_v0"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  opening_complete BOOLEAN;
  entry_complete BOOLEAN;
BEGIN
  IF current_setting('automabaca.writer_contract', true) IS DISTINCT FROM 'v2'
    OR current_setting('automabaca.price_contract', true) IS DISTINCT FROM 'v1' THEN
    opening_complete := NEW."openingOdd" IS NOT NULL
      AND NEW."openingRawOdd" IS NOT NULL
      AND NEW."openingPriceSnapshot" IS NOT NULL
      AND NEW."openingPriceObservedAt" IS NOT NULL
      AND NEW."provider" IN ('bridgeodds', 'pinnodds', 'pinbook', 'oddspapi')
      AND NEW."priceReference" IS NOT NULL;
    IF (NEW."openingOdd" IS NOT NULL OR NEW."openingRawOdd" IS NOT NULL
      OR NEW."openingPriceSnapshot" IS NOT NULL OR NEW."evAbertura" IS NOT NULL)
      AND NOT opening_complete THEN
      NEW."openingOdd" := NULL;
      NEW."openingRawOdd" := NULL;
      NEW."openingPriceSnapshot" := NULL;
      NEW."openingPriceObservedAt" := NULL;
      NEW."evAbertura" := NULL;
      NEW."openingMaxBet" := NULL;
      NEW."openingMaxBetCurrency" := NULL;
      NEW."noOddsReason" := COALESCE(NEW."noOddsReason", 'legacy_unverifiable_price');
    END IF;

    entry_complete := NEW."entryFairOdd" IS NOT NULL
      AND NEW."entryRawOdd" IS NOT NULL
      AND NEW."entryPriceSnapshot" IS NOT NULL
      AND NEW."entryPriceObservedAt" IS NOT NULL
      AND NEW."listedAtEntry" IS TRUE
      AND NEW."provider" IN ('bridgeodds', 'pinnodds', 'pinbook', 'oddspapi')
      AND NEW."priceReference" IS NOT NULL;
    IF (NEW."entryFairOdd" IS NOT NULL OR NEW."entryRawOdd" IS NOT NULL
      OR NEW."entryPriceSnapshot" IS NOT NULL OR NEW."evEntrada" IS NOT NULL
      OR NEW."houseEdgeBps" IS NOT NULL) AND NOT entry_complete THEN
      NEW."entryFairOdd" := NULL;
      NEW."entryRawOdd" := NULL;
      NEW."entryPriceSnapshot" := NULL;
      NEW."entryPriceObservedAt" := NULL;
      NEW."evEntrada" := NULL;
      NEW."houseEdgeBps" := NULL;
      NEW."entryMaxBet" := NULL;
      NEW."entryMaxBetCurrency" := NULL;
      NEW."listedAtEntry" := NULL;
      NEW."noOddsReason" := COALESCE(NEW."noOddsReason", 'legacy_unverifiable_price');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "bet_sharp_compat_price_writer_v0" ON "bet_sharp";
CREATE TRIGGER "bet_sharp_compat_price_writer_v0"
BEFORE INSERT OR UPDATE ON "bet_sharp"
FOR EACH ROW EXECUTE FUNCTION "automabaca_compat_price_writer_v0"();

CREATE OR REPLACE FUNCTION "automabaca_compat_closing_price_writer_v0"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('automabaca.writer_contract', true) IS DISTINCT FROM 'v2'
    OR current_setting('automabaca.price_contract', true) IS DISTINCT FROM 'v1' THEN
    IF NEW."closingOdd" IS NOT NULL OR NEW."closingRawOdd" IS NOT NULL
      OR NEW."closingPriceSnapshot" IS NOT NULL OR NEW."clv" IS NOT NULL THEN
      SELECT bs."priceReference" INTO NEW."closingPriceReference"
      FROM "bet_sharp" bs
      WHERE bs."betId" = NEW."betId" AND bs."provider" = NEW."provider";
      NEW."closingPriceObservedAt" := COALESCE(
        NEW."closingPriceObservedAt", NEW."fetchedAt", clock_timestamp()
      );
      IF NEW."closingOdd" IS NULL OR NEW."closingRawOdd" IS NULL
        OR NEW."closingPriceSnapshot" IS NULL OR NEW."provider" IS NULL
        OR NEW."closingPriceReference" IS NULL THEN
        NEW."closingOdd" := NULL;
        NEW."closingRawOdd" := NULL;
        NEW."closingPriceSnapshot" := NULL;
        NEW."closingPriceReference" := NULL;
        NEW."closingPriceObservedAt" := NULL;
        NEW."closingMaxBet" := NULL;
        NEW."closingMaxBetCurrency" := NULL;
        NEW."clv" := NULL;
        NEW."clvReliable" := FALSE;
        NEW."provider" := NULL;
        NEW."noOddsReason" := COALESCE(NEW."noOddsReason", 'legacy_unverifiable_price');
      END IF;
    ELSE
      NEW."closingPriceReference" := NULL;
      NEW."closingPriceObservedAt" := NULL;
      NEW."provider" := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "bet_closing_compat_price_writer_v0" ON "bet_closing";
CREATE TRIGGER "bet_closing_compat_price_writer_v0"
BEFORE INSERT OR UPDATE ON "bet_closing"
FOR EACH ROW EXECUTE FUNCTION "automabaca_compat_closing_price_writer_v0"();

ALTER TABLE "bet_sharp" DROP CONSTRAINT IF EXISTS "bet_sharp_price_provenance_check";
ALTER TABLE "bet_closing" DROP CONSTRAINT IF EXISTS "bet_closing_price_provenance_check";

ALTER TABLE "bet_sharp"
  ADD CONSTRAINT "bet_sharp_price_provenance_check"
  CHECK ((
    (
      "openingOdd" IS NULL AND "openingRawOdd" IS NULL
      AND "openingPriceSnapshot" IS NULL AND "openingPriceObservedAt" IS NULL
      AND "evAbertura" IS NULL AND "openingMaxBet" IS NULL
      AND "openingMaxBetCurrency" IS NULL
    ) OR (
      "openingOdd" IS NOT NULL AND "openingRawOdd" IS NOT NULL
      AND jsonb_typeof("openingPriceSnapshot") = 'object'
      AND "openingPriceSnapshot"->>'version' = '1'
      AND jsonb_typeof("openingPriceSnapshot"->'components') = 'array'
      AND "openingPriceObservedAt" IS NOT NULL
      AND (
        ("provider" = 'bridgeodds' AND "priceReference" ~ '^bridgeodds:v1:[^:]+$')
        OR ("provider" = 'pinnodds' AND "priceReference" ~ '^pinnodds:(main|corners|bookings|kills):[1-9][0-9]*$')
        OR ("provider" = 'pinbook' AND (
          "priceReference" ~ '^pinbook:v1:standard:[1-9][0-9]*:[^:]+:[^:]+:[^:]+:[^:]+$'
          OR "priceReference" ~ '^pinbook:v1:special:[1-9][0-9]*:[^:]+:[^:]+$'
        ))
        OR ("provider" = 'oddspapi' AND "priceReference" ~ '^oddspapi:v1:id[^:]+:[0-9]+:(-|[0-9]+):(-|[0-9]+):[^:]+$')
      )
    )
  ) AND (
    (
      "listedAtEntry" IS DISTINCT FROM TRUE
      AND "entryFairOdd" IS NULL AND "entryRawOdd" IS NULL
      AND "entryPriceSnapshot" IS NULL AND "entryPriceObservedAt" IS NULL
      AND "evEntrada" IS NULL AND "houseEdgeBps" IS NULL
      AND "entryMaxBet" IS NULL AND "entryMaxBetCurrency" IS NULL
    ) OR (
      "listedAtEntry" IS TRUE
      AND "entryFairOdd" IS NOT NULL AND "entryRawOdd" IS NOT NULL
      AND jsonb_typeof("entryPriceSnapshot") = 'object'
      AND "entryPriceSnapshot"->>'version' = '1'
      AND jsonb_typeof("entryPriceSnapshot"->'components') = 'array'
      AND "entryPriceObservedAt" IS NOT NULL
      AND (
        ("provider" = 'bridgeodds' AND "priceReference" ~ '^bridgeodds:v1:[^:]+$')
        OR ("provider" = 'pinnodds' AND "priceReference" ~ '^pinnodds:(main|corners|bookings|kills):[1-9][0-9]*$')
        OR ("provider" = 'pinbook' AND (
          "priceReference" ~ '^pinbook:v1:standard:[1-9][0-9]*:[^:]+:[^:]+:[^:]+:[^:]+$'
          OR "priceReference" ~ '^pinbook:v1:special:[1-9][0-9]*:[^:]+:[^:]+$'
        ))
        OR ("provider" = 'oddspapi' AND "priceReference" ~ '^oddspapi:v1:id[^:]+:[0-9]+:(-|[0-9]+):(-|[0-9]+):[^:]+$')
      )
    )
  ));

ALTER TABLE "bet_closing"
  ADD CONSTRAINT "bet_closing_price_provenance_check"
  CHECK (
    (
      "closingOdd" IS NULL AND "closingRawOdd" IS NULL
      AND "closingPriceSnapshot" IS NULL AND "closingPriceReference" IS NULL
      AND "closingPriceObservedAt" IS NULL AND "closingMaxBet" IS NULL
      AND "closingMaxBetCurrency" IS NULL AND "clv" IS NULL
      AND "clvReliable" IS DISTINCT FROM TRUE AND "provider" IS NULL
    ) OR (
      "closingOdd" IS NOT NULL AND "closingRawOdd" IS NOT NULL
      AND jsonb_typeof("closingPriceSnapshot") = 'object'
      AND "closingPriceSnapshot"->>'version' = '1'
      AND jsonb_typeof("closingPriceSnapshot"->'components') = 'array'
      AND "closingPriceObservedAt" IS NOT NULL
      AND (
        ("provider" = 'bridgeodds' AND "closingPriceReference" ~ '^bridgeodds:v1:[^:]+$')
        OR ("provider" = 'pinnodds' AND "closingPriceReference" ~ '^pinnodds:(main|corners|bookings|kills):[1-9][0-9]*$')
        OR ("provider" = 'pinbook' AND (
          "closingPriceReference" ~ '^pinbook:v1:standard:[1-9][0-9]*:[^:]+:[^:]+:[^:]+:[^:]+$'
          OR "closingPriceReference" ~ '^pinbook:v1:special:[1-9][0-9]*:[^:]+:[^:]+$'
        ))
        OR ("provider" = 'oddspapi' AND "closingPriceReference" ~ '^oddspapi:v1:id[^:]+:[0-9]+:(-|[0-9]+):(-|[0-9]+):[^:]+$')
      )
      AND ("clvReliable" IS DISTINCT FROM TRUE OR "clv" IS NOT NULL)
    )
  );
