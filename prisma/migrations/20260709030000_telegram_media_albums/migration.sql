-- Debounce de álbum Telegram: uma tip por media_group_id.
CREATE TABLE "telegram_media_albums" (
    "mediaGroupId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "winnerMessageId" INTEGER NOT NULL,
    "winnerFileId" TEXT NOT NULL,
    "winnerCaption" TEXT NOT NULL DEFAULT '',
    "messageIds" INTEGER[],
    "postDate" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telegram_media_albums_pkey" PRIMARY KEY ("mediaGroupId")
);

CREATE INDEX "telegram_media_albums_chatId_status_expiresAt_idx"
  ON "telegram_media_albums"("chatId", "status", "expiresAt");
