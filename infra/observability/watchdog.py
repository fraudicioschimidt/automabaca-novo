#!/usr/bin/env python3
"""Health independent of PostgreSQL and of the collector/exporter processes."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import stat
import archive_common as common

BACKUP_STATUS = Path("/var/lib/automabaca-novo/backup-status/status.json")
BACKUP_LATEST = Path("/srv/apps/automabaca-novo/exports/latest.json")
# The backup timer runs daily at 04:15 UTC (up to 10 min late) and a failed run
# is retried twice, 30 min apart: 26 h still covers the latest of those tries.
BACKUP_MAX_AGE_SECONDS = 26 * 3600
# The owner's computer pulls the package once a day (backup-windows.ps1) and
# sends this receipt back: 36 h forgives one late run, not a stopped task.
BACKUP_OFFSITE_RECEIPT = "windows-backup-receipt.json"
BACKUP_OFFSITE_MAX_AGE_SECONDS = 36 * 3600
BACKUP_PACKAGE_NAME = re.compile(r"automabaca-novo-recovery-\d{8}T\d{6}Z\.tar\.age")
SHA256 = re.compile(r"[a-f0-9]{64}")


def age_seconds(timestamp, current):
    try:
        return (current - common.parse_time(timestamp)).total_seconds()
    except (TypeError, ValueError, AttributeError):
        return float("inf")


def assess_backup(status, latest, current):
    """The daily database backup, from its status and the index of its encrypted package.

    `latest.json` changes only when a verified package is published, so it keeps
    the newest good backup even after later runs fail. `failed` is the last run;
    `stale` is what pages the owner, after the night's retries had their chance.
    """
    status = status if isinstance(status, dict) else {}
    created = latest.get("createdAt") if isinstance(latest, dict) else None
    age = age_seconds(created, current)
    failed = status.get("ok") is False
    stale = not -60 <= age <= BACKUP_MAX_AGE_SECONDS  # invalid or future evidence cannot prove freshness
    counts = status.get("counts") if status.get("ok") is True else None
    bets = counts.get("bets") if isinstance(counts, dict) else None
    failed_at = status.get("observedAt") if failed else None
    return {"state": "stale" if stale else "failed" if failed else "fresh",
            "reasons": [reason for reason, active in (("backup_failed", failed), ("backup_stale", stale)) if active],
            "createdAt": created if age != float("inf") else None,
            "failedAt": failed_at if age_seconds(failed_at, current) != float("inf") else None,
            "bets": bets if type(bets) is int and bets >= 0 else None}


def assess_backup_offsite(receipt, receipt_mtime, latest, current):
    """The copy of the daily package outside the VPS, from the receipt the owner's computer sends.

    Age is the receipt's arrival on this host (its mtime), not the sender's
    clock. A receipt naming the current package with another hash is no proof.
    """
    receipt = receipt if isinstance(receipt, dict) else {}
    name, sha = receipt.get("name"), receipt.get("sha256")
    valid = (receipt.get("schemaVersion") == 1 and receipt.get("project") == "automabaca-novo"
             and isinstance(name, str) and BACKUP_PACKAGE_NAME.fullmatch(name) is not None
             and isinstance(sha, str) and SHA256.fullmatch(sha) is not None)
    if valid and isinstance(latest, dict) and latest.get("name") == name and latest.get("sha256") != sha:
        valid = False
    fresh = valid and -60 <= current.timestamp() - receipt_mtime <= BACKUP_OFFSITE_MAX_AGE_SECONDS
    return {"offsite": "fresh" if fresh else "stale",
            "offsiteAt": common.stamp(dt.datetime.fromtimestamp(receipt_mtime, dt.timezone.utc)) if valid else None}


def assess(collection, export, receipt, index, receipt_mtime, backup_status, backup_latest,
           backup_receipt=None, backup_receipt_mtime=0, current=None):
    current = current or common.now()
    reasons = []
    if not collection or collection.get("ok") is not True or not -60 <= age_seconds(collection.get("observedAt"), current) < 180:
        reasons.append("collection_stale")
    elif collection.get("gapDetectedAt"):
        reasons.append("journal_gap_detected")
    elif collection.get("backlog"):
        reasons.append("collection_backlog")
    if collection and collection.get("archiveBytes", 0) >= common.MAX_ARCHIVE_BYTES * .85:
        reasons.append("archive_space_low")
    if not export or export.get("ok") is not True or not -60 <= age_seconds(export.get("observedAt"), current) < 90 * 60:
        reasons.append("export_stale")
    elif export.get("backlog"):
        reasons.append("export_backlog")
    offsite = "pending"
    bundles = {b["name"]: b for b in (index or {}).get("bundles", [])}
    if receipt:
        offsite = "invalid"
        verified = receipt.get("verified", [])
        valid = isinstance(verified, list) and 0 < len(verified) <= 10_000 and all(
            isinstance(item, dict) and isinstance(item.get("name"), str) and isinstance(item.get("sha256"), str)
            and (item["name"] not in bundles or item["sha256"] == bundles[item["name"]]["sha256"]) for item in verified)
        known = {item["name"] for item in verified if isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"] in bundles} if isinstance(verified, list) else set()
        if valid and known and receipt.get("schemaVersion") == 1 and receipt.get("project") == "automabaca-novo":
            through = max(bundles[name]["createdAt"] for name in known)
            stale = not -60 <= current.timestamp() - receipt_mtime <= 26 * 3600 or not -60 <= age_seconds(through, current) <= 26 * 3600
            complete = all(name in known for name, bundle in bundles.items() if bundle["createdAt"] <= through)
            offsite = "incomplete" if not complete else "stale" if stale else "fresh"
    if offsite != "fresh":
        reasons.append("offsite_" + offsite)
    backup = assess_backup(backup_status, backup_latest, current)
    reasons.extend(backup.pop("reasons"))
    backup.update(assess_backup_offsite(backup_receipt, backup_receipt_mtime, backup_latest, current))
    if backup["offsite"] != "fresh":
        reasons.append("backup_offsite_stale")
    return {"schemaVersion": 1, "ok": not reasons, "observedAt": common.stamp(current), "reasons": reasons,
            "collection": "fresh" if not any(x.startswith("collection") or x.startswith("journal") for x in reasons) else "degraded",
            "export": "fresh" if not any(x.startswith("export") for x in reasons) else "degraded", "offsite": offsite,
            "backup": backup, "retentionDays": common.RETENTION_DAYS}


def read_backup_file(path):
    """A broken backup file counts as missing: it must not blind the log checks."""
    try:
        return common.read_json(path)
    except (OSError, ValueError, RuntimeError):
        return None


def read_backup_receipt(path):
    """The receipt and when it arrived, both from the same open file."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None, 0
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65_536:
            return None, 0
        try:
            return json.load(handle), info.st_mtime
        except ValueError:
            return None, 0


