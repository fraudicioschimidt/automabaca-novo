-- Sticky Gemini: última combinação modelo+chave que funcionou (próxima tip começa por ela).
CREATE TABLE "llm_sticky_preferences" (
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_sticky_preferences_pkey" PRIMARY KEY ("provider")
);
