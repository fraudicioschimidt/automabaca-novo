-- A ação nova é hard-delete. A coluna fica por uma release para que o runtime
-- anterior continue conseguindo LER durante migrate-before-reload, mas nenhum
-- writer (antigo ou novo) pode criar outro tombstone. NOT VALID preserva apenas
-- as linhas legadas já existentes; a limpeza delas é uma operação destrutiva
-- separada, depois de autorização e inventário em produção.
ALTER TABLE "bankrolls"
  ADD CONSTRAINT "bankrolls_deletedAt_legacy_only"
  CHECK ("deletedAt" IS NULL) NOT VALID;
