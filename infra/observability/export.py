#!/usr/bin/env python3
"""Create encrypted, checksummed log bundles for the owner's Windows computer."""
import fcntl
import grp
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import archive_common as common

SEGMENT = re.compile(r"logs-\d{8}T\d{6}-[a-f0-9]{16}\.jsonl\.gz")
BUNDLE = re.compile(r"automabaca-logs-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.age")


def catalog(root=common.ROOT, exports=common.EXPORTS):
    bundles = []
    exported = set()
    for path in sorted((root / "bundles").glob("*.json")):
        item = common.read_json(path)
        target = exports / item["name"]
        if not BUNDLE.fullmatch(item["name"]) or not target.is_file() or target.is_symlink():
            raise RuntimeError("archive_catalog_incomplete")
        bundles.append({key: item[key] for key in ("name", "sha256", "sizeBytes", "createdAt", "segments")})
        exported.update(item["segmentNames"])
    return bundles, exported


def export_pending(root=common.ROOT, exports=common.EXPORTS, recipient=common.RECIPIENT, group=None):
    bundles, exported = catalog(root, exports)
    pending = [p for p in sorted(root.glob("logs-*.jsonl.gz")) if SEGMENT.fullmatch(p.name) and p.name not in exported and not p.is_symlink()]
    selected, size = [], 0
    for path in pending:
        if selected and size + path.stat().st_size > 100 * 1024 ** 2:
            break
        selected.append(path); size += path.stat().st_size
    if selected:
        created_at = common.stamp()
        import uuid
        name = "automabaca-logs-" + common.now().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8] + ".tar.age"
        manifest = {"schemaVersion": 1, "project": "automabaca-novo", "createdAt": created_at,
                    "segments": [{"name": p.name, "sha256": common.digest(p), "sizeBytes": p.stat().st_size} for p in selected]}
        with tempfile.TemporaryDirectory(prefix=".export-", dir=root) as temporary:
            stage = Path(temporary)
            common.atomic_json(stage / "manifest.json", manifest)
            package = stage / "payload.tar"
            with tarfile.open(package, "w") as archive:
                archive.add(stage / "manifest.json", arcname="manifest.json")
                for path in selected:
                    archive.add(path, arcname="segments/" + path.name, recursive=False)
            partial = stage / "payload.tar.age"
            result = subprocess.run(["age", "-R", str(recipient), "-o", str(partial), str(package)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
            if result.returncode or not partial.is_file() or partial.stat().st_size < 100:
                raise RuntimeError("log_encryption_failed")
            # Export and archive directories can be on different filesystems.
            with partial.open("rb") as handle:
                common.atomic_bytes(exports / name, handle.read(), 0o640, group)
        record = {"name": name, "sha256": common.digest(exports / name), "sizeBytes": (exports / name).stat().st_size,
                  "createdAt": created_at, "segments": len(selected), "segmentNames": [p.name for p in selected]}
        common.atomic_json(root / "bundles" / (name + ".json"), record)
        bundles, _ = catalog(root, exports)
    index = {"schemaVersion": 1, "project": "automabaca-novo", "generatedAt": common.stamp(),
             "retentionDays": common.RETENTION_DAYS, "bundles": bundles}
    common.atomic_json(exports / "index.json", index, 0o640, group)
    return index, len(selected), len(pending) > len(selected)


def prune(root=common.ROOT, exports=common.EXPORTS):
    cutoff = common.now().timestamp() - common.RETENTION_DAYS * 86400
    bundles, exported = catalog(root, exports)
    for path in root.glob("logs-*.jsonl.gz"):
        if SEGMENT.fullmatch(path.name) and not path.is_symlink() and path.name in exported and path.stat().st_mtime < cutoff:
            path.unlink()
    for bundle in bundles:
        if common.parse_time(bundle["createdAt"]).timestamp() >= cutoff:
            continue
        metadata = root / "bundles" / (bundle["name"] + ".json")
        item = common.read_json(metadata)
        if any((root / name).exists() for name in item["segmentNames"]):
            continue
        # Remove metadata first: a crash can leave an extra encrypted bundle,
        # but never leaves a catalog entry pointing to a missing file.
        metadata.unlink()
        (exports / bundle["name"]).unlink(missing_ok=True)


def main():
    os.umask(0o077)
    with (common.STATE / "export.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        prune()
        index, selected, backlog = export_pending(group=grp.getgrnam("deploy").gr_gid)
        latest = index["bundles"][-1] if index["bundles"] else None
        common.atomic_json(common.STATE / "export.json", {"schemaVersion": 1, "ok": True, "observedAt": common.stamp(),
            "bundles": len(index["bundles"]), "latestBundle": latest["name"] if latest else None,
            "latestExportAt": latest["createdAt"] if latest else None, "backlog": backlog}, 0o644)
        common.event("LOG_ARCHIVE_EXPORTED", segments=selected, bundles=len(index["bundles"]))


if __name__ == "__main__":
    try:
        main()
    except BlockingIOError:
        pass
    except Exception as error:
        common.atomic_json(common.STATE / "export.json", {"schemaVersion": 1, "ok": False, "observedAt": common.stamp(), "reason": type(error).__name__}, 0o644)
        common.event("LOG_ARCHIVE_EXPORT_FAILED", reason=type(error).__name__)
        raise SystemExit(1)
