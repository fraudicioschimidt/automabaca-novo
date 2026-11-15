#!/usr/bin/env python3
"""A poda depois de cada publicação: saem as imagens que só serviam a releases antigas; a viva e a de rollback ficam."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("limpar-evidencias.sh")
GHCR = "ghcr.io/fraudicioschimidt/"

# Docker simulado: `image ls` lê $IMAGES ("id ref" por linha), `image rm` tira a
# linha da referência (a de $REFUSED falha) e `ps`/`inspect` leem $CONTAINERS
# ("nome imagem" por linha).
FAKE_DOCKER = """#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
case "$1 $2" in
  "image ls") cat "$IMAGES" ;;
  "image rm")
    grep -qxF "$3" "$REFUSED" && exit 1
    grep -v " $3\\$" "$IMAGES" > "$IMAGES.new"; mv "$IMAGES.new" "$IMAGES" ;;
  "ps -aq") [[ -f "$CONTAINERS" ]] && cut -d' ' -f1 "$CONTAINERS" ;;
  "inspect --format")
    [[ -f "$CONTAINERS" ]] || exit 1
    shift 3
    for container in "$@"; do
      line=$(grep -m1 "^$container " "$CONTAINERS") || exit 1
      echo "${line#* }"
    done ;;
  *) exit 1 ;;
esac
"""


def image_id(seed):
    return "sha256:" + (seed * 64)[:64]


class Scenario(unittest.TestCase):
    """Três releases: auto-a é velha; auto-b é a base de rollback da viva, auto-c."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.base = Path(folder.name)
        self.root = self.base / "releases"
        for release, letter, base in [("auto-a", "a", None), ("auto-b", "b", "auto-a"), ("auto-c", "c", "auto-b")]:
            path = self.root / release
            path.mkdir(parents=True)
            (path / "images.json").write_text(json.dumps({"web": image_id(letter + "1"), "worker": image_id(letter + "2")}))
            (path / "release.json").write_text(json.dumps({"release": release, "baseRelease": base}))
        self.compose = self.base / "compose.yaml"
        self.compose.write_text("    environment:\n      AUTOMABACA_RELEASE_ID: auto-c\n")
        self.images = self.base / "images"
        lines = [f"{image_id('p')} postgres:17.11-alpine", f"{image_id('d')} <none>:<none>"]
        for letter in "abc":
            for role, number in [("web", "1"), ("worker", "2")]:
                lines += [f"{image_id(letter + number)} automabaca-novo-{role}:auto-{letter}",
                          f"{image_id(letter + number)} {GHCR}automabaca-novo-{role}:{letter * 40}"]
        self.images.write_text("\n".join(lines) + "\n")
        self.containers = self.base / "containers"
        self.set_containers(web=image_id("c1"), worker=image_id("c2"))
        self.refused = self.base / "refused"
        self.refused.write_text("")
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        (bin_dir / "docker").write_text(FAKE_DOCKER)
        (bin_dir / "docker").chmod(0o755)
        self.env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", AUTOMABACA_EVIDENCE_DIR=str(self.root),
                        AUTOMABACA_COMPOSE=str(self.compose), IMAGES=str(self.images), CONTAINERS=str(self.containers),
                        REFUSED=str(self.refused), DOCKER_LOG=str(self.base / "docker.log"))

    def set_containers(self, web, worker, **others):
        lines = [f"automabaca-novo-web {web}", f"automabaca-novo-worker {worker}"]
        self.containers.write_text("\n".join(lines + [f"{name} {image}" for name, image in others.items()]) + "\n")

    def prune(self, *args):
        return subprocess.run(["bash", str(SCRIPT), *args], env=self.env, capture_output=True, text=True)

    def remaining(self):
        return sorted(line.split(" ", 1)[1] for line in self.images.read_text().splitlines())

    def removed(self):
        log = self.base / "docker.log"
        return [line.split()[2] for line in log.read_text().splitlines() if line.startswith("image rm")] \
            if log.exists() else []


