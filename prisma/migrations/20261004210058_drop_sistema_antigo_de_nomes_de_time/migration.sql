-- @migration-manual: apaga as quatro tabelas do sistema antigo de nomes de time, sem código desde a release anterior, com o sim do dono. Restam 6 identidades e 18 nomes aprendidos em 25/09/2026 pelo sistema antigo, que nada lê; saem junto
-- Os três triggers das tabelas saem com elas; as funções que só eles e o
-- código antigo chamavam ficariam órfãs, e saem depois das tabelas.

-- DropForeignKey
ALTER TABLE "team_provider_aliases" DROP CONSTRAINT "team_provider_aliases_teamIdentityId_fkey";

-- DropTable
DROP TABLE "match_cache";

-- DropTable
DROP TABLE "team_alias_revocations";

-- DropTable
DROP TABLE "team_identities";

-- DropTable
DROP TABLE "team_provider_aliases";

-- DropFunction
DROP FUNCTION "guard_team_provider_alias_revocation"();
DROP FUNCTION "lock_team_alias_revocation"();
DROP FUNCTION "remove_revoked_team_provider_aliases"();
DROP FUNCTION "team_provider_alias_is_revoked"(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
