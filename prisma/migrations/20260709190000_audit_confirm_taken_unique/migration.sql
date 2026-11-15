-- Idempotência atômica de confirmBetTaken: no máximo um bet.confirm_taken por aposta.
-- Índice parcial único — só a action de confirmação; demais audit_events livres.
CREATE UNIQUE INDEX IF NOT EXISTS "audit_events_bet_confirm_taken_uidx"
ON "audit_events" ("resourceId")
WHERE "resource" = 'bet' AND "action" = 'bet.confirm_taken';
