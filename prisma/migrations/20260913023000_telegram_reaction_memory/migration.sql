BEGIN;
CREATE TABLE "telegram_reaction_states" (
  "chatId" BIGINT NOT NULL,
  "messageId" INTEGER NOT NULL CHECK ("messageId" > 0),
  "bankrollId" TEXT NOT NULL REFERENCES bankrolls(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "targetMessageId" INTEGER NOT NULL CHECK ("targetMessageId" > 0),
  "actorUserId" TEXT,
  "decision" TEXT,
  "occurredAt" TIMESTAMPTZ(3),
  "updateId" BIGINT,
  "handledAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("chatId", "messageId"),
  CHECK (("decision" IS NULL AND "actorUserId" IS NULL AND "occurredAt" IS NULL AND "updateId" IS NULL AND "handledAt" IS NULL)
    OR ("decision" IS NOT NULL AND "decision" IN ('NOT_TAKEN','TAKEN','NEUTRAL') AND "actorUserId" IS NOT NULL AND "actorUserId" ~ '^[1-9][0-9]*$' AND "occurredAt" IS NOT NULL AND "updateId" IS NOT NULL AND "updateId" >= 0))
);
CREATE INDEX "telegram_reaction_states_chatId_bankrollId_targetMessageId_idx"
  ON "telegram_reaction_states" ("chatId", "bankrollId", "targetMessageId");
COMMIT;
