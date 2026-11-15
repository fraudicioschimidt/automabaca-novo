#!/usr/bin/env python3
"""source_filter must keep orientation symlinks and ignore leaked worktrees."""
import importlib.util
import tarfile
import tempfile
import unittest
from pathlib import Path


def load_backup():
    path = Path(__file__).with_name("backup-diario.py")
    spec = importlib.util.spec_from_file_location("backup_diario", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SourceFilterTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_backup()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def _tarinfo(self, relative, *, symlink=False):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if symlink:
            path.symlink_to("AGENTS.md")
        else:
            path.write_text("x\n", encoding="utf-8")
        with tarfile.open(self.root / "probe.tar", "w") as archive:
            archive.add(path, arcname=relative)
            return archive.getmembers()[-1]

    def test_orientation_symlink_kept(self):
        entry = self._tarinfo("CLAUDE.md", symlink=True)
        kept = self.mod.source_filter(entry)
        self.assertIs(kept, entry)
        self.assertTrue(kept.issym())

    def test_cursor_rules_skipped(self):
        entry = self._tarinfo(".cursor/rules/automabaca.mdc", symlink=True)
        self.assertIsNone(self.mod.source_filter(entry))

    def test_leaked_worktree_skipped(self):
        entry = self._tarinfo("wt-p1-fs-breaker/app/page.tsx")
        self.assertIsNone(self.mod.source_filter(entry))
        self.assertTrue(self.mod.skip_source_entry("wt-ops/foo"))

    def test_regular_source_kept(self):
        entry = self._tarinfo("app/page.tsx")
        self.assertIs(self.mod.source_filter(entry), entry)

    def test_socket_rejected(self):
        entry = self._tarinfo("weird.sock")
        entry.type = tarfile.CHRTYPE
        with self.assertRaisesRegex(RuntimeError, "unsupported_recovery_source_entry"):
            self.mod.source_filter(entry)


if __name__ == "__main__":
    unittest.main()
