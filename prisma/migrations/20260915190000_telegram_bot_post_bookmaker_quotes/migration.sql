BEGIN;
ALTER TABLE "telegram_bot_posts"
  ADD COLUMN "bookmakerQuotes" JSONB CHECK ("bookmakerQuotes" IS NULL OR jsonb_typeof("bookmakerQuotes") = 'array');
COMMIT;