class ImagePruning(Scenario):
    def test_every_reference_of_the_old_images_goes(self):
        result = self.prune("--apagar")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(self.removed()), sorted([
            "automabaca-novo-web:auto-a", f"{GHCR}automabaca-novo-web:{'a' * 40}",
            "automabaca-novo-worker:auto-a", f"{GHCR}automabaca-novo-worker:{'a' * 40}"]))
        self.assertIn("postgres:17.11-alpine", self.remaining())
        self.assertIn("automabaca-novo-web:auto-b", self.remaining(), "a base do rollback fica")
        self.assertIn(f"{GHCR}automabaca-novo-worker:{'c' * 40}", self.remaining())

    def test_without_apagar_only_shows(self):
        result = self.prune()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.removed(), [])
        self.assertIn("automabaca-novo-web:auto-a", result.stdout)

    def test_without_the_base_images_none_goes(self):
        (self.root / "auto-b" / "images.json").unlink()
        result = self.prune("--apagar")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.removed(), [])

    def test_without_the_app_containers_none_goes(self):
        self.containers.unlink()
        result = self.prune("--apagar")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.removed(), [])

    def test_image_of_an_app_container_stays(self):
        self.set_containers(web=image_id("a1"), worker=image_id("c2"))
        self.prune("--apagar")
        self.assertIn("automabaca-novo-web:auto-a", self.remaining())
        self.assertNotIn("automabaca-novo-worker:auto-a", self.remaining())

    def test_image_of_a_stopped_container_stays_without_warning(self):
        # `docker image rm` sem -f recusaria, e o aviso voltaria a cada publicação.
        self.set_containers(web=image_id("c1"), worker=image_id("c2"), parado=image_id("a2"))
        result = self.prune("--apagar")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("automabaca-novo-worker:auto-a", self.remaining())
        self.assertNotIn("automabaca-novo-web:auto-a", self.remaining())

    def test_reference_that_does_not_go_warns_and_exits_1(self):
        self.refused.write_text("automabaca-novo-web:auto-a\n")
        result = self.prune("--apagar")
        self.assertEqual(result.returncode, 1)
        self.assertIn("AVISO", result.stderr)
        self.assertNotIn("automabaca-novo-worker:auto-a", self.remaining(), "as outras saem")


class EvidencePruning(Scenario):
    """Quais pastas saem (a remoção de verdade exige a raiz de produção, em safe-delete.sh)."""

    def test_derivable_of_releases_other_than_live_and_rollback_goes(self):
        for release in ("auto-a", "auto-b", "auto-c"):
            for sub in ("verified-runtime", "web-layer", "worker-layer", "artifact"):
                (self.root / release / sub).mkdir()
            (self.root / release / "artifact" / "runtime.tar.gz").write_text("x")
            (self.root / release / "artifact" / "release-manifest.json").write_text("{}")
        os.utime(self.root / "auto-a", (1, 1))
        self.env["MANTER_ARTEFATO"] = "2"
        output = self.prune().stdout
        old = str(self.root / "auto-a") + "/"
        self.assertEqual(sorted(line.split("\t")[1] for line in output.splitlines() if "\t" in line and "total" not in line),
                         [old + "artifact/runtime.tar.gz", old + "verified-runtime", old + "web-layer",
                          old + "worker-layer"])

    def test_hundreds_of_releases_do_not_abort_the_listing(self):
        # As pastas de release nunca saem, só o peso delas. Com saída maior que
        # o pipe, um `head` no meio mataria o comando da esquerda (SIGPIPE), e o
        # pipefail abortaria a poda antes de apagar qualquer coisa.
        count = 1000
        for number in range(count):
            release = self.root / f"auto-20260901-{'f' * 40}-{number:04d}"
            (release / "verified-runtime").mkdir(parents=True)
            (release / "artifact").mkdir()
            (release / "artifact" / "runtime.tar.gz").write_text("x")
        result = self.prune()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"{2 * count - 5} pasta(s) e runtime(s) deriváveis:", result.stdout)
        self.assertEqual(sum("\t" in line and "total" not in line for line in result.stdout.splitlines()), 15)
        self.assertIn("Nada foi apagado", result.stdout)


if __name__ == "__main__":
    unittest.main()
