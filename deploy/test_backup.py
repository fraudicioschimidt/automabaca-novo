#!/usr/bin/env python3
"""O backup de antes da publicação restaura o dump num PostgreSQL descartável sem teto de RAM nos dados."""
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock


def load_backup():
    spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("backup.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


b = load_backup()


class DisposableRestore(unittest.TestCase):
    """O Docker é simulado: cada comando vira um evento, e os dados do descartável ficam onde o `docker run` diz."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.work = Path(folder.name) / "work"
        self.work.mkdir()
        (self.work / "release.json").write_text(json.dumps({"release": "r1"}))
        self.root = Path(folder.name) / "backups"
        self.commands = []
        self.fails = lambda args: False

        def run(args, **kwargs):
            self.commands.append(list(args))
            if self.fails(args):
                if kwargs.get("check"):
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, 1)
            output = kwargs.get("stdout")
            if "pg_dump" in args or ("pg_restore" in args and "--list" in args):
                output.write(b"PGDMP" if "b" in output.mode else "lista\n")
            return subprocess.CompletedProcess(args, 0)

        def check_output(args, **kwargs):
            self.commands.append(list(args))
            return "postgres@sha256:x" if args[1] == "inspect" else "12"

        for name, value in [("run", run), ("check_output", check_output)]:
            patcher = mock.patch.object(b.subprocess, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def backup(self):
        self.stderr = io.StringIO()
        with mock.patch.object(sys, "argv", ["backup.py", "--release-dir", str(self.work), "--raiz", str(self.root)]), \
                redirect_stdout(io.StringIO()), redirect_stderr(self.stderr):
            b.main()

    def disposable(self):
        return next(c for c in self.commands if c[:3] == ["docker", "run", "-d"])

    def disposable_volume(self):
        command = self.disposable()
        mount = command[command.index("--mount") + 1]
        options = dict(part.split("=", 1) for part in mount.split(","))
        self.assertEqual((options["type"], options["dst"]), ("volume", "/var/lib/postgresql/data"))
        return options["src"]

    def test_disposable_data_in_a_disk_volume_without_swap(self):
        # tmpfs conta no --memory do container: dados e WAL da restauração de um
        # banco de ~200 MB não cabem nos 512 MB.
        self.backup()
        command = self.disposable()
        self.assertFalse(any(part.startswith("--tmpfs") for part in command))
        volume = self.disposable_volume()
        self.assertEqual(command[command.index("--memory-swap") + 1], command[command.index("--memory") + 1])
        created = self.commands.index(["docker", "volume", "create", "--label", "automabaca.backup.restorecheck=true", volume])
        self.assertLess(created, self.commands.index(command))
        self.assertEqual(self.commands[-1], ["docker", "volume", "rm", volume])
        self.assertTrue(json.loads((next(self.root.iterdir()) / "backup.json").read_text())["disposableRestoreValidated"])

    def test_volume_goes_even_when_the_restore_fails(self):
        self.fails = lambda args: "--exit-on-error" in args
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            self.backup()
        self.assertIn("--exit-on-error", raised.exception.cmd)
        self.assertEqual(self.commands[-1], ["docker", "volume", "rm", self.disposable_volume()])

    def test_volume_goes_when_the_disposable_does_not_start(self):
        # O `docker rm` do container que nem existe falha; o erro que sobe é o do run.
        self.fails = lambda args: args[:3] in (["docker", "run", "-d"], ["docker", "rm", "-f"])
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            self.backup()
        self.assertEqual(raised.exception.cmd[:3], ["docker", "run", "-d"])
        self.assertEqual(self.commands[-1], ["docker", "volume", "rm", self.disposable_volume()])
        self.assertFalse(any(self.root.glob("*/backup.json")))

    def test_cleanup_that_fails_does_not_fail_a_verified_backup(self):
        self.fails = lambda args: args[:3] == ["docker", "volume", "rm"]
        self.backup()
        self.assertTrue(json.loads((next(self.root.iterdir()) / "backup.json").read_text())["disposableRestoreValidated"])
        self.assertIn("AVISO", self.stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
