#!/usr/bin/env python3
"""O reset das tentativas de LLM só apaga o que exportou."""
import gzip
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def load_reset():
    path = Path(__file__).with_name("reset-llm-attempts.py")
    spec = importlib.util.spec_from_file_location("reset_llm_attempts", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ExportThenDelete(unittest.TestCase):
    def setUp(self):
        self.mod = load_reset()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.export = Path(tmp.name) / "llm-attempt-reset.csv.gz"

    def test_deletes_only_the_rows_in_the_export(self):
        # O valor entre aspas tem vírgula e quebra de linha, como o CSV do COPY grava.
        with gzip.open(self.export, "wt", encoding="utf-8", newline="") as sink:
            sink.write('id,kind,name,outcome,labels\n7,llm,llm.attempt,ok,"{""model"": ""a,\nb""}"\n12,llm,llm.attempt,error,\n')
        ids = self.mod.exported_ids(self.export)
        self.assertEqual(ids, [7, 12])

        statements = []
        with mock.patch.object(self.mod, "psql", side_effect=lambda sql, **_: statements.append(sql) or "2\n"):
            self.assertEqual(self.mod.delete_exported(ids), 2)
        self.assertIn("id = ANY('{7,12}'::bigint[])", statements[0])
        self.assertIn("name = 'llm.attempt'", statements[0])

    def test_empty_export_deletes_nothing(self):
        with gzip.open(self.export, "wt", encoding="utf-8", newline="") as sink:
            sink.write("id,kind,name,outcome,labels\n")
        with mock.patch.object(self.mod, "psql") as psql:
            self.assertEqual(self.mod.delete_exported(self.mod.exported_ids(self.export)), 0)
        psql.assert_not_called()


if __name__ == "__main__":
    unittest.main()
