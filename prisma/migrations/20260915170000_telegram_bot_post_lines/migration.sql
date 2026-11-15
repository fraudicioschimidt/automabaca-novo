BEGIN;
-- Uma mensagem por post: as apostas do mesmo post passam a compartilhar o messageId.
DROP INDEX "telegram_bot_posts_chatId_messageId_key";
CREATE INDEX "telegram_bot_posts_chatId_messageId_idx" ON "telegram_bot_posts" ("chatId", "messageId");
CREATE INDEX "telegram_bot_posts_chatId_replyToMessageId_idx" ON "telegram_bot_posts" ("chatId", "replyToMessageId");
ALTER TABLE "telegram_bot_posts"
  ADD COLUMN "selecao" TEXT,
  ADD COLUMN "maxBet" INTEGER CHECK ("maxBet" IS NULL OR "maxBet" >= 0),
  ADD COLUMN "maxBetCurrency" TEXT CHECK ("maxBetCurrency" IS NULL OR "maxBetCurrency" ~ '^[A-Z]{3}$');
UPDATE "telegram_bot_posts" p
   SET "selecao" = b."selecao"
  FROM "bets" b
 WHERE b."id" = p."betId" AND p."selecao" IS NULL;
COMMIT;
