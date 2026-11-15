-- Consolida MercadoPadrao legado → labels finais Pinnacle (Config = o que a tip grava).
-- Espelha automabaca-v2/20260618150000 + amplia Soccer Total/AH e sport-aware no histórico.

DO $$
DECLARE
  pair record;
  source_id text;
  target_id text;
BEGIN
  -- 1) Pares 1:1 (sport-independente): corners/cards/legado → final
  FOR pair IN
    SELECT *
    FROM (VALUES
      ('1st Half Asian Corners', 'Handicap (Corners) – 1st Half', '1st half asian corners'),
      ('Asian Handicap Cards', 'Handicap (Bookings) – Match', 'asian handicap cards'),
      ('Asian Handicap Corners', 'Handicap (Corners) – Match', 'asian handicap corners'),
      ('Asian Total Cards', 'Total (Bookings) – Match', 'asian total cards'),
      ('Asian Total Corners', 'Total (Corners) – Match', 'asian total corners'),
      ('Cards', 'Total (Bookings) – Match', 'cards'),
      ('Cards O/U', 'Total (Bookings) – Match', 'cards o u'),
      ('Corners', 'Total (Corners) – Match', 'corners'),
      ('Corners O/U', 'Total (Corners) – Match', 'corners o u'),
      ('Total Cards', 'Total (Bookings) – Match', 'total cards')
    ) AS p(source_name, target_name, source_key)
  LOOP
    INSERT INTO "mercados_padrao" ("id", "nome", "ativo")
    VALUES ('pinnacle-market-' || md5(pair.target_name), pair.target_name, true)
    ON CONFLICT ("nome") DO UPDATE SET "ativo" = true;

    SELECT "id" INTO target_id FROM "mercados_padrao" WHERE "nome" = pair.target_name;

    UPDATE "bets"
    SET "mercado" = pair.target_name, "updatedAt" = now()
    WHERE "mercado" = pair.source_name;

    DELETE FROM "market_segment_policies" old
    USING "market_segment_policies" target
    WHERE old."mercado" = pair.source_name
      AND target."mercado" = pair.target_name
      AND target."esporte" = old."esporte";

    UPDATE "market_segment_policies"
    SET "mercado" = pair.target_name, "updatedAt" = now()
    WHERE "mercado" = pair.source_name;

    INSERT INTO "mercados_alias" (
      "id", "alias", "aliasNormalizado", "casaDeAposta", "mercadoPadraoId"
    )
    VALUES (
      'pinnacle-alias-' || md5(pair.target_name || '|' || pair.source_name || '|'),
      pair.source_name,
      pair.source_key,
      '',
      target_id
    )
    ON CONFLICT ("aliasNormalizado", "casaDeAposta", "mercadoPadraoId") DO NOTHING;

    SELECT "id" INTO source_id FROM "mercados_padrao" WHERE "nome" = pair.source_name;
    IF source_id IS NULL OR source_id = target_id THEN
      CONTINUE;
    END IF;

    UPDATE "mercados_alias" a
    SET "mercadoPadraoId" = target_id
    WHERE a."mercadoPadraoId" = source_id
      AND NOT EXISTS (
        SELECT 1 FROM "mercados_alias" existing
        WHERE existing."mercadoPadraoId" = target_id
          AND existing."aliasNormalizado" = a."aliasNormalizado"
          AND existing."casaDeAposta" = a."casaDeAposta"
      );

    DELETE FROM "mercados_alias" WHERE "mercadoPadraoId" = source_id;
    DELETE FROM "mercados_padrao" WHERE "id" = source_id;
  END LOOP;

  -- 2) Asian Handicap / Total genéricos → finais por esporte no histórico
  INSERT INTO "mercados_padrao" ("id", "nome", "ativo") VALUES
    ('pinnacle-market-' || md5('Handicap – Match'), 'Handicap – Match', true),
    ('pinnacle-market-' || md5('Total – Match'), 'Total – Match', true),
    ('pinnacle-market-' || md5('Point Spread'), 'Point Spread', true),
    ('pinnacle-market-' || md5('Run Line'), 'Run Line', true),
    ('pinnacle-market-' || md5('Puck Line'), 'Puck Line', true),
    ('pinnacle-market-' || md5('Match Winner'), 'Match Winner', true),
    ('pinnacle-market-' || md5('Money Line – Match'), 'Money Line – Match', true),
    ('pinnacle-market-' || md5('Handicap (Games) – Match'), 'Handicap (Games) – Match', true),
    ('pinnacle-market-' || md5('Total (Games) – Match'), 'Total (Games) – Match', true),
    ('pinnacle-market-' || md5('Team Total (Games) – Match'), 'Team Total (Games) – Match', true),
    ('pinnacle-market-' || md5('1st Half Total Points'), '1st Half Total Points', true),
    ('pinnacle-market-' || md5('Team Total'), 'Team Total', true),
    ('pinnacle-market-' || md5('Handicap (Sets) – Match'), 'Handicap (Sets) – Match', true)
  ON CONFLICT ("nome") DO UPDATE SET "ativo" = true;

  -- Soccer / futebol
  UPDATE "bets" SET "mercado" = 'Handicap – Match', "updatedAt" = now()
  WHERE "mercado" = 'Asian Handicap'
    AND lower("esporte") IN ('soccer', 'futebol', 'football');
  UPDATE "bets" SET "mercado" = 'Total – Match', "updatedAt" = now()
  WHERE "mercado" = 'Total'
    AND lower("esporte") IN ('soccer', 'futebol', 'football');

  -- Basketball
  UPDATE "bets" SET "mercado" = 'Point Spread', "updatedAt" = now()
  WHERE "mercado" = 'Asian Handicap'
    AND lower("esporte") IN ('basketball', 'basquete', 'basquetebol');
  UPDATE "bets" SET "mercado" = 'Total Points', "updatedAt" = now()
  WHERE "mercado" = 'Total'
    AND lower("esporte") IN ('basketball', 'basquete', 'basquetebol');
  UPDATE "bets" SET "mercado" = '1st Half Total Points', "updatedAt" = now()
  WHERE "mercado" = '1st Half Total'
    AND lower("esporte") IN ('basketball', 'basquete', 'basquetebol');

  -- Tennis
  UPDATE "bets" SET "mercado" = 'Match Winner', "updatedAt" = now()
  WHERE "mercado" = 'Moneyline'
    AND lower("esporte") IN ('tennis', 'tenis');
  UPDATE "bets" SET "mercado" = 'Handicap (Games) – Match', "updatedAt" = now()
  WHERE "mercado" = 'Asian Handicap'
    AND lower("esporte") IN ('tennis', 'tenis');
  UPDATE "bets" SET "mercado" = 'Total (Games) – Match', "updatedAt" = now()
  WHERE "mercado" = 'Total'
    AND lower("esporte") IN ('tennis', 'tenis');
  UPDATE "bets" SET "mercado" = 'Team Total (Games) – Match', "updatedAt" = now()
  WHERE "mercado" = 'Team Total'
    AND lower("esporte") IN ('tennis', 'tenis');

  -- Baseball / Hockey / American Football / Esports
  UPDATE "bets" SET "mercado" = 'Run Line', "updatedAt" = now()
  WHERE "mercado" = 'Asian Handicap' AND lower("esporte") = 'baseball';
  UPDATE "bets" SET "mercado" = 'Puck Line', "updatedAt" = now()
  WHERE "mercado" = 'Asian Handicap' AND lower("esporte") IN ('hockey', 'hoquei');
  UPDATE "bets" SET "mercado" = 'Point Spread', "updatedAt" = now()
  WHERE "mercado" = 'Asian Handicap'
    AND lower("esporte") LIKE '%american%';
  UPDATE "bets" SET "mercado" = 'Money Line – Match', "updatedAt" = now()
  WHERE "mercado" = 'Moneyline' AND lower("esporte") LIKE '%sport%';
  UPDATE "bets" SET "mercado" = 'Handicap – Match', "updatedAt" = now()
  WHERE "mercado" = 'Asian Handicap' AND lower("esporte") LIKE '%sport%';
  UPDATE "bets" SET "mercado" = 'Total – Match', "updatedAt" = now()
  WHERE "mercado" = 'Total' AND lower("esporte") LIKE '%sport%';

  -- Segment policies: mesmos remaps (esporte já está na linha)
  UPDATE "market_segment_policies" SET "mercado" = 'Handicap – Match', "updatedAt" = now()
  WHERE "mercado" = 'Asian Handicap'
    AND lower("esporte") IN ('soccer', 'futebol', 'football');
  UPDATE "market_segment_policies" SET "mercado" = 'Total – Match', "updatedAt" = now()
  WHERE "mercado" = 'Total'
    AND lower("esporte") IN ('soccer', 'futebol', 'football');
  UPDATE "market_segment_policies" SET "mercado" = 'Point Spread', "updatedAt" = now()
  WHERE "mercado" = 'Asian Handicap'
    AND lower("esporte") IN ('basketball', 'basquete', 'basquetebol');
  UPDATE "market_segment_policies" SET "mercado" = 'Total Points', "updatedAt" = now()
  WHERE "mercado" = 'Total'
    AND lower("esporte") IN ('basketball', 'basquete', 'basquetebol');

  -- 3) Mover aliases de Asian Handicap / Total legados para os finais Soccer (default Config)
  SELECT "id" INTO target_id FROM "mercados_padrao" WHERE "nome" = 'Handicap – Match';
  SELECT "id" INTO source_id FROM "mercados_padrao" WHERE "nome" = 'Asian Handicap';
  IF source_id IS NOT NULL AND target_id IS NOT NULL AND source_id <> target_id THEN
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

  SELECT "id" INTO target_id FROM "mercados_padrao" WHERE "nome" = 'Total – Match';
  SELECT "id" INTO source_id FROM "mercados_padrao" WHERE "nome" = 'Total';
  IF source_id IS NOT NULL AND target_id IS NOT NULL AND source_id <> target_id THEN
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

  -- Total Points já é final (basquete) — manter MercadoPadrao se existir
END $$;
