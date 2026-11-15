-- A migration de precisão de 15/07 reconstituiu fair odds a partir de EV/CLV
-- arredondado e sobrescreveu a observação independente. Como não há coluna que
-- distinga o valor observado do reconstruído, toda fair de aposta que já
-- existia quando aquela migration terminou é insegura. Invalida somente os
-- derivados; odds raw, identidade, placar e resultado permanecem intactos.
--
-- O cutoff vem do ledger, não do nome/data do diretório. Isso também protege um
-- restore antigo no qual todas as migrations sejam reaplicadas em outra data.
DO $migration$
DECLARE
  bad_migration_finished_at TIMESTAMPTZ;
BEGIN
  SELECT max(finished_at)
  INTO bad_migration_finished_at
  FROM _prisma_migrations
  WHERE migration_name = '20260715123000_widen_ev_clv_precision'
    AND rolled_back_at IS NULL
    AND finished_at IS NOT NULL;

  IF bad_migration_finished_at IS NULL THEN
    RAISE EXCEPTION 'migration de origem sem finished_at no ledger';
  END IF;

  UPDATE "bet_sharp" AS s
  SET
    "entryFairOdd" = NULL,
    "evEntrada" = NULL,
    "openingOdd" = NULL,
    "evAbertura" = NULL,
    "listedAtEntry" = NULL,
    "noOddsReason" = COALESCE(s."noOddsReason", 'legacy_reconstructed_fair')
  FROM "bets" AS b
  WHERE b."id" = s."betId"
    AND b."registradoEm" <= bad_migration_finished_at
    AND (
      s."entryFairOdd" IS NOT NULL
      OR s."evEntrada" IS NOT NULL
      OR s."openingOdd" IS NOT NULL
      OR s."evAbertura" IS NOT NULL
    );

  UPDATE "bet_closing" AS c
  SET
    "closingOdd" = NULL,
    "clv" = NULL,
    "clvReliable" = false,
    "noOddsReason" = COALESCE(c."noOddsReason", 'legacy_reconstructed_fair')
  FROM "bets" AS b
  WHERE b."id" = c."betId"
    AND b."registradoEm" <= bad_migration_finished_at
    AND (c."closingOdd" IS NOT NULL OR c."clv" IS NOT NULL);
END
$migration$;
