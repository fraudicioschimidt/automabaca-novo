CREATE INDEX "audit_events_actor_action_createdAt_idx" ON "audit_events"("actor", "action", "createdAt");

CREATE INDEX "audit_events_resource_resourceId_action_createdAt_idx" ON "audit_events"("resource", "resourceId", "action", "createdAt" DESC);
