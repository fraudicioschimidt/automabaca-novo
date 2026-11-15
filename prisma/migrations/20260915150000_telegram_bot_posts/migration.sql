BEGIN;
CREATE TABLE "telegram_bot_posts" (
  "id" TEXT PRIMARY KEY,
  "betId" TEXT NOT NULL REFERENCES bets(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('PINNACLE_ODD')),
  "chatId" BIGINT NOT NULL,
  "replyToMessageId" INTEGER NOT NULL CHECK ("replyToMessageId" > 0),
  "messageId" INTEGER CHECK ("messageId" > 0),
  "status" TEXT NOT NULL DEFAULT 'RESERVED' CHECK ("status" IN ('RESERVED','SENT','FAILED')),
  "pinnacleRawOdd" DECIMAL(10,4),
  "tipsterOdd" DECIMAL(10,4),
  "error" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ(3),
  CHECK ("status" <> 'SENT' OR ("messageId" IS NOT NULL AND "sentAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "telegram_bot_posts_betId_kind_key" ON "telegram_bot_posts" ("betId", "kind");
CREATE UNIQUE INDEX "telegram_bot_posts_chatId_messageId_key" ON "telegram_bot_posts" ("chatId", "messageId");
COMMIT;
