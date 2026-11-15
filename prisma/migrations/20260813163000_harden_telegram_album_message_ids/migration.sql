-- O Prisma e o serviço tratam messageIds como Int[] obrigatório e não vazio.
-- A DDL original omitiu NOT NULL; winnerMessageId é a evidência canônica para
-- reconciliar qualquer linha legada antes de fechar o contrato físico.
UPDATE "telegram_media_albums"
SET "messageIds" = ARRAY["winnerMessageId"]
WHERE "messageIds" IS NULL OR cardinality("messageIds") = 0;

-- Nesta release expand, CHECK validado entrega a mesma barreira de escrita sem
-- quebrar o rollback automático. O attnotnull pode ser consolidado numa fase
-- contract posterior, depois que esta versão já for a anterior segura.
ALTER TABLE "telegram_media_albums"
  ADD CONSTRAINT "telegram_media_albums_message_ids_not_null"
  CHECK ("messageIds" IS NOT NULL) NOT VALID;

ALTER TABLE "telegram_media_albums"
  VALIDATE CONSTRAINT "telegram_media_albums_message_ids_not_null";

ALTER TABLE "telegram_media_albums"
  ADD CONSTRAINT "telegram_media_albums_message_ids_nonempty"
  CHECK (cardinality("messageIds") > 0) NOT VALID;

ALTER TABLE "telegram_media_albums"
  VALIDATE CONSTRAINT "telegram_media_albums_message_ids_nonempty";
