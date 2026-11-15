#!/usr/bin/env bash

# Runtime Docker sob demanda para o navegador canônico da suíte de browser
# (`run-playwright-canonical.sh`). Só quem iniciou o daemon pode encerrá-lo.
DOCKER_RUNTIME_MANAGED_SERVICE="false"
DOCKER_RUNTIME_MANAGED_SOCKET="false"
DOCKER_RUNTIME_MANAGED_CONTAINERD="false"

ensure_docker_runtime() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker não está instalado; instale o pacote do host antes de executar este gate." >&2
    return 1
  fi
  local can_manage_systemd="false"
  local service_was_active="false"
  local socket_was_active="false"
  local containerd_was_active="false"
  if [[ "$(uname -s)" == "Linux" ]] \
    && command -v systemctl >/dev/null 2>&1 \
    && [[ "${EUID:-$(id -u)}" -eq 0 ]] \
    && systemctl cat docker.service >/dev/null 2>&1; then
    can_manage_systemd="true"
    if systemctl is-active --quiet docker.service; then
      service_was_active="true"
    fi
    if systemctl is-active --quiet docker.socket; then
      socket_was_active="true"
    fi
    if systemctl is-active --quiet containerd.service; then
      containerd_was_active="true"
    fi
  fi

  if docker info >/dev/null 2>&1; then
    if [[ "$can_manage_systemd" == "true" ]]; then
      if [[ "$service_was_active" == "false" ]] && systemctl is-active --quiet docker.service; then
        DOCKER_RUNTIME_MANAGED_SERVICE="true"
      fi
      if [[ "$socket_was_active" == "false" ]] && systemctl is-active --quiet docker.socket; then
        DOCKER_RUNTIME_MANAGED_SOCKET="true"
      fi
      if [[ "$containerd_was_active" == "false" ]] && systemctl is-active --quiet containerd.service; then
        DOCKER_RUNTIME_MANAGED_CONTAINERD="true"
      fi
    fi
    return 0
  fi

  if [[ "$can_manage_systemd" == "true" ]]; then
    echo "Docker instalado, mas inativo; iniciando temporariamente para o gate..." >&2
    systemctl start docker.service
    if [[ "$service_was_active" == "false" ]]; then
      DOCKER_RUNTIME_MANAGED_SERVICE="true"
    fi
    if [[ "$socket_was_active" == "false" ]]; then
      DOCKER_RUNTIME_MANAGED_SOCKET="true"
    fi
    if [[ "$containerd_was_active" == "false" ]]; then
      DOCKER_RUNTIME_MANAGED_CONTAINERD="true"
    fi
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon indisponível. Inicie docker.service ou o Docker Desktop e repita o gate." >&2
    return 1
  fi
}

stop_managed_docker_runtime() {
  local units=()
  if [[ "$DOCKER_RUNTIME_MANAGED_SERVICE" == "true" ]]; then
    units+=(docker.service)
  fi
  if [[ "$DOCKER_RUNTIME_MANAGED_SOCKET" == "true" ]]; then
    units+=(docker.socket)
  fi
  if [[ "$DOCKER_RUNTIME_MANAGED_CONTAINERD" == "true" ]]; then
    units+=(containerd.service)
  fi
  if [[ "${#units[@]}" -eq 0 ]]; then
    return 0
  fi
  systemctl stop "${units[@]}"
  DOCKER_RUNTIME_MANAGED_SERVICE="false"
  DOCKER_RUNTIME_MANAGED_SOCKET="false"
  DOCKER_RUNTIME_MANAGED_CONTAINERD="false"
}

require_isolated_browser_target() {
  if [[ "${VISUAL_TEST_MODE:-}" != "1" ]]; then
    echo "Gate de navegador recusado: VISUAL_TEST_MODE=1 é obrigatório." >&2
    return 2
  fi
  if [[ -z "${DATABASE_URL:-}" ]] || ! DATABASE_URL="$DATABASE_URL" node -e '
    const name = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.replace(/^\//, ""));
    process.exit(/(?:^|_)e2e(?:_|$)/i.test(name) ? 0 : 1);
  '; then
    echo "Gate de navegador recusado: DATABASE_URL deve apontar para um banco *_e2e*." >&2
    return 2
  fi

  local base_url="${PLAYWRIGHT_BASE_URL:-${E2E_BASE_URL:-${SMOKE_BASE_URL:-}}}"
  if [[ -z "$base_url" && "${CI:-}" != "true" ]]; then
    echo "Gate local recusado: informe PLAYWRIGHT_BASE_URL para um standalone E2E isolado." >&2
    return 2
  fi
  if [[ -n "$base_url" ]]; then
    case "$base_url" in
      http://127.0.0.1:*|http://localhost:*) ;;
      *) echo "Gate de navegador recusado fora de loopback: $base_url" >&2; return 2 ;;
    esac
  fi
}
