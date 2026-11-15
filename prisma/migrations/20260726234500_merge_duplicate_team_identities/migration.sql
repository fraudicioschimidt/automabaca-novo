-- Mescla identidades duplicadas do MESMO clube e impede que voltem.
--
-- Duas causas geravam duplicata, ambas corrigidas no código deste commit:
--   1. o caminho do FlashScore passava o nome já corrigido pela Pinnacle
--      ("Hull City") como se fosse o nome local; a busca por alias LOCAL
--      procurava `hull city`, o existente era `hull`, e criava outro clube;
--   2. `team_aliases` é escopado por competição e cada alias legado amarrava
--      uma identidade — o mesmo clube em dois campeonatos virava dois times.
--
-- O estrago: `team_provider_alias.conflict`. O id do provider fica preso numa
-- cópia enquanto a aposta resolve para a outra, e a liquidação trava sem nunca
-- se resolver sozinha (visto em 23, 24 e 26/07/2026).

-- Grupos por (nome canônico, esporte, país) + os três pares de grafia
-- diferente que o dono confirmou serem o mesmo clube em 26/07/2026.
CREATE TEMP TABLE grupo_identidade AS
SELECT id,
       CASE
         WHEN "canonicalNorm" IN ('aalesund', 'aalesunds') THEN 'aalesund'
         WHEN "canonicalNorm" IN ('viking', 'viking fk') THEN 'viking'
         WHEN "canonicalNorm" IN ('radcliffe', 'radcliffe fc') THEN 'radcliffe'
         ELSE "canonicalNorm"
       END AS chave,
       sport,
       pais,
       "legacyTeamAliasId",
       "createdAt"
FROM team_identities;

-- Sobrevivente: quem carrega mais id de provider (vínculo mais forte, porque é
-- chave exata e não nome), depois o mais antigo.
CREATE TEMP TABLE sobrevivente AS
SELECT DISTINCT ON (g.chave, g.sport, g.pais) g.id, g.chave, g.sport, g.pais
FROM grupo_identidade g
LEFT JOIN team_provider_aliases a
  ON a."teamIdentityId" = g.id AND a."providerTeamId" IS NOT NULL
GROUP BY g.chave, g.sport, g.pais, g.id, g."createdAt"
ORDER BY g.chave, g.sport, g.pais, count(a.id) DESC, g."createdAt" ASC;

CREATE TEMP TABLE fusao AS
SELECT g.id AS perdedor, s.id AS vencedor
FROM grupo_identidade g
JOIN sobrevivente s
  ON s.chave = g.chave AND s.sport = g.sport AND s.pais = g.pais
WHERE g.id <> s.id;

-- 1. Alias que colidiria com um do vencedor some: mesma (provider, id, esporte)
--    é o MESMO vínculo, e o unique da tabela recusaria a movimentação.
DELETE FROM team_provider_aliases perdido
USING fusao f
WHERE perdido."teamIdentityId" = f.perdedor
  AND perdido."providerTeamId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM team_provider_aliases mantido
    WHERE mantido."teamIdentityId" = f.vencedor
      AND mantido.provider = perdido.provider
      AND mantido."providerTeamId" = perdido."providerTeamId"
      AND mantido.sport = perdido.sport
  );

-- 2. Grafia repetida sem id de provider também não precisa ser movida duas vezes.
DELETE FROM team_provider_aliases perdido
USING fusao f
WHERE perdido."teamIdentityId" = f.perdedor
  AND perdido."providerTeamId" IS NULL
  AND EXISTS (
    SELECT 1 FROM team_provider_aliases mantido
    WHERE mantido."teamIdentityId" = f.vencedor
      AND mantido.provider = perdido.provider
      AND mantido."providerNorm" = perdido."providerNorm"
      AND mantido.sport = perdido.sport
      AND mantido.pais = perdido.pais
      AND mantido."competitionNorm" = perdido."competitionNorm"
  );

-- 3. O que sobrou passa para o vencedor: é o vínculo que só ele tinha.
UPDATE team_provider_aliases a
SET "teamIdentityId" = f.vencedor
FROM fusao f
WHERE a."teamIdentityId" = f.perdedor;

-- 4. Vínculo legado migra quando o vencedor não tem um. Sem isto o alias legado
--    ficaria órfão e a sincronização criaria a duplicata de novo — agora o
--    código também procura pelo nome canônico, mas manter o vínculo evita a
--    volta desnecessária.
-- Em três passos porque o vínculo é UNIQUE: enquanto o perdedor o segura, o
-- vencedor não pode recebê-lo. `DISTINCT ON` garante um doador por vencedor.
CREATE TEMP TABLE doacao_legado AS
SELECT DISTINCT ON (f.vencedor) f.vencedor, f.perdedor, p."legacyTeamAliasId" AS legado
FROM fusao f
JOIN team_identities p ON p.id = f.perdedor
JOIN team_identities v ON v.id = f.vencedor
WHERE v."legacyTeamAliasId" IS NULL
  AND p."legacyTeamAliasId" IS NOT NULL
ORDER BY f.vencedor, p."createdAt" ASC;

UPDATE team_identities SET "legacyTeamAliasId" = NULL
WHERE id IN (SELECT perdedor FROM doacao_legado);

UPDATE team_identities v
SET "legacyTeamAliasId" = d.legado
FROM doacao_legado d
WHERE v.id = d.vencedor;

DROP TABLE doacao_legado;

DELETE FROM team_identities t USING fusao f WHERE t.id = f.perdedor;

DROP TABLE fusao;
DROP TABLE sobrevivente;
DROP TABLE grupo_identidade;

-- Rede de segurança: agora que os dois caminhos procuram antes de criar, o
-- banco recusa o que escapar. Só pega grafia idêntica — variações como
-- "Viking"/"Viking FK" continuam dependendo do código e da revisão humana.
CREATE UNIQUE INDEX "team_identities_canonicalNorm_sport_pais_key"
  ON team_identities ("canonicalNorm", sport, pais);
