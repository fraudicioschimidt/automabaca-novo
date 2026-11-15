ALTER TABLE "telegram_media_albums" ADD COLUMN "captionEditedAt" TIMESTAMPTZ(3);
ALTER TABLE "telegram_reaction_states" ADD COLUMN "decisionAt" TIMESTAMPTZ(3);
