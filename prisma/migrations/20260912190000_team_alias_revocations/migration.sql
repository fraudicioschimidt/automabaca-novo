CREATE TABLE "team_alias_revocations" (
  "id" TEXT NOT NULL,
  "originalAliasId" TEXT NOT NULL,
  "targetIdentityId" TEXT NOT NULL,
  "targetCanonicalName" TEXT NOT NULL,
  "targetCanonicalNorm" TEXT NOT NULL,
  "targetCountry" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerName" TEXT NOT NULL,
  "providerNorm" TEXT NOT NULL,
  "providerTeamId" TEXT,
  "sport" TEXT NOT NULL,
  "pais" TEXT NOT NULL DEFAULT '',
  "competitionNorm" TEXT NOT NULL DEFAULT '',
  "competitionName" TEXT,
  "reason" TEXT NOT NULL,
  "revokedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "restoredAt" TIMESTAMPTZ(3),
  "restoredBy" TEXT,
  CONSTRAINT "team_alias_revocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "team_alias_revocations_reason_check" CHECK (length(btrim("reason")) BETWEEN 3 AND 500),
  CONSTRAINT "team_alias_revocations_restore_check" CHECK (("restoredAt" IS NULL) = ("restoredBy" IS NULL))
);
CREATE UNIQUE INDEX "team_alias_revocations_originalAliasId_key" ON "team_alias_revocations"("originalAliasId");
CREATE INDEX "team_alias_revocations_provider_sport_restoredAt_idx" ON "team_alias_revocations"("provider", "sport", "restoredAt");

-- Uma única regra para writers normais, varredura, backfill e a guarda física.
-- ID externo é único por provider/esporte: mudar de competição não muda o time.
-- Sem ID correspondente, o nome só é recusado no mesmo alvo/contexto.
-- Contexto vazio é desconhecido: não permite contornar uma correção conhecida.
CREATE FUNCTION team_provider_alias_is_revoked(
  identity_id text, provider_name text, alias_norm text, external_id text,
  sport_name text, country_name text, competition_norm text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_alias_revocations r
    JOIN team_identities i ON i.id = identity_id
    WHERE r."restoredAt" IS NULL AND r.provider = provider_name AND r.sport = sport_name
      AND (r."targetIdentityId" = i.id OR
        (r."targetCanonicalNorm" = i."canonicalNorm" AND r."targetCountry" = i.pais))
      AND (
        (r."providerTeamId" IS NOT NULL AND r."providerTeamId" = external_id)
        OR (r."providerNorm" = alias_norm
          AND (r.pais = '' OR country_name = '' OR r.pais = country_name)
          AND (r."competitionNorm" = '' OR competition_norm = '' OR r."competitionNorm" = competition_norm))
      )
  )
$$;

-- Writers compartilham a trava; revogar/desfazer usa a trava exclusiva.
-- São operações raras de curadoria, não leituras nem chamadas a providers.
CREATE FUNCTION guard_team_provider_alias_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('alias-revocation:' || NEW.provider || ':' || NEW.sport, 0));
  IF team_provider_alias_is_revoked(NEW."teamIdentityId", NEW.provider, NEW."providerNorm",
      NEW."providerTeamId", NEW.sport, NEW.pais, NEW."competitionNorm") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'team_provider_alias_revoked',
      MESSAGE = 'team_provider_alias_revoked';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER team_provider_alias_revocation_guard
  BEFORE INSERT OR UPDATE OF "teamIdentityId", provider, "providerNorm", "providerTeamId", sport, pais, "competitionNorm", source
  ON team_provider_aliases FOR EACH ROW EXECUTE FUNCTION guard_team_provider_alias_revocation();

CREATE FUNCTION lock_team_alias_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('alias-revocation:' || NEW.provider || ':' || NEW.sport, 0));
  RETURN NEW;
END
$$;
CREATE TRIGGER team_alias_revocation_lock BEFORE INSERT OR UPDATE ON team_alias_revocations
  FOR EACH ROW EXECUTE FUNCTION lock_team_alias_revocation();

-- Remove inclusive uma duplicata inserida antes de a revogação adquirir a trava.
CREATE FUNCTION remove_revoked_team_provider_aliases() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."restoredAt" IS NULL THEN
    DELETE FROM team_provider_aliases a WHERE a.provider = NEW.provider AND a.sport = NEW.sport
      AND team_provider_alias_is_revoked(a."teamIdentityId", a.provider, a."providerNorm",
        a."providerTeamId", a.sport, a.pais, a."competitionNorm");
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER team_alias_revocation_remove AFTER INSERT OR UPDATE OF "restoredAt" ON team_alias_revocations
  FOR EACH ROW EXECUTE FUNCTION remove_revoked_team_provider_aliases();
