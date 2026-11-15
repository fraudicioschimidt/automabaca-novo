#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/docker-runtime.sh
source "$SCRIPT_DIR/lib/docker-runtime.sh"

readonly PLAYWRIGHT_VERSION="1.61.1"
readonly DEFAULT_IMAGE="mcr.microsoft.com/playwright@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48"
readonly IMAGE="${PLAYWRIGHT_CANONICAL_IMAGE:-$DEFAULT_IMAGE}"
readonly NAME="automabaca-playwright-${GITHUB_RUN_ID:-local}-$$"
# shellcheck source=scripts/lib/porta-livre.sh
source "$SCRIPT_DIR/lib/porta-livre.sh"
# Na CI, vários jobs de navegador dividem a máquina (e a rede do host): sem
# PLAYWRIGHT_WS_PORT, uma porta livre por tentativa. Fora dela, a fixa.
porta_auto=0
if [[ -z "${PLAYWRIGHT_WS_PORT:-}" && "${CI:-}" == "true" ]]; then porta_auto=1; fi
PORT="${PLAYWRIGHT_WS_PORT:-3011}"

if [[ $# -eq 0 ]]; then
  echo "uso: $0 <comando> [argumentos...]" >&2
  exit 2
fi

# Navegador numa imagem fixada (mesma versão do @playwright/test) contra o
# servidor isolado; VISUAL_TEST_MODE libera as páginas de mock só nesse ambiente.
export VISUAL_TEST_MODE=1

cleanup() {
  docker stop --timeout 2 "$NAME" >/dev/null 2>&1 || true
  stop_managed_docker_runtime
}
trap cleanup EXIT INT TERM

require_isolated_browser_target
ensure_docker_runtime

# Sobe o Chromium canônico em "$PORT". Saída 3: porta tomada (tente outra).
subir_navegador() {
  if ab_porta_em_uso "$PORT"; then return 3; fi
  # Sem volumes ou variáveis do host; somente o tráfego da sessão E2E descartável.
  docker run --detach --rm \
    --name "$NAME" \
    --network host \
    --ipc=host \
    "$IMAGE" \
    npx --yes "playwright@${PLAYWRIGHT_VERSION}" run-server \
      --port "$PORT" \
      --host 127.0.0.1 >/dev/null
  local logs
  for _ in {1..60}; do
    logs="$(docker logs "$NAME" 2>&1 || true)"
    # Pronto é o NOSSO servidor dizendo que escuta: responder na porta não basta,
    # porque outro job pode estar nela.
    if [[ "$logs" == *"Listening on"* ]] && node -e 'const net=require("node:net"); const socket=net.connect(Number(process.argv[1]), "127.0.0.1", () => { socket.end(); process.exit(0); }); socket.on("error", () => process.exit(1));' "$PORT"; then
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$NAME" 2>/dev/null || true)" != "true" ]]; then
      [[ "$logs" == *EADDRINUSE* ]] && return 3
      echo "$logs" >&2
      echo "Chromium canônico encerrou antes de ficar pronto." >&2
      return 1
    fi
    sleep 1
  done
  docker logs "$NAME" >&2 || true
  echo "Chromium canônico não respondeu em 127.0.0.1:${PORT}." >&2
  return 1
}

pronto=false
for tentativa in 1 2 3 4 5; do
  if (( porta_auto )); then PORT="$(ab_porta_livre)"; fi
  if subir_navegador; then pronto=true; break; else codigo=$?; fi
  docker stop --timeout 2 "$NAME" >/dev/null 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if (( codigo == 3 && porta_auto && tentativa < 5 )); then
    echo "→ porta ${PORT} do Chromium tomada; tentando outra." >&2
    continue
  fi
  (( codigo == 3 )) && echo "Porta ${PORT} do Chromium já está em uso; use PLAYWRIGHT_WS_PORT=<outra>." >&2
  exit 1
done
[[ "$pronto" == true ]] || exit 1

export PW_TEST_CONNECT_WS_ENDPOINT="ws://127.0.0.1:${PORT}/"
"$@"
