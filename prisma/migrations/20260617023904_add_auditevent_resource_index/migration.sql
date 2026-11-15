-- CreateIndex
CREATE INDEX "audit_events_resource_resourceId_action_idx" ON "audit_events"("resource", "resourceId", "action");
