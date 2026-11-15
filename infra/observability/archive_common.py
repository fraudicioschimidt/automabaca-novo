"""Shared, dependency-free storage helpers for the project log archive."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

ROOT = Path("/var/log/automabaca-novo/archive")
STATE = Path("/var/lib/automabaca-novo/observability")
EXPORTS = Path("/srv/apps/automabaca-novo/exports/logs")
RECEIPTS = Path("/var/lib/automabaca-novo/observability-receipts")
RECIPIENT = Path("/etc/automabaca-novo/backup-recipient.txt")
RETENTION_DAYS = 30
MAX_ARCHIVE_BYTES = 4 * 1024 ** 3


def now():
    return dt.datetime.now(dt.timezone.utc)


def stamp(value=None):
    return (value or now()).isoformat().replace("+00:00", "Z")


def parse_time(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def read_json(path, default=None, max_bytes=1_048_576):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return default
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise RuntimeError("unsafe_json_file")
        return json.load(handle)


def atomic_bytes(path, content, mode=0o600, group=None):
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), mode)
            if group is not None:
                os.fchown(handle.fileno(), -1, group)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def atomic_json(path, value, mode=0o600, group=None):
    atomic_bytes(path, (json.dumps(value, separators=(",", ":")) + "\n").encode(), mode, group)


def event(code, **fields):
    print(json.dumps({"eventCode": code, "module": "log-archive", **fields}), flush=True)
