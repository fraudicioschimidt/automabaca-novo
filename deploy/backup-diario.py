#!/usr/bin/env python3
"""Back up the active v2 app. Restore checks run in a disposable, offline container.

Hermes has only an age public recipient. Plaintext recovery keys stay on the PC.
The public status/manifest never include database contents or configuration,
only the row counts the restore check read.
After the encrypted export exists, the snapshot keeps only its evidence (see
`drop_plaintext_dumps`). The restore check SQL is `restore-check.sql`, installed
next to this script.
"""
import contextlib
import datetime as dt
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
import uuid

PROJECT = "automabaca-novo"
DATABASE = "automabaca_novo"
CONTAINER = PROJECT + "-db"
SOURCE = Path("/srv/apps/automabaca-novo/source")
DEPLOY = SOURCE.parent / "deploy"
ROOT = Path("/var/backups/automabaca-novo")
EXPORTS = SOURCE.parent / "exports"
STATUS = Path("/var/lib/automabaca-novo/backup-status")
# A trava do publicar.sh. Uma publicação leva de 1,5 a 3,5 min; passado o teto,
# o Restart=on-failure tenta de novo 30 min depois.
PUBLICATION_LOCK = SOURCE.parent / ".publicar.lock"
PUBLICATION_WAIT_S = 15 * 60
PUBLICATION_POLL_S = 5
CONFIG = Path("/etc/automabaca-novo")
SKIP = {"node_modules", ".next", ".git", ".env", ".runtime", "coverage", "artifacts",
        "dist", ".eslintcache", "tsconfig.tsbuildinfo", "playwright-report", "test-results", "__pycache__",
        ".cursor"}


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def directory(path, mode):
    if path.is_symlink():
        raise RuntimeError("unsafe_directory")
    path.mkdir(mode=mode, parents=False, exist_ok=True)
    info = path.stat()
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("unsafe_directory_permissions")
    os.chmod(path, mode)


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("unsafe_private_file")


def atomic_json(root, name, value, mode=0o600, group=0):
    descriptor, temporary = tempfile.mkstemp(prefix=".publish-", dir=root)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, separators=(",", ":"))
            handle.write("\n"); handle.flush()
            os.fchmod(handle.fileno(), mode); os.fchown(handle.fileno(), 0, group)
            os.fsync(handle.fileno())
        os.replace(temporary, root / name)
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(temporary).unlink(missing_ok=True)


def run(args, **kwargs):
    try:
        return subprocess.run(args, check=True, stderr=subprocess.DEVNULL, timeout=1800, **kwargs)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        command = next((arg for arg in args if arg in {"pg_dump", "pg_restore", "psql", "pg_dumpall", "age"}), args[0])
        print(json.dumps(dict(event="backup_command_failed", command=command)), flush=True)
        raise


def skip_source_entry(name):
    parts = Path(name).parts
    if any(part in SKIP for part in parts) or name.startswith("src/generated/"):
        return True
    # Worktrees belong beside source/, never inside it — skip if one leaks in.
    if any(part.startswith("wt-") for part in parts):
        return True
    return False


def source_filter(entry):
    if skip_source_entry(entry.name):
        return None
    # CLAUDE.md / GEMINI.md / Cursor rules are symlinks to AGENTS.md by design.
    if not (entry.isfile() or entry.isdir() or entry.issym()):
        raise RuntimeError("unsupported_recovery_source_entry")
    return entry


SNAPSHOT = re.compile(r"snapshot-(\d{8}T\d{6}Z)-[a-f0-9]{8}")
RETENTION_DAYS = 14


def mark_failed(snapshot, error):
    """Um snapshot que não chegou ao VERIFIED não é backup: sai o dump em claro e fica o FAILED.

    Nem a troca pelo pacote cifrado nem a rotação alcançam o dump de um snapshot
    sem VERIFIED, e o serviço tenta de novo a cada falha, com snapshot novo.
    A rotação lê o mtime da pasta, que não muda aqui.
    """
    before = snapshot.stat()
    (snapshot / "database.dump").unlink(missing_ok=True)
    if not (snapshot / "FAILED").is_file():
        (snapshot / "FAILED").write_text(json.dumps(dict(failedAt=stamp(), error=error)) + "\n")
    os.utime(snapshot, ns=(before.st_atime_ns, before.st_mtime_ns))


