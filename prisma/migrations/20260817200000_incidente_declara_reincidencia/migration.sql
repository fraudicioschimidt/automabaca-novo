-- Um incidente que volta depois de resolvido deixa de se disfarçar de novo.
--
-- Até aqui, `reportOperationalActionWithExisting` reabria a ação escrevendo
-- `openedAt = now()`. O campo que diz "desde quando este problema existe" era
-- reescrito exatamente no instante em que a resposta ficava interessante.
-- Medido na produção em 17/08/2026: 33 ações com a idade apagada, 4 delas
-- abertas agora. "Alerta de infraestrutura" nasceu em 13/07, acumulou 40
-- ocorrências e 7 ciclos de fechamento, e a tela publicava "desde há 17 h".
--
-- A reparação não inventa nada: o valor corrompido de `openedAt` É o início do
-- ciclo atual, que é o que `reopenedAt` passa a significar. O valor verdadeiro
-- de primeira-vez é `createdAt`, imutável por construção. Nada se perde — os
-- dois instantes só vão para o campo que os nomeia.

ALTER TABLE "operational_actions"
  ADD COLUMN "reopenedAt" TIMESTAMPTZ(3),
  ADD COLUMN "reopenCount" INTEGER NOT NULL DEFAULT 0;

-- As duas atribuições leem a linha ANTIGA: `reopenedAt` recebe o `openedAt`
-- corrompido antes de `openedAt` ser corrigido, no mesmo UPDATE.
UPDATE "operational_actions"
SET "reopenedAt" = "openedAt",
    "openedAt"   = "createdAt"
WHERE "openedAt" > "createdAt" + INTERVAL '2 seconds';

-- Quantas vezes voltou, recuperado do log de auditoria — a história existia,
-- só não estava na linha. Cada fechamento gravado que foi SEGUIDO de retorno é
-- uma reabertura: se a ação está ativa agora, todos os fechamentos foram
-- seguidos de retorno; se está encerrada, o último não foi.
--
-- É um PISO, e o motivo é datável: `audit_events` de `operational_action`
-- começam em 02/08/2026, enquanto a ação mais antiga é de 09/07. Ciclos
-- anteriores a 02/08 não deixaram registro e não são recuperáveis. O `openedAt`
-- reescrito prova pelo menos um retorno mesmo sem evento, e entra como piso do
-- piso. A partir daqui a contagem é exata: o incremento acontece no ato.
UPDATE "operational_actions" a
SET "reopenCount" = GREATEST(
  0,
  CASE
    WHEN a.status IN ('OPEN', 'ACKED', 'RUNNING') THEN f.ciclos
    ELSE f.ciclos - 1
  END
)
FROM (
  SELECT e."resourceId" AS id, count(*)::int AS ciclos
  FROM "audit_events" e
  WHERE e.resource = 'operational_action'
    AND e.action IN (
      'operational_action.resolved',
      'operational_action.auto_resolved',
      'operational_action.dismissed'
    )
  GROUP BY e."resourceId"
) f
WHERE f.id = a.id;

-- O piso do piso: `reopenedAt` preenchido acima prova um retorno mesmo quando
-- nenhum evento sobreviveu para contá-lo.
UPDATE "operational_actions"
SET "reopenCount" = 1
WHERE "reopenedAt" IS NOT NULL
  AND "reopenCount" = 0;
