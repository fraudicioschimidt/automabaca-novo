-- Última tentativa de buscar placar na BridgeOdds (throttle ~60min no closing.sync).
ALTER TABLE "bet_closing" ADD COLUMN "scoreCheckedAt" TIMESTAMPTZ(3);
