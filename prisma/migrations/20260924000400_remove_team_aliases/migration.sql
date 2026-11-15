-- @migration-manual: apaga a tabela legada team_aliases; só depois do deploy que parou de usá-la e do ops-migrar-aliases-legados --aplicar
-- Em produção, em 23/09/2026: 404 aliases legados, todos os MANUAL com
-- contraparte MANUAL no canônico; o ops-migrar-aliases-legados --aplicar
-- completou os 2 que faltavam e deu id próprio às 801 projeções.

-- As projeções `legacy-*` só somem quando o backfill roda: sem ele, esta
-- migration apagaria a última cópia do que faltava no canônico.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "team_provider_aliases" WHERE "id" LIKE 'legacy-%') THEN
    RAISE EXCEPTION 'rode ops-migrar-aliases-legados --aplicar antes de apagar team_aliases';
  END IF;
END
$$;

DROP TABLE "team_aliases";
ALTER TABLE "team_identities" DROP COLUMN "legacyTeamAliasId";
