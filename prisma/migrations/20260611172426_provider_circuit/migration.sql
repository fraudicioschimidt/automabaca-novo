-- CreateTable
CREATE TABLE "provider_circuits" (
    "provider" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLOSED',
    "failures" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_circuits_pkey" PRIMARY KEY ("provider")
);
