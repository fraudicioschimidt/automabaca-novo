#!/usr/bin/env python3
"""O backup diário não deixa dump em claro na VPS depois de cifrar ou de falhar, nem perde o SQL de conferência."""
import fcntl
import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


def load_backup():
    path = Path(__file__).with_name("backup-diario.py")
    spec = importlib.util.spec_from_file_location("backup_diario", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PlaintextDumps(unittest.TestCase):
    def setUp(self):
        self.mod = load_backup()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "backups"
        self.exports = Path(tmp.name) / "exports"
        self.root.mkdir()
        self.exports.mkdir()

    def snapshot(self, stamp, *, verified=True, twin=True):
        path = self.root / f"snapshot-{stamp}-0a1b2c3d"
        path.mkdir()
        (path / "database.dump").write_bytes(b"PGDMP")
        (path / "SHA256SUMS").write_text("x  database.dump\n")
        if verified:
            (path / "VERIFIED").write_text("2026-09-21T04:23:12Z\n")
        if twin:
            (self.exports / f"automabaca-novo-recovery-{stamp}.tar.age").write_bytes(b"age-encryption.org/v1")
        os.utime(path, (1_000_000, 1_000_000))
        return path

    def test_drops_the_dump_only_when_the_encrypted_twin_exists(self):
        paired = self.snapshot("20260921T042232Z")
        orphan = self.snapshot("20260919T072135Z", twin=False)
        unverified = self.snapshot("20260920T041919Z", verified=False)

        removed = self.mod.drop_plaintext_dumps(self.root, self.exports)

        self.assertEqual(removed, [paired.name])
        self.assertFalse((paired / "database.dump").exists())
        self.assertTrue((paired / "SHA256SUMS").exists(), "a evidência fica")
        self.assertTrue((orphan / "database.dump").exists(), "sem gêmeo cifrado, o dump é o único backup")
        self.assertTrue((unverified / "database.dump").exists())

    def test_keeps_the_directory_mtime_that_rotation_reads(self):
        paired = self.snapshot("20260921T042232Z")
        self.mod.drop_plaintext_dumps(self.root, self.exports)
        self.assertEqual(paired.stat().st_mtime, 1_000_000)

    def test_empty_twin_does_not_count(self):
        paired = self.snapshot("20260921T042232Z")
        (self.exports / "automabaca-novo-recovery-20260921T042232Z.tar.age").write_bytes(b"")
        self.assertEqual(self.mod.drop_plaintext_dumps(self.root, self.exports), [])
        self.assertTrue((paired / "database.dump").exists())


class SimulatedHost(unittest.TestCase):
    """O main() com Docker e o host simulados, num diretório temporário."""

    def setUp(self):
        self.mod = load_backup()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.root = self.base / "backups"
        self.root.mkdir()
        self.publication_lock = self.base / ".publicar.lock"

    def run_backup(self, fail_at, *, expect=subprocess.CalledProcessError, during_dump=None):
        """Roda o main() até `fail_at`, o comando que falha; devolve o snapshot criado, se houver."""
        exports, status, config = (self.base / name for name in ("exports", "status", "config"))
        for folder in (exports, status, config):
            folder.mkdir(exist_ok=True)
        (config / "backup-recipient.txt").write_text("age1" + "q" * 58 + "\n")
        self.dumps = 0
        self.commands = []

        def run(args, **kwargs):
            self.commands.append(args)
            if "{{.Image}}" in args:
                return SimpleNamespace(stdout="sha256:production-db-image\n")
            if fail_at in args:
                raise subprocess.CalledProcessError(1, args)
            if "pg_dump" in args:
                self.dumps += 1
                if during_dump:
                    during_dump()
                kwargs["stdout"].write(b"PGDMP")
            return SimpleNamespace(stdout="automabaca-novo|db|true" if "inspect" in args else "")

        patches = [mock.patch.object(self.mod, name, value) for name, value in [
            ("ROOT", self.root), ("EXPORTS", exports), ("STATUS", status), ("CONFIG", config), ("run", run),
            ("PUBLICATION_LOCK", self.publication_lock), ("PUBLICATION_WAIT_S", 0.2), ("PUBLICATION_POLL_S", 0.01),
            ("directory", lambda path, mode: None), ("regular", lambda path: None)]]
        patches += [mock.patch.object(self.mod.os, "geteuid", return_value=0),
                    mock.patch.object(self.mod.os, "chown"),
                    mock.patch.object(self.mod.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=0)),
                    mock.patch.object(self.mod.subprocess, "run", return_value=SimpleNamespace(returncode=0))]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        with self.assertRaises(expect) as raised:
            self.mod.main()
        self.raised = raised.exception
        return next((p for p in self.root.iterdir() if p.name.startswith("snapshot-")), None)


