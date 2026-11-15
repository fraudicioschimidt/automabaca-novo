-- Estado de autorização não deve depender de scan na tabela geral de auditoria.
CREATE TABLE "auth_session_state" (
  "username" TEXT NOT NULL,
  "epoch" BIGINT NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_session_state_pkey" PRIMARY KEY ("username")
);

-- Preserva cookies atuais durante o deploy ao migrar a época mais recente.
INSERT INTO "auth_session_state" ("username", "epoch", "updatedAt")
SELECT DISTINCT ON ("actor")
  "actor",
  ("details"->>'epoch')::BIGINT,
  "createdAt"
FROM "audit_events"
WHERE "action" = 'auth.session_epoch'
  AND "details"->>'epoch' ~ '^[0-9]+$'
ORDER BY "actor", "createdAt" DESC
ON CONFLICT ("username") DO NOTHING;

-- Cada passo TOTP aceito é consumido atomicamente uma única vez.
ALTER TABLE "auth_totp_credentials"
ADD COLUMN "lastUsedCounter" BIGINT;
