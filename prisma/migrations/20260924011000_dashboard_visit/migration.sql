-- Última visita de cada operador ao dashboard: o resumo "desde a última
-- visita" conta a partir dela. Tabela nova, sem dado antigo.
CREATE TABLE "dashboard_visits" (
    "username" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dashboard_visits_pkey" PRIMARY KEY ("username")
);
