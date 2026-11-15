-- Números finais podem distinguir equipes reais (Racing 01 != Racing 02).
-- A canonicalização anterior apagava qualquer sufixo de 2-4 dígitos. Como o
-- restante do nome já está normalizado, basta restaurar o token original.
UPDATE "team_provider_aliases"
SET "providerNorm" = regexp_replace("providerNorm", '\s+$', '') || ' ' ||
  (regexp_match("providerName", '([0-9]{2,4})\s*$'))[1]
WHERE "providerName" ~ '[[:space:]][0-9]{2,4}[[:space:]]*$'
  AND "providerNorm" !~ ('(^| )' || (regexp_match("providerName", '([0-9]{2,4})\s*$'))[1] || '$');

UPDATE "team_identities"
SET "canonicalNorm" = regexp_replace("canonicalNorm", '\s+$', '') || ' ' ||
  (regexp_match("canonicalName", '([0-9]{2,4})\s*$'))[1]
WHERE "canonicalName" ~ '[[:space:]][0-9]{2,4}[[:space:]]*$'
  AND "canonicalNorm" !~ ('(^| )' || (regexp_match("canonicalName", '([0-9]{2,4})\s*$'))[1] || '$');
