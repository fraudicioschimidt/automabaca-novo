ALTER TABLE "bets"
  ADD COLUMN "liveScoreHome" INTEGER,
  ADD COLUMN "liveScoreAway" INTEGER;

ALTER TABLE "bets"
  ADD CONSTRAINT "bets_live_score_pair_check"
  CHECK (
    ("liveScoreHome" IS NULL AND "liveScoreAway" IS NULL)
    OR
    (
      "liveScoreHome" IS NOT NULL
      AND "liveScoreAway" IS NOT NULL
      AND
      "liveScoreHome" BETWEEN 0 AND 500
      AND "liveScoreAway" BETWEEN 0 AND 500
    )
  );

CREATE FUNCTION prevent_live_score_at_tip_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."liveScoreHome" IS NOT NULL
     AND (
       NEW."liveScoreHome" IS DISTINCT FROM OLD."liveScoreHome"
       OR NEW."liveScoreAway" IS DISTINCT FROM OLD."liveScoreAway"
     ) THEN
    RAISE EXCEPTION 'placar live da aposta % é imutável', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bets_live_score_at_tip_immutable
BEFORE UPDATE OF "liveScoreHome", "liveScoreAway" ON "bets"
FOR EACH ROW
EXECUTE FUNCTION prevent_live_score_at_tip_rewrite();
