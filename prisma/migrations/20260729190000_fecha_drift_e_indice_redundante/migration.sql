-- Drift permanente entre banco e schema + índice 100% redundante.
-- Auditoria externa 006, achados 10 e 11.
--
-- O drift não era cosmético: `prisma migrate dev` arrastava estas três
-- diferenças para dentro de QUALQUER migration nova, o que obrigou a escrever a
-- migration de idempotência do ledger à mão em 29/07/2026. Drift que ninguém
-- fecha também mascara o próximo drift — que pode ser real.

-- 1) `telegram_dm_drafts.id` nasceu UUID na migration e TEXT no schema. As
--    outras ~18 tabelas usam TEXT; o valor é gerado pelo Prisma (`uuid()`),
--    então o tipo nativo não comprava nada.
ALTER TABLE "telegram_dm_drafts" DROP CONSTRAINT "telegram_dm_drafts_pkey",
  ALTER COLUMN "id" SET DATA TYPE TEXT,
  ADD CONSTRAINT "telegram_dm_drafts_pkey" PRIMARY KEY ("id");

-- 2) `@updatedAt` do Prisma é aplicado no cliente; sem DEFAULT no banco, um
--    INSERT por SQL cru (migration, backfill, psql) falha por NOT NULL.
ALTER TABLE "ia_judge_cooldowns" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "telegram_media_albums" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- 3) Índice não-único subsumido pelo unique das MESMAS colunas na MESMA ordem:
--    todo INSERT/UPDATE de identidade pagava duas manutenções de índice e WAL
--    dobrado no caminho quente do matching, sem plano novo em troca.
DROP INDEX IF EXISTS "team_identities_canonicalNorm_sport_pais_idx";