def main():
    receipt_path = common.RECEIPTS / "windows-receipt.json"
    receipt = common.read_json(receipt_path)
    status = assess(common.read_json(common.STATE / "collection.json"), common.read_json(common.STATE / "export.json"),
                    receipt, common.read_json(common.EXPORTS / "index.json", max_bytes=8 * 1024 ** 2),
                    receipt_path.stat().st_mtime if receipt else 0,
                    read_backup_file(BACKUP_STATUS), read_backup_file(BACKUP_LATEST),
                    *read_backup_receipt(common.RECEIPTS / BACKUP_OFFSITE_RECEIPT))
    previous = common.read_json(common.STATE / "status.json", {})
    common.atomic_json(common.STATE / "status.json", status, 0o644)
    # Remain quiet while the condition is unchanged; emit failure or recovery once.
    if previous.get("reasons") != status["reasons"]:
        common.event("LOG_ARCHIVE_HEALTH_CHANGED", ok=status["ok"], reasons=status["reasons"])


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        common.atomic_json(common.STATE / "status.json", {"schemaVersion": 1, "ok": False, "observedAt": common.stamp(),
            "reasons": ["watchdog_failed"], "collection": "unavailable", "export": "unavailable", "offsite": "unavailable"}, 0o644)
        common.event("LOG_ARCHIVE_WATCHDOG_FAILED", reason=type(error).__name__)
        raise SystemExit(1)
