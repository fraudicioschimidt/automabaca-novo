#!/usr/bin/env bash
# PostgreSQL descartável de um job da CI, com o cluster inteiro na RAM.
#
#   ci-postgres.sh subir <banco>   sobe, espera ficar pronto e exporta
#                                  TEST_DATABASE_URL/DATABASE_URL no $GITHUB_ENV
#   ci-postgres.sh remover         apaga o container deste job (rode com `if: always()`)
#
# Mesma imagem de produção (a ordenação de texto do musl difere da do glibc) e
# a mesma configuração do `db-test` do docker-compose.dev.yml: o banco é
# recriado a cada job, então durabilidade (fsync, WAL completo) só custa tempo.
#
# O nome é único por execução/tentativa/job/runner e a porta do host é
# ALEATÓRIA, só em loopback: não colide com outro Postgres na mesma máquina
# (o de desenvolvimento, quando o script roda fora da CI). Um job derrubado no
# meio não roda o `remover`; por isso o `subir` apaga os containers desta CI
# com mais de 3 horas (nenhum job passa de 60 minutos).
set -euo pipefail

IMAGEM='postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
ROTULO=automabaca.ci-postgres
# O nome do runner hospedado tem espaço ("GitHub Actions 12"), que o Docker recusa.
runner="${RUNNER_NAME:?}"
nome="ci-pg-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:-1}-${GITHUB_JOB:?}-${runner//[^a-zA-Z0-9_.-]/-}"

remover() {
  docker rm -f -v "$nome" >/dev/null 2>&1 || true
}

podar_orfaos() {
  local limite id criado
  limite=$(( $(date +%s) - 3 * 3600 ))
  while read -r id; do
    [[ -n "$id" ]] || continue
    criado="$(docker inspect -f '{{.Created}}' "$id" 2>/dev/null)" || continue
    if (( $(date -d "$criado" +%s) < limite )); then
      docker rm -f -v "$id" >/dev/null 2>&1 && echo "→ removido Postgres órfão de CI: $id"
    fi
  done < <(docker ps -aq --filter "label=$ROTULO")
}

subir() {
  local banco="$1"
  [[ "$banco" =~ ^[a-z][a-z0-9_]*$ ]] || { echo "nome de banco inválido: $banco" >&2; exit 2; }
  podar_orfaos
  remover # sobra de uma tentativa anterior deste mesmo job
  docker run -d --rm --name "$nome" --label "$ROTULO=1" \
    --tmpfs /var/lib/postgresql/data:rw,size=2g \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$banco" \
    -p 127.0.0.1::5432 \
    "$IMAGEM" \
    postgres -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200 \
    >/dev/null
  # Pelo TCP de dentro do container: o servidor temporário do initdb só escuta
  # no socket, então isto só responde quando o servidor definitivo subiu.
  local pronto=0
  for _ in $(seq 1 60); do
    if docker exec "$nome" pg_isready -q -h 127.0.0.1 -U postgres -d "$banco"; then pronto=1; break; fi
    sleep 1
  done
  if (( ! pronto )); then
    docker logs "$nome" >&2 || true
    echo "PostgreSQL do job não ficou pronto em 60 s." >&2
    exit 1
  fi
  local porta
  porta="$(docker port "$nome" 5432/tcp | head -n1 | sed 's/.*://')"
  [[ "$porta" =~ ^[0-9]+$ ]] || { echo "porta do PostgreSQL não encontrada" >&2; exit 1; }
  local url="postgresql://postgres:postgres@127.0.0.1:${porta}/${banco}"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    { echo "TEST_DATABASE_URL=$url"; echo "DATABASE_URL=$url"; } >> "$GITHUB_ENV"
  fi
  echo "→ PostgreSQL em RAM: $nome em 127.0.0.1:$porta/$banco"
}

case "${1:-}" in
  subir) subir "${2:?uso: $0 subir <banco>}" ;;
  remover) remover ;;
  *) echo "uso: $0 subir <banco> | remover" >&2; exit 2 ;;
esac
