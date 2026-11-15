import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLogArchiveHealth } from "@/src/infra/observability-status";

const original = process.env.OBSERVABILITY_STATUS_DIR;
const dirs: string[] = [];
afterEach(async () => {
  if (original === undefined) delete process.env.OBSERVABILITY_STATUS_DIR;
  else process.env.OBSERVABILITY_STATUS_DIR = original;
  for (const dir of dirs.splice(0)) safeRemoveTreeSync(tmpdir(), dir);
});
it("fails closed for missing, stale or inconsistent health; preserves actionable reasons", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "automabaca-log-status-")); dirs.push(dir);
  process.env.OBSERVABILITY_STATUS_DIR = dir;
  const now = Date.now();
  expect((await readLogArchiveHealth(now)).reasons).toEqual(["watchdog_unavailable"]);
  const status = { schemaVersion: 1, observedAt: new Date(now).toISOString(), ok: false, collection: "fresh", export: "fresh", offsite: "pending", reasons: ["offsite_pending"] };
  await writeFile(path.join(dir, "status.json"), JSON.stringify(status));
  expect((await readLogArchiveHealth(now)).reasons).toEqual(["offsite_pending"]);
  expect((await readLogArchiveHealth(now + 181_000)).reasons).toEqual(["watchdog_unavailable"]);
  await writeFile(path.join(dir, "status.json"), JSON.stringify({ ...status, ok: true, offsite: "fresh", reasons: [] }));
  expect((await readLogArchiveHealth(now)).ok).toBe(true);
  await writeFile(path.join(dir, "status.json"), JSON.stringify({ ...status, ok: true, reasons: [] }));
  expect((await readLogArchiveHealth(now)).ok).toBe(false);
});
it("rejects a linked status file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "automabaca-log-status-")); dirs.push(dir);
  process.env.OBSERVABILITY_STATUS_DIR = dir;
  await writeFile(path.join(dir, "target.json"), '{}');
  await symlink(path.join(dir, "target.json"), path.join(dir, "status.json"));
  expect((await readLogArchiveHealth()).reasons).toEqual(["watchdog_unavailable"]);
});
it("reads the backup verdict the watchdog wrote, and tolerates a watchdog that does not write it yet", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "automabaca-log-status-")); dirs.push(dir);
  process.env.OBSERVABILITY_STATUS_DIR = dir;
  const now = Date.now();
  const status = { schemaVersion: 1, observedAt: new Date(now).toISOString(), ok: true, collection: "fresh", export: "fresh", offsite: "fresh", reasons: [] };
  await writeFile(path.join(dir, "status.json"), JSON.stringify(status));
  expect(await readLogArchiveHealth(now)).toMatchObject({ ok: true, backup: null });

  const backup = { state: "failed", createdAt: "2026-09-23T04:21:00Z", failedAt: "2026-09-24T04:19:00Z", bets: 1234 };
  await writeFile(path.join(dir, "status.json"), JSON.stringify({ ...status, ok: false, reasons: ["backup_failed"], backup }));
  expect(await readLogArchiveHealth(now)).toMatchObject({ ok: false, reasons: ["backup_failed"], backup });

  // Bloco malformado não derruba a leitura dos logs: só o backup fica sem leitura.
  await writeFile(path.join(dir, "status.json"), JSON.stringify({ ...status, reasons: [], backup: { ...backup, state: "unknown" } }));
  expect(await readLogArchiveHealth(now)).toMatchObject({ ok: true, backup: null });
  await writeFile(path.join(dir, "status.json"), JSON.stringify({ ...status, backup: { state: "fresh", createdAt: "ontem", failedAt: 3, bets: -1 } }));
  expect((await readLogArchiveHealth(now)).backup).toEqual({ state: "fresh", createdAt: null, failedAt: null, bets: null, offsiteAt: null });
  // A cópia no computador que parou é uma razão conhecida, com a hora do último comprovante.
  await writeFile(path.join(dir, "status.json"), JSON.stringify({ ...status, ok: false, reasons: ["backup_offsite_stale"],
    backup: { ...backup, state: "fresh", offsite: "stale", offsiteAt: "2026-10-02T06:30:00Z" } }));
  expect(await readLogArchiveHealth(now)).toMatchObject({
    ok: false, reasons: ["backup_offsite_stale"], backup: { state: "fresh", offsiteAt: "2026-10-02T06:30:00Z" },
  });
});
