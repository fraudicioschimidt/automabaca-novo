#!/usr/bin/env python3
"""O preflight do publish.py diante do worker que o migrar.py parou, e o registro da reversão."""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


def carregar():
    caminho = Path(__file__).with_name("publish.py")
    spec = importlib.util.spec_from_file_location("publish", caminho)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


p = carregar()

BASE = {"web": "web@sha256:antigo", "worker": "worker@sha256:antigo"}
MIGRACAO = {"workerStopped": True, "workerContainerId": "w1", "exitCode": 0}


def estado(role, health="healthy", running=True, image=None, id_=None):
    return {"role": role, "id": id_ or role + "1", "image": image or BASE.get(role, "postgres"),
            "health": health, "running": running}


def producao(**trocas):
    atual = {"web": estado("web"), "worker": estado("worker", id_="w1"), "db": estado("db")}
    atual.update(trocas)
    return atual


def worker_parado():
    return estado("worker", health="unhealthy", running=False, id_="w1")


class WorkerParadoPelaMigracao(unittest.TestCase):
    def test_so_o_container_que_o_migrar_parou_com_o_migrate_concluido(self):
        self.assertTrue(p.worker_stopped_for_migration(MIGRACAO, worker_parado()))
        self.assertFalse(p.worker_stopped_for_migration(None, worker_parado()))
        self.assertFalse(p.worker_stopped_for_migration({**MIGRACAO, "exitCode": 1}, worker_parado()))
        self.assertFalse(p.worker_stopped_for_migration({**MIGRACAO, "exitCode": None}, worker_parado()))
        self.assertFalse(p.worker_stopped_for_migration({**MIGRACAO, "workerContainerId": "outro"}, worker_parado()))
        self.assertFalse(p.worker_stopped_for_migration(MIGRACAO, estado("worker", id_="w1")))
        # Release com migration de antes desta mudança: migration.json sem o campo.
        self.assertFalse(p.worker_stopped_for_migration({"exitCode": 0}, worker_parado()))
        # Religado depois (pelo publicar.sh, por exemplo) e parado de novo por outro motivo.
        self.assertFalse(p.worker_stopped_for_migration({**MIGRACAO, "workerRestartedAt": "2026-09-23T20:00:00+00:00"},
                                                        worker_parado()))


class Preflight(unittest.TestCase):
    def problemas(self, atual, parado=False, web_no_banco=True):
        chamadas = []

        def alcanca():
            chamadas.append(1)
            return web_no_banco
        problemas = p.preflight_problems(atual, BASE, parado, alcanca)
        self.chamou_a_web = bool(chamadas)
        return problemas

    def test_caso_normal_exige_os_tres_healthy(self):
        self.assertEqual(self.problemas(producao()), [])
        self.assertNotEqual(self.problemas(producao(worker=worker_parado())), [])
        self.assertNotEqual(self.problemas(producao(web=estado("web", health="unhealthy"))), [])
        self.assertFalse(self.chamou_a_web)

    def test_worker_parado_pela_migracao_passa_com_a_web_no_banco(self):
        # O healthcheck da web é o /api/health, que cai sem worker.
        self.assertEqual(self.problemas(producao(worker=worker_parado()), parado=True), [])
        self.assertFalse(self.chamou_a_web)
        self.assertEqual(self.problemas(producao(worker=worker_parado(), web=estado("web", health="unhealthy")),
                                        parado=True), [])
        self.assertTrue(self.chamou_a_web)

    def test_worker_parado_pela_migracao_nao_libera_o_resto(self):
        web_doente = estado("web", health="unhealthy")
        self.assertNotEqual(self.problemas(producao(worker=worker_parado(), web=web_doente),
                                           parado=True, web_no_banco=False), [])
        self.assertNotEqual(self.problemas(producao(worker=worker_parado(), web=estado("web", running=False)),
                                           parado=True), [])
        self.assertNotEqual(self.problemas(producao(worker=worker_parado(), db=estado("db", health="unhealthy")),
                                           parado=True), [])
        self.assertEqual(self.problemas(producao(web=estado("web", image="web@sha256:outro"))),
                         ["production is not on base release"])
        self.assertIn("production is not on base release",
                      self.problemas(producao(worker=estado("worker", running=False, image="x")), parado=True))


class RollBack(unittest.TestCase):
    """Depois de uma troca que falhou, a pasta da release diz se a produção voltou para a base."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.work = Path(folder.name)
        self.compose = self.work / "compose.yaml"
        self.compose.write_text("novo")
        self.events = []

    def roll_back(self, restart_error=None):
        def set_compose(contents):
            self.events.append("compose da base")
            self.compose.write_bytes(contents)

        def restart_services():
            self.events.append("up -d")
            if restart_error:
                raise restart_error
        p.roll_back(self.work, self.compose, b"antigo", "novo", "base-release", set_compose, restart_services)

    def marker(self, name):
        path = self.work / name
        return json.loads(path.read_text()) if path.exists() else None

    def test_roll_back_that_restarts_the_old_services(self):
        self.roll_back()
        self.assertEqual(self.events, ["compose da base", "up -d"])
        self.assertEqual(self.marker("rollback.json")["restored"], "base-release")
        self.assertIsNone(self.marker("rollback-failed.json"))

    def test_roll_back_that_fails_to_restart_is_recorded(self):
        self.roll_back(restart_error=subprocess.CalledProcessError(1, ["docker", "compose", "up"]))
        self.assertIsNone(self.marker("rollback.json"))
        self.assertIn("CalledProcessError", self.marker("rollback-failed.json")["error"])

    def test_compose_changed_by_someone_else_is_not_rolled_back_and_is_recorded(self):
        self.compose.write_text("de outra pessoa")
        self.roll_back()
        self.assertEqual(self.events, [])
        self.assertEqual(self.compose.read_text(), "de outra pessoa")
        self.assertIsNone(self.marker("rollback.json"))
        self.assertIn("Compose changed", self.marker("rollback-failed.json")["error"])


if __name__ == "__main__":
    unittest.main()
