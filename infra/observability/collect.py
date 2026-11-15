#!/usr/bin/env python3
"""Persist journal batches before advancing their cursor; safe to retry after a crash."""
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
import archive_common as common
from archive_sanitize import join_postgres_lines, normalize

MATCHES = ["CONTAINER_NAME=automabaca-novo-web", "CONTAINER_NAME=automabaca-novo-worker",
           "CONTAINER_NAME=automabaca-novo-db", "+", "_SYSTEMD_UNIT=caddy.service", "+", "SYSLOG_IDENTIFIER=systemd-journald", "+", "SYSLOG_IDENTIFIER=automabaca-log-archive"]
FIELDS = "__CURSOR,__REALTIME_TIMESTAMP,MESSAGE,CONTAINER_NAME,IMAGE_NAME,CONTAINER_PARTIAL_MESSAGE,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER"


def journal(args):
    result = subprocess.run(["journalctl", "--quiet", "--no-pager", "-o", "json", "--output-fields=" + FIELDS, *args],
                            capture_output=True, text=True, timeout=40)
    if result.returncode:
        raise RuntimeError("journal_read_failed")
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def persist_batch(rows, state, root=common.ROOT, state_dir=common.STATE):
    records = []
    last_by_source = dict(state.get("lastBySource", {}))
    for raw in join_postgres_lines(rows):
        record = normalize(raw)
        if record:
            recorded_at = common.stamp(dt.datetime.fromtimestamp(int(raw["__REALTIME_TIMESTAMP"]) / 1_000_000, dt.timezone.utc))
            record.update(timestamp=recorded_at, cursor=raw["__CURSOR"])
            records.append(record)
            last_by_source[record["service"]] = recorded_at
    if records:
        content = b"".join((json.dumps(record, separators=(",", ":")) + "\n").encode() for record in records)
        # A deterministic name makes replay after write-before-cursor crashes idempotent.
        identity = hashlib.sha256(content).hexdigest()
        first_at = common.parse_time(records[0]["timestamp"]).strftime("%Y%m%dT%H%M%S")
        target = root / f"logs-{first_at}-{identity[:16]}.jsonl.gz"
        if not target.exists():
            common.atomic_bytes(target, gzip.compress(content, mtime=0))
    if rows:
        state = {**state, "cursor": rows[-1]["__CURSOR"], "realtimeUsec": rows[-1]["__REALTIME_TIMESTAMP"]}
    state.update(lastBySource=last_by_source, collectedAt=common.stamp())
    common.atomic_json(state_dir / "cursor.json", state)
    return len(records), state


def main():
    os.umask(0o077)
    with (common.STATE / "collect.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        size = sum(p.stat().st_size for p in common.ROOT.glob("logs-*.jsonl.gz") if not p.is_symlink())
        if size >= common.MAX_ARCHIVE_BYTES or shutil.disk_usage(common.ROOT).free < 1024 ** 3:
            raise RuntimeError("archive_storage_limit")
        state = common.read_json(common.STATE / "cursor.json", {})
        args = ["--since", "24 hours ago"]
        if state.get("cursor"):
            try:
                probe = journal(["--cursor", state["cursor"], "--lines=+1"])
            except RuntimeError:
                probe = []
            if not probe or probe[0].get("__CURSOR") != state["cursor"]:
                state["gapDetectedAt"] = common.stamp()
                since = dt.datetime.fromtimestamp(int(state["realtimeUsec"]) / 1_000_000, dt.timezone.utc)
                args = ["--since", common.stamp(since)]
                common.event("LOG_ARCHIVE_CURSOR_GAP")
            else:
                args = ["--after-cursor", state["cursor"]]
        rows = journal([*args, "--lines=+10000", *MATCHES])
        count, state = persist_batch(rows, state)
        common.atomic_json(common.STATE / "collection.json", {
            "schemaVersion": 1, "ok": True, "observedAt": common.stamp(), "records": count,
            "archiveBytes": size, "maxArchiveBytes": common.MAX_ARCHIVE_BYTES,
            "retentionDays": common.RETENTION_DAYS, "backlog": len(rows) >= 10000,
            "gapDetectedAt": state.get("gapDetectedAt"), "lastBySource": state.get("lastBySource", {}),
        }, 0o644)
        common.event("LOG_ARCHIVE_COLLECTED", records=count)


if __name__ == "__main__":
    try:
        main()
    except BlockingIOError:
        pass
    except Exception as error:
        common.atomic_json(common.STATE / "collection.json", {"schemaVersion": 1, "ok": False, "observedAt": common.stamp(), "reason": str(error) if isinstance(error, RuntimeError) else type(error).__name__}, 0o644)
        common.event("LOG_ARCHIVE_COLLECTION_FAILED", reason=type(error).__name__)
        raise SystemExit(1)
