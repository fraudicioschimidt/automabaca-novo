-- eSports: Total (Kills) – Map N (UI Pinnacle). Aliases PT via seed.

DO $$
DECLARE
  map_n int;
  market_name text;
BEGIN
  FOR map_n IN 1..5 LOOP
    market_name := 'Total (Kills) – Map ' || map_n;
    INSERT INTO "mercados_padrao" ("id", "nome", "ativo")
    VALUES ('pinnacle-market-' || md5(market_name), market_name, true)
    ON CONFLICT ("nome") DO UPDATE SET "ativo" = true;
  END LOOP;

  UPDATE "bets"
  SET "mercado" = 'Total (Kills) – Map 1', "updatedAt" = now()
  WHERE "mercado" IN ('Primeiro mapa - total kills', '1º mapa - total kills');
  UPDATE "bets"
  SET "mercado" = 'Total (Kills) – Map 2', "updatedAt" = now()
  WHERE "mercado" IN ('Segundo mapa - total kills', '2º mapa - total kills');
  UPDATE "bets"
  SET "mercado" = 'Total (Kills) – Map 3', "updatedAt" = now()
  WHERE "mercado" IN ('Terceiro mapa - total kills', '3º mapa - total kills');
  UPDATE "bets"
  SET "mercado" = 'Total (Kills) – Map 4', "updatedAt" = now()
  WHERE "mercado" IN ('Quarto mapa - total kills', '4º mapa - total kills');
  UPDATE "bets"
  SET "mercado" = 'Total (Kills) – Map 5', "updatedAt" = now()
  WHERE "mercado" IN ('Quinto mapa - total kills', '5º mapa - total kills');
END $$;
