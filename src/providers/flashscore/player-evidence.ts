import { ProviderCadenceDeferredError, ProviderRequestError } from "@/src/domain/provider-error";
import { pgPool } from "@/src/infra/prisma";
import { getFlashscoreMatchLineups, getFlashscoreMatchPlayerStats } from "./client";
import { flashscoreLineupsSchema } from "./lineups";
import { flashscorePlayerStatsResponseSchema } from "./player-stats";

/** Shared cache + PostgreSQL lock coalesce web, worker and every bet in a fixture. */
export async function getFlashscorePlayerEvidence(matchId: string) {
  const key = `player-evidence:v1:${matchId}`;
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired", [key]);
    if (!lock.rows[0]?.acquired) throw new ProviderCadenceDeferredError("flashscore", new Date(Date.now() + 60_000));
    const cached = await client.query<{ payload: { stats: unknown; lineups: unknown }; fetchedAt: Date }>(
      'SELECT payload,"fetchedAt" FROM provider_caches WHERE provider=$1 AND key=$2 AND "expiresAt">now()',
      ["flashscore", key],
    );
    const row = cached.rows[0];
    if (row) {
      const stats = flashscorePlayerStatsResponseSchema.parse(row.payload.stats);
      const lineups = flashscoreLineupsSchema.parse(row.payload.lineups);
      await client.query("COMMIT");
      return { stats, lineups, fetchedAt: row.fetchedAt };
    }
    const stats = await getFlashscoreMatchPlayerStats(matchId);
    const lineups = await getFlashscoreMatchLineups(matchId);
    if (!stats || !lineups) throw new ProviderRequestError("flashscore.player-evidence", { error: "Flashscore não retornou evidência de jogadores." });
    const fetchedAt = new Date();
    await client.query(`INSERT INTO provider_caches (provider,key,payload,"fetchedAt","expiresAt","updatedAt")
      VALUES ($1,$2,$3::jsonb,$4,$4::timestamptz + interval '2 minutes',$4)
      ON CONFLICT (provider,key) DO UPDATE SET payload=EXCLUDED.payload,"fetchedAt"=EXCLUDED."fetchedAt","expiresAt"=EXCLUDED."expiresAt","updatedAt"=EXCLUDED."updatedAt"`,
    ["flashscore", key, JSON.stringify({ stats, lineups }), fetchedAt]);
    await client.query("COMMIT");
    return { stats, lineups, fetchedAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