def discard_unverified_dumps(root):
    """Marca como falhos os snapshots sem VERIFIED que uma execução morta deixou.

    Roda sob o lock do backup: nenhuma execução está escrevendo neles.
    """
    discarded = []
    for snapshot in sorted(root.iterdir()):
        if (not SNAPSHOT.fullmatch(snapshot.name) or snapshot.is_symlink() or not snapshot.is_dir()
                or (snapshot / "VERIFIED").is_file()):
            continue
        mark_failed(snapshot, "abandoned")
        discarded.append(snapshot.name)
    return discarded


def rotate_snapshots(root):
    """Apaga os snapshots desta rotina com mais de 14 dias; dos verificados ficam no mínimo os 2 mais novos.

    Só os que ela marcou (VERIFIED ou FAILED): o resto da pasta é histórico.
    """
    limit = time.time() - RETENTION_DAYS * 86400
    for marker, keep in (("VERIFIED", 2), ("FAILED", 0)):
        snapshots = sorted(p for p in root.iterdir() if SNAPSHOT.fullmatch(p.name) and not p.is_symlink()
                           and (p / marker).is_file() and not (marker == "FAILED" and (p / "VERIFIED").is_file()))
        for candidate in snapshots[:len(snapshots) - keep]:
            if candidate.stat().st_mtime < limit and candidate.parent == root:
                shutil.rmtree(candidate)


EXPORT = re.compile(r"automabaca-novo-recovery-\d{8}T\d{6}Z\.tar\.age")
EXPORT_RETENTION_DAYS = 30


def rotate_exports(exports):
    """Apaga os pacotes cifrados com mais de 30 dias; os 2 mais novos ficam, qualquer que seja a idade."""
    limit = time.time() - EXPORT_RETENTION_DAYS * 86400
    packages = sorted(p for p in exports.iterdir() if EXPORT.fullmatch(p.name) and not p.is_symlink())
    for candidate in packages[:-2]:
        if candidate.stat().st_mtime < limit:
            candidate.unlink()


def drop_plaintext_dumps(root, exports):
    """Remove the plaintext dump from verified snapshots that have an encrypted twin.

    The dump must exist in clear until it is restored and packed into the
    `.tar.age`. After that the snapshot only needs its evidence (verification,
    SHA256SUMS, VERIFIED): the same dump lives inside the export with the same
    timestamp. Until 21/09/2026 every snapshot kept `database.dump` in clear for
    14 days (675 MB), while the README said the VPS could not read its backups.
    Snapshots without a twin (a failed export) keep their dump until rotation.
    Pre-release dumps in `backups/` are a different thing: they stay in clear on
    purpose, so a failed migration can be rolled back without the owner's PC.
    """
    removed = []
    for snapshot in sorted(root.iterdir()):
        found = SNAPSHOT.fullmatch(snapshot.name)
        dump = snapshot / "database.dump"
        if not found or snapshot.is_symlink() or not (snapshot / "VERIFIED").is_file() or not dump.is_file():
            continue
        twin = exports / (PROJECT + "-recovery-" + found.group(1) + ".tar.age")
        if not twin.is_file() or twin.is_symlink() or twin.stat().st_size == 0:
            continue
        # Rotation reads the directory mtime; removing a file must not reset it.
        before = snapshot.stat()
        dump.unlink()
        os.utime(snapshot, ns=(before.st_atime_ns, before.st_mtime_ns))
        removed.append(snapshot.name)
    return removed


@contextlib.contextmanager
def publication_paused():
    """Segura a trava do publicar.sh do dump até o fim do pacote.

    Sem ela, uma publicação com migration no meio juntaria o dump de um schema
    ao compose de outra release, e a recuperação subiria imagens que não casam
    com o banco. A publicação que chega recusa com "outra publicação está em
    andamento", e o publicador automático tenta de novo no minuto seguinte.
    """
    if not PUBLICATION_LOCK.exists():  # host que nunca publicou
        yield
        return
    # Leitura basta para o flock, e o /srv é só leitura para o serviço.
    with PUBLICATION_LOCK.open("r") as handle:
        deadline = time.monotonic() + PUBLICATION_WAIT_S
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("publication_in_progress")
                time.sleep(PUBLICATION_POLL_S)
        yield


