-- Baseball: label final Pinnacle UI = "Handicap – Game" (não "Run Line").
-- Superbet PT: "Handicap (incl. entradas extras)" → mesmo canônico.

DO $$
DECLARE
  source_id text;
  target_id text;
BEGIN
  INSERT INTO "mercados_padrao" ("id", "nome", "ativo")
  VALUES (
    'pinnacle-market-' || md5('Handicap – Game'),
    'Handicap – Game',
    true
  )
  ON CONFLICT ("nome") DO UPDATE SET "ativo" = true;

  SELECT "id" INTO target_id FROM "mercados_padrao" WHERE "nome" = 'Handicap – Game';

  UPDATE "bets"
  SET "mercado" = 'Handicap – Game', "updatedAt" = now()
  WHERE "mercado" IN ('Run Line', 'Handicap (incl. entradas extras)', 'Handicap - Game');

  UPDATE "market_segment_policies"
  SET "mercado" = 'Handicap – Game', "updatedAt" = now()
  WHERE "mercado" IN ('Run Line', 'Handicap (incl. entradas extras)', 'Handicap - Game');

  -- Aliases canônicos + Superbet + legado Run Line
  -- "Handicap - Game" (hífen ASCII) normaliza para a mesma chave que "Handicap – Game".
  INSERT INTO "mercados_alias" (
    "id", "alias", "aliasNormalizado", "casaDeAposta", "mercadoPadraoId"
  )
  VALUES
    (
      'pinnacle-alias-' || md5('Handicap – Game|Handicap – Game|'),
      'Handicap – Game',
      'handicap game',
      '',
      target_id
    ),
    (
      'pinnacle-alias-' || md5('Handicap – Game|Handicap (incl. entradas extras)|'),
      'Handicap (incl. entradas extras)',
      'handicap incl entradas extras',
      '',
      target_id
    ),
    (
      'pinnacle-alias-' || md5('Handicap – Game|Handicap (incl. extra innings)|'),
      'Handicap (incl. extra innings)',
      'handicap incl extra innings',
      '',
      target_id
    ),
    (
      'pinnacle-alias-' || md5('Handicap – Game|Run Line|'),
      'Run Line',
      'run line',
      '',
      target_id
    )
  ON CONFLICT ("aliasNormalizado", "casaDeAposta", "mercadoPadraoId") DO NOTHING;

  -- Consolida MercadoPadrao legado "Run Line" → Handicap – Game
  SELECT "id" INTO source_id FROM "mercados_padrao" WHERE "nome" = 'Run Line';
  IF source_id IS NOT NULL AND source_id <> target_id THEN
    UPDATE "mercados_alias" a
    SET "mercadoPadraoId" = target_id
    WHERE a."mercadoPadraoId" = source_id
      AND NOT EXISTS (
        SELECT 1 FROM "mercados_alias" e
        WHERE e."mercadoPadraoId" = target_id
          AND e."aliasNormalizado" = a."aliasNormalizado"
          AND e."casaDeAposta" = a."casaDeAposta"
      );
    DELETE FROM "mercados_alias" WHERE "mercadoPadraoId" = source_id;
    DELETE FROM "mercados_padrao" WHERE "id" = source_id;
  END IF;
END $$;
