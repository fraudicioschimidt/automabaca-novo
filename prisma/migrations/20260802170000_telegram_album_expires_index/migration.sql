-- Expiração global filtra/ordena apenas por expiresAt; o índice composto por
-- chatId/status não atende esse acesso por causa do prefixo B-tree.
CREATE INDEX "telegram_media_albums_expiresAt_idx"
  ON "telegram_media_albums"("expiresAt");