def dump_and_verify(snapshot):
    """Dump do banco no snapshot, restaurado e conferido num container descartável; grava o VERIFIED."""
    with (snapshot / "database.dump").open("xb") as output:
        run(["docker", "exec", CONTAINER, "pg_dump", "-U", DATABASE, "-d", DATABASE,
             "--format=custom", "--no-password", "--lock-wait-timeout=15s"], stdout=output)
    snapshot_hash = digest(snapshot / "database.dump")
    # A imagem do banco de produção, pelo id: uma tag solta poderia apontar para
    # outro PostgreSQL (ou outra libc, que ordena texto diferente).
    image = run(["docker", "inspect", "--format", "{{.Image}}", CONTAINER], stdout=subprocess.PIPE, text=True).stdout.strip()
    # No TCP network, production volumes or application workers are attached.
    scratch = PROJECT + "-restorecheck-" + uuid.uuid4().hex[:12]
    volume = scratch + "-data"
    run(["docker", "volume", "create", "--label", "automabaca.backup.restorecheck=true", volume], stdout=subprocess.DEVNULL)
    try:
        run(["docker", "run", "-d", "--pull=never", "--name", scratch, "--network=none",
             "--cpus=1", "--memory=768m", "--label", "automabaca.backup.restorecheck=true",
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=automabaca_novo_restorecheck",
             "--mount", "type=volume,src=" + volume + ",dst=/var/lib/postgresql/data",
             image], stdout=subprocess.DEVNULL)
        # The image bootstrap server listens only on its Unix socket.
        # TCP becomes available after initialization and its restart finish.
        ready = False
        for _ in range(60):
            result = subprocess.run(["docker", "exec", scratch, "pg_isready", "-h", "127.0.0.1", "-U", "postgres",
                                     "-d", "automabaca_novo_restorecheck"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if result.returncode == 0:
                ready = True; break
            time.sleep(1)
        if not ready:
            raise RuntimeError("restorecheck_database_unavailable")
        with (snapshot / "database.dump").open("rb") as dump:
            run(["docker", "exec", "-i", scratch, "pg_restore", "-U", "postgres", "-d", "automabaca_novo_restorecheck",
                 "--no-owner", "--no-acl", "--exit-on-error", "--single-transaction"], stdin=dump, stdout=subprocess.DEVNULL)
        with Path(__file__).with_name("restore-check.sql").open("rb") as sql:
            result = run(["docker", "exec", "-i", scratch, "psql", "-X", "-q", "-t", "-A",
                          "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "automabaca_novo_restorecheck"], stdin=sql, stdout=subprocess.PIPE)
        verification = json.loads(result.stdout)
        verification.update(project=PROJECT, dumpSha256=snapshot_hash, verifiedAt=stamp(), isolatedRestore=True)
        atomic_json(snapshot, "verification.json", verification)
    finally:
        # Names are created here; no discovered/production container or volume is removed.
        subprocess.run(["docker", "rm", "-f", scratch], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    (snapshot / "SHA256SUMS").write_text(snapshot_hash + "  database.dump\n")
    (snapshot / "VERIFIED").write_text(verification["verifiedAt"] + "\n")
    return verification


def main():
    if os.geteuid() != 0:
        raise RuntimeError("root_required")
    os.umask(0o077)
    directory(ROOT, 0o700); directory(EXPORTS, 0o750); directory(STATUS, 0o755)
    deploy_group = grp.getgrnam("deploy").gr_gid
    os.chown(EXPORTS, 0, deploy_group)
    recipient = CONFIG / "backup-recipient.txt"
    regular(recipient)
    if not re.fullmatch(r"age1[0-9a-z]{58}", recipient.read_text().strip()):
        raise RuntimeError("invalid_recipient")
    with (ROOT / ".backup.lock").open("a") as lock, contextlib.ExitStack() as held:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        held.enter_context(publication_paused())
        identity = run(["docker", "inspect", "--format",
                        '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}',
                        CONTAINER], stdout=subprocess.PIPE, text=True).stdout.strip()
        if identity != PROJECT + "|db|true":
            raise RuntimeError("production_container_identity_mismatch")
        discard_unverified_dumps(ROOT)
        if shutil.disk_usage(ROOT).free < 2 * 1024 ** 3:
            raise RuntimeError("insufficient_backup_space")
        suffix = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        snapshot = ROOT / ("snapshot-" + suffix + "-" + uuid.uuid4().hex[:8])
        snapshot.mkdir(mode=0o700)
        try:
            verification = dump_and_verify(snapshot)
        except BaseException as error:
            mark_failed(snapshot, type(error).__name__)
            raise
        with tempfile.TemporaryDirectory(prefix=".export-", dir=ROOT) as temporary:
            stage = Path(temporary)
            shutil.copytree(snapshot, stage / "database")
            for required in ("src", "app", "prisma", "scripts", "package.json", "package-lock.json"):
                if not (SOURCE / required).exists():
                    raise RuntimeError("recovery_source_incomplete")
            with tarfile.open(stage / "source.tar.gz", "w:gz") as archive:
                for entry in SOURCE.iterdir():
                    if entry.name in SKIP or entry.name.startswith("wt-"):
                        continue
                    archive.add(entry, arcname=entry.name, filter=source_filter)
            shutil.copytree(DEPLOY, stage / "deploy")
            shutil.copytree(Path(__file__).parent, stage / "backup-tools", ignore=shutil.ignore_patterns("__pycache__"))
            (stage / "config").mkdir(mode=0o700)
            for item in CONFIG.glob("*.env"):
                regular(item); shutil.copyfile(item, stage / "config" / item.name)
            shutil.copyfile("/etc/caddy/sites-enabled/automabaca.caddy", stage / "config" / "automabaca.caddy")
            with (stage / "postgres-roles.sql").open("wb") as output:
                run(["docker", "exec", CONTAINER, "pg_dumpall", "-U", DATABASE, "--globals-only", "--no-password"], stdout=output)
            with tarfile.open(stage / "persistent-data.tar.gz", "w:gz") as archive:
                logos = Path("/var/lib/automabaca-novo/logos")
                if logos.is_dir():
                    archive.add(logos, arcname="logos")
            manifest = dict(schemaVersion=1, project=PROJECT, database=DATABASE, createdAt=stamp(),
                            databaseVerifiedAt=verification["verifiedAt"], isolatedRestore=True,
                            fileConsistency="database_snapshot_then_files; provider_media_in_flight_may_require_refetch",
                            files={str(p.relative_to(stage)): digest(p) for p in stage.rglob("*") if p.is_file()})
            (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            name = PROJECT + "-recovery-" + suffix + ".tar.age"
            target = EXPORTS / name
            partial = EXPORTS / ("." + name + "." + uuid.uuid4().hex + ".partial")
            if target.exists():
                raise RuntimeError("archive_already_exists")
            try:
                pack = subprocess.Popen(["tar", "-C", str(stage), "-cf", "-", "."], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                try:
                    run(["age", "-R", str(recipient), "-o", str(partial)], stdin=pack.stdout)
                    pack.stdout.close()
                    if pack.wait(timeout=30) != 0:
                        raise RuntimeError("archive_failed")
                finally:
                    pack.stdout.close()
                    if pack.poll() is None:
                        pack.kill(); pack.wait()
                os.chown(partial, 0, deploy_group); os.chmod(partial, 0o640)
                with partial.open("rb") as handle:
                    os.fsync(handle.fileno())
                os.replace(partial, target)
                public = dict(schemaVersion=1, name=name, sha256=digest(target), sizeBytes=target.stat().st_size,
                              createdAt=manifest["createdAt"], databaseVerifiedAt=manifest["databaseVerifiedAt"])
                atomic_json(EXPORTS, "latest.json", public, 0o640, deploy_group)
            finally:
                partial.unlink(missing_ok=True)
        # The row counts of the restored copy let the panel say what the backup holds.
        atomic_json(STATUS, "status.json", dict(version=1, project=PROJECT, ok=True, observedAt=stamp(),
                                               databaseVerifiedAt=verification["verifiedAt"], encryptedExport=True,
                                               counts=verification.get("counts")), 0o644)
        drop_plaintext_dumps(ROOT, EXPORTS)
        rotate_snapshots(ROOT)
        rotate_exports(EXPORTS)
        print(json.dumps(dict(event="new_project_backup_verified", project=PROJECT, name=name, isolatedRestore=True)))


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise RuntimeError("backup_interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        main()
    except Exception as exc:
        if STATUS.is_dir() and not STATUS.is_symlink():
            atomic_json(STATUS, "status.json", dict(version=1, project=PROJECT, ok=False, observedAt=stamp()), 0o644)
        detail = str(exc).replace("\n", " ")[:160]
        print(json.dumps(dict(event="new_project_backup_failed", error=type(exc).__name__, detail=detail), ensure_ascii=True), flush=True)
        raise SystemExit(1)