class FailedSnapshots(SimulatedHost):
    """Snapshot que não chegou ao VERIFIED não é backup: não guarda dump em claro e entra na rotação."""

    def snapshot(self, stamp, *files, age_days=0):
        path = self.root / f"snapshot-{stamp}-0a1b2c3d"
        path.mkdir()
        for name in files:
            (path / name).write_text("x\n")
        moment = time.time() - age_days * 86400
        os.utime(path, (moment, moment))
        return path

    def test_restore_that_fails_leaves_no_plaintext_dump(self):
        # O serviço tenta de novo a cada falha (Restart=on-failure), cada vez num snapshot novo.
        snapshot = self.run_backup(fail_at="pg_restore")
        self.assertFalse((snapshot / "database.dump").exists())
        self.assertFalse((snapshot / "VERIFIED").exists())
        self.assertEqual(json.loads((snapshot / "FAILED").read_text())["error"], "CalledProcessError")

    def test_restore_check_runs_on_the_image_of_the_production_database(self):
        self.run_backup(fail_at="pg_restore")
        scratch = next(args for args in self.commands if args[:2] == ["docker", "run"])
        self.assertEqual(scratch[-1], "sha256:production-db-image")

    def test_unverified_snapshots_left_by_dead_runs_lose_the_dump(self):
        dead = self.snapshot("20260901T041500Z", "database.dump", age_days=20)
        verified = self.snapshot("20260921T041500Z", "database.dump", "VERIFIED", age_days=3)

        self.assertEqual(self.mod.discard_unverified_dumps(self.root), [dead.name])

        self.assertFalse((dead / "database.dump").exists())
        self.assertTrue((dead / "FAILED").is_file())
        self.assertLess(dead.stat().st_mtime, time.time() - 19 * 86400, "a rotação lê a idade da pasta")
        self.assertTrue((verified / "database.dump").exists(), "o verificado sem gêmeo cifrado fica")

    def test_rotation_reaches_failed_snapshots(self):
        old_failed = self.snapshot("20260901T041500Z", "FAILED", age_days=20)
        new_failed = self.snapshot("20260923T041500Z", "FAILED", age_days=1)
        old_verified = [self.snapshot(f"2026090{day}T041500Z", "VERIFIED", age_days=20) for day in (2, 3, 4)]

        self.mod.rotate_snapshots(self.root)

        self.assertFalse(old_failed.exists())
        self.assertTrue(new_failed.exists())
        # Dos verificados ficam no mínimo os dois mais novos, mesmo velhos.
        self.assertEqual([p.exists() for p in old_verified], [False, True, True])


class EncryptedPackages(unittest.TestCase):
    """Os pacotes cifrados ficam 30 dias na VPS, e os 2 mais novos ficam sempre."""

    def setUp(self):
        self.mod = load_backup()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.exports = Path(tmp.name)

    def package(self, stamp, age_days):
        path = self.exports / f"automabaca-novo-recovery-{stamp}.tar.age"
        path.write_bytes(b"age-encryption.org/v1")
        moment = time.time() - age_days * 86400
        os.utime(path, (moment, moment))
        return path

    def test_rotation_keeps_thirty_days_of_packages(self):
        expired = self.package("20260801T041500Z", 40)
        recent = [self.package(f"202609{day:02d}T041500Z", 30 - day) for day in (5, 10, 20)]
        latest = self.exports / "latest.json"
        latest.write_text("{}")
        os.utime(latest, (0, 0))

        self.mod.rotate_exports(self.exports)

        self.assertFalse(expired.exists())
        self.assertEqual([p.exists() for p in recent], [True, True, True])
        self.assertTrue(latest.exists(), "só os pacotes entram na rotação")

    def test_rotation_keeps_the_two_newest_even_when_old(self):
        packages = [self.package(f"2026070{day}T041500Z", 60) for day in (1, 2, 3)]

        self.mod.rotate_exports(self.exports)

        self.assertEqual([p.exists() for p in packages], [False, True, True])


class PublicationLock(SimulatedHost):
    """O pacote não junta o dump de um schema ao compose de outra release: publicação e backup se excluem."""

    def hold_publication(self):
        handle = self.publication_lock.open("w")
        self.addCleanup(handle.close)
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle

    def publication_is_blocked(self):
        with self.publication_lock.open("r") as other:
            try:
                fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(other, fcntl.LOCK_UN)
            return False

    def test_publication_in_progress_leaves_no_dump(self):
        self.hold_publication()
        snapshot = self.run_backup(fail_at="pg_restore", expect=RuntimeError)
        self.assertEqual(str(self.raised), "publication_in_progress")
        self.assertEqual(self.dumps, 0)
        self.assertIsNone(snapshot)

    def test_publication_waits_while_the_backup_dumps(self):
        self.publication_lock.touch()
        blocked = []
        self.run_backup(fail_at="pg_restore", during_dump=lambda: blocked.append(self.publication_is_blocked()))
        self.assertEqual(blocked, [True])
        self.assertFalse(self.publication_is_blocked(), "o backup solta a trava ao terminar, mesmo falhando")

    def test_host_that_never_published_backs_up_without_the_lock(self):
        self.run_backup(fail_at="pg_restore")
        self.assertEqual(self.dumps, 1)
        self.assertFalse(self.publication_lock.exists())


class RestoreCheck(unittest.TestCase):
    def test_the_sql_the_script_opens_is_versioned_next_to_it(self):
        # Se o SQL existisse só na VPS, reinstalar o script do repositório
        # gravaria o dump em claro e não geraria o .tar.age.
        script = Path(__file__).with_name("backup-diario.py").read_text()
        self.assertIn('with_name("restore-check.sql")', script)
        sql = Path(__file__).with_name("restore-check.sql").read_text()
        self.assertIn("BEGIN READ ONLY", sql)
        self.assertIn("automabaca_novo_restorecheck", sql)
        self.assertIn("ROLLBACK", sql)


if __name__ == "__main__":
    unittest.main()
