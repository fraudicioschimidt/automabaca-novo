CREATE TABLE "telegram_dm_drafts" (
  "id" UUID NOT NULL,
  "chatId" TEXT NOT NULL,
  "messageId" INTEGER NOT NULL,
  "parsedBet" JSONB NOT NULL,
  "caption" TEXT NOT NULL DEFAULT '',
  "imageFileId" TEXT,
  "postDate" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "telegram_dm_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_dm_drafts_chatId_messageId_key"
  ON "telegram_dm_drafts"("chatId", "messageId");
CREATE INDEX "telegram_dm_drafts_expiresAt_idx"
  ON "telegram_dm_drafts"("expiresAt");
