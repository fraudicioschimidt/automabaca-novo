-- Updates de canal por hora, contados na entrada do webhook: o vigia de
-- silêncio compara o canal com o próprio ritmo. Tabela nova, sem dado antigo.
CREATE TABLE "telegram_channel_activity" (
    "chatId" BIGINT NOT NULL,
    "hour" TIMESTAMPTZ(3) NOT NULL,
    "posts" INTEGER NOT NULL DEFAULT 0,
    "edits" INTEGER NOT NULL DEFAULT 0,
    "reactions" INTEGER NOT NULL DEFAULT 0,
    "lastUpdateAt" TIMESTAMPTZ(3) NOT NULL,
    "lastPostAt" TIMESTAMPTZ(3),

    CONSTRAINT "telegram_channel_activity_pkey" PRIMARY KEY ("chatId","hour")
);

CREATE INDEX "telegram_channel_activity_hour_idx" ON "telegram_channel_activity"("hour");
