import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

const LOG_ARCHIVE_REASONS = ["collection_stale", "journal_gap_detected", "collection_backlog", "archive_space_low",
  "export_stale", "export_backlog", "offsite_pending", "offsite_invalid", "offsite_stale", "offsite_incomplete",
  "backup_failed", "backup_stale", "backup_offsite_stale", "watchdog_failed", "watchdog_unavailable"] as const;
export type LogArchiveReason = typeof LOG_ARCHIVE_REASONS[number];

const BACKUP_STATES = ["fresh", "failed", "stale"] as const;
/**
 * O backup diário do banco como o vigia do host o julgou (`infra/observability/watchdog.py`).
 * `createdAt` é o último pacote conferido; `bets`, as apostas que a cópia restaurada tinha;
 * `offsiteAt`, quando chegou o último comprovante válido da cópia no computador do dono.
 */
export type BackupHealth = {
  state: typeof BACKUP_STATES[number];
  createdAt: string | null;
  failedAt: string | null;
  bets: number | null;
  offsiteAt?: string | null;
};

export type LogArchiveHealth = {
  ok: boolean;
  collection: string;
  export: string;
  offsite: string;
  reasons: LogArchiveReason[];
  observedAt?: string;
  /** `null` quando o vigia ainda não lê o backup (versão anterior) ou o bloco veio malformado. */
  backup: BackupHealth | null;
};

function readInstant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function readBackup(value: unknown): BackupHealth | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const state = BACKUP_STATES.find((known) => known === v.state);
  if (!state) return null;
  return {
    state,
    createdAt: readInstant(v.createdAt),
    failedAt: readInstant(v.failedAt),
    bets: Number.isSafeInteger(v.bets) && (v.bets as number) >= 0 ? v.bets as number : null,
    offsiteAt: readInstant(v.offsiteAt),
  };
}

export async function readLogArchiveHealth(now = Date.now()): Promise<LogArchiveHealth> {
  const unavailable: LogArchiveHealth = { ok: false, collection: "unavailable", export: "unavailable", offsite: "unavailable", reasons: ["watchdog_unavailable"], backup: null };
  try {
    const file = await open(path.join(process.env.OBSERVABILITY_STATUS_DIR ?? "/data/observability-status", "status.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) return unavailable;
      data = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
    if (!data || typeof data !== "object") return unavailable;
    const v = data as Record<string, unknown>;
    const elapsed = typeof v.observedAt === "string" ? now - Date.parse(v.observedAt) : NaN;
    if (v.schemaVersion !== 1 || !Number.isFinite(elapsed) || elapsed < -60_000 || elapsed > 180_000
      || !Array.isArray(v.reasons) || !v.reasons.every((reason) => LOG_ARCHIVE_REASONS.includes(reason))
      || !["fresh", "degraded", "unavailable"].includes(String(v.collection))
      || !["fresh", "degraded", "unavailable"].includes(String(v.export))
      || !["fresh", "pending", "stale", "invalid", "incomplete", "unavailable"].includes(String(v.offsite))) return unavailable;
    const ok = v.ok === true && v.reasons.length === 0 && [v.collection, v.export, v.offsite].every((value) => value === "fresh");
    return { ok, collection: String(v.collection), export: String(v.export), offsite: String(v.offsite),
      reasons: ok ? [] : v.reasons.length ? v.reasons : ["watchdog_unavailable"], observedAt: String(v.observedAt),
      backup: readBackup(v.backup) };
  } catch { return unavailable; }
}
