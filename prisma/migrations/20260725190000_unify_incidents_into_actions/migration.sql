-- Incidente deixa de ser entidade e vira uma escrita na caixa de ações.
--
-- Até aqui existiam DUAS caixas para o mesmo problema: `incidents` (aberto/
-- reconhecido/resolvido) e `operational_actions`, com um espelhamento que
-- copiava cada incidente para uma ação. A ação sempre foi um superconjunto do
-- incidente (área, tipo, prioridade e risco além de tudo que o incidente tinha),
-- então o incidente virou `area = 'incidentes'` na caixa de ações.
--
-- A fingerprint do incidente já usava exatamente o mesmo algoritmo da ação
-- (`fonte:sha256(fonte\0chave)`), então cada linha migra com a chave que ela já
-- tinha — o próximo alerta da mesma condição reencontra a linha em vez de
-- duplicar.

-- 1. Traz o histórico e o que está aberto para a caixa única.
INSERT INTO "operational_actions" (
  "id", "fingerprint", "area", "actionType", "title", "description",
  "priority", "risk", "status", "resource", "resourceId", "owner",
  "evidence", "occurrenceCount", "openedAt", "lastSeenAt",
  "acknowledgedAt", "resolvedAt", "resolutionNote", "createdAt", "updatedAt"
)
SELECT
  i."id",
  i."fingerprint",
  'incidentes',
  'incident.review',
  i."title",
  i."description",
  CASE i."severity" WHEN 'CRITICAL' THEN 95 WHEN 'WARNING' THEN 70 ELSE 35 END,
  (CASE i."severity" WHEN 'CRITICAL' THEN 'CRITICAL' WHEN 'WARNING' THEN 'MEDIUM' ELSE 'LOW' END)::"OperationalRisk",
  i."status"::text::"OperationalActionStatus",
  i."resource",
  i."resourceId",
  i."owner",
  -- `autoResolve = false` (exige decisão humana) passa a viajar na evidência,
  -- que é onde a reconciliação automática o lê.
  CASE WHEN i."autoResolve" THEN i."evidence"
       ELSE COALESCE(i."evidence", '{}'::jsonb) || '{"autoResolve": false}'::jsonb END,
  i."occurrenceCount",
  i."openedAt",
  i."lastSeenAt",
  i."acknowledgedAt",
  i."resolvedAt",
  i."resolutionNote",
  i."createdAt",
  i."updatedAt"
FROM "incidents" i
ON CONFLICT ("fingerprint") DO NOTHING;

-- 2. Remove as cópias do espelhamento: mesma condição, chave do esquema morto.
DELETE FROM "operational_actions" WHERE "fingerprint" LIKE 'incident:%';

DROP TABLE IF EXISTS "incidents";
DROP TYPE IF EXISTS "IncidentStatus";
DROP TYPE IF EXISTS "IncidentSeverity";

-- Planos de comando (preview + hash + execução em duas etapas) saem junto: a
-- indireção só existia para dar rastro a uma execução que hoje é um clique
-- direto na ação, com o mesmo registro em audit_events.
DROP TABLE IF EXISTS "command_plans";
DROP TYPE IF EXISTS "CommandPlanStatus";
