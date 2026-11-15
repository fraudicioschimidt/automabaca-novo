CREATE TABLE "auth_device_sessions" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "auth_device_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_totp_credentials" (
    "username" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "enabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_totp_credentials_pkey" PRIMARY KEY ("username")
);

CREATE UNIQUE INDEX "auth_device_sessions_tokenHash_key" ON "auth_device_sessions"("tokenHash");
CREATE INDEX "auth_device_sessions_username_revokedAt_expiresAt_idx"
ON "auth_device_sessions"("username", "revokedAt", "expiresAt");
CREATE INDEX "auth_device_sessions_expiresAt_idx" ON "auth_device_sessions"("expiresAt");
