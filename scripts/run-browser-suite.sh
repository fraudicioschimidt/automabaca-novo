#!/usr/bin/env bash
# Roda a suíte de navegador (Playwright) LOCALMENTE, do jeito que o CI roda:
# banco e2e próprio, build standalone, servidor isolado e base URL apontada
# para ele. Sem isto, cada execução manual redescobre a sequência na tentativa
# e erro (banco errado, PLAYWRIGHT_BASE_URL faltando, processo velho na porta).
#
#   bash scripts/run-browser-suite.sh                      # suíte inteira
#   bash scripts/run-browser-suite.sh npm run test:ui      # só o smoke
#   SKIP_BUILD=1 bash scripts/run-browser-suite.sh         # reaproveita o build
set -euo pipefail

cd "$(dirname "$0")/.."

# Override do processo vence o .env: senão `TEST_DATABASE_URL=…` na linha de
# comando seria sobrescrito pelo arquivo.
shell_test_database_url="${TEST_DATABASE_URL:-}"
set -a
# shellcheck disable=SC1091
[[ -f .env ]] && . ./.env
set +a
if [[ -n "$shell_test_database_url" ]]; then
  TEST_DATABASE_URL="$shell_test_database_url"
fi

# O build/standalone roda com NODE_ENV=production para reproduzir a borda real,
# mas jamais deve exigir ou herdar segredos reais da VPS.
# shellcheck source=scripts/lib/test-runtime-env.sh
source scripts/lib/test-runtime-env.sh
ab_export_test_runtime_env

# Credencial pública e sintética apenas desta instância E2E. O teste de login
# atravessa scrypt, lockout e emissão de sessão sem conhecer senha do operador.
export AB_E2E_LOGIN_PASSWORD='e2e-login-password'
AUTH_USERS="$(node -e '
  const { scryptSync } = require("node:crypto");
  const salt = "automabaca-e2e";
  process.stdout.write("fabricio:scrypt$" + salt + "$" + scryptSync(process.env.AB_E2E_LOGIN_PASSWORD, salt, 32).toString("hex"));
')"
export AUTH_USERS
export AUTH_SESSION_SECRET='e2e-only-session-secret-with-at-least-32-characters'
export LOG_HASH_SECRET='e2e-only-log-hash-secret-with-at-least-32-characters'

# Cluster DEDICADO de testes; nunca o de produção por omissão.
if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  echo "TEST_DATABASE_URL é obrigatória (cluster descartável). Não use DATABASE_URL de produção." >&2
  exit 2
fi
base_url_db="$TEST_DATABASE_URL"
# O banco e2e é o da família do TEST_DATABASE_URL: `automabaca_e2e` na base
# padrão, `<base>_e2e` na de uma worktree (scripts/lib/test-databases.mjs).
DATABASE_URL="$(node --input-type=module -e '
  import { e2eDatabaseUrl } from "./scripts/lib/test-databases.mjs";
  try {
    process.stdout.write(e2eDatabaseUrl(process.argv[1]));
  } catch (erro) {
    process.stderr.write(erro.message + "\n");
    process.exit(2);
  }
' "$base_url_db")"
export DATABASE_URL

# Fail-closed: o preparo TRUNCA o banco inteiro; um nome fora do padrão aqui
# significaria apagar dados de verdade.
case "$DATABASE_URL" in
  *_e2e*) ;;
  *) echo "Banco recusado: $DATABASE_URL (esperado *_e2e*)." >&2; exit 2 ;;
esac

# Uma suíte por BANCO: duas no mesmo banco e2e truncariam o banco uma da
# outra. A trava é por destino (host:porta/banco), não por usuário: na CI todos
# os jobs rodam como `ghrunner`, cada um com o próprio PostgreSQL, e uma trava
# por usuário recusava o segundo PR com "outra suíte" sem motivo (PR #143).
# A pasta é por usuário porque um arquivo em /tmp criado por outro usuário não
# é gravável aqui.
destino_db="${DATABASE_URL##*@}"
tmp_dir="${TMPDIR:-/tmp}/automabaca-e2e-$(id -un)/$(printf '%s' "$destino_db" | sha256sum | cut -c1-16)"
mkdir -p "$tmp_dir"
exec 9>"$tmp_dir/suite.lock"
if ! flock -n 9; then
  echo "Outra suíte de navegador já está usando o banco E2E ${destino_db}." >&2
  exit 2
fi

# A porta NUNCA vem do .env: lá `PORT` é a de PRODUÇÃO (3100). Herdá-la faria o
# servidor de teste falhar com EADDRINUSE enquanto o curl de prontidão seria
# respondido pelo servidor REAL — a suíte rodaria contra produção sem avisar.
# Por isso a variável é outra e há checagem dupla.
porta_producao="${PORT:-3100}"
# Na CI, vários jobs de navegador rodam ao mesmo tempo na mesma máquina: sem
# AB_E2E_PORT, a porta é uma livre pedida ao sistema (porta 0) na hora de subir
# o servidor, e se outro job a tomar nesse meio-tempo (EADDRINUSE), outra
# tentativa com outra porta. Fora da CI, a fixa de sempre.
porta_auto=0
if [[ -z "${AB_E2E_PORT:-}" && "${CI:-}" == "true" ]]; then porta_auto=1; fi
porta="${AB_E2E_PORT:-3197}"
# shellcheck source=scripts/lib/porta-livre.sh
source scripts/lib/porta-livre.sh
if (( ! porta_auto )); then
  if [[ "$porta" == "$porta_producao" ]]; then
    echo "Porta ${porta} e a de producao; use AB_E2E_PORT=<outra>." >&2
    exit 2
  fi
  if ab_porta_em_uso "$porta"; then
    echo "Porta ${porta} ja esta em uso; escolha outra com AB_E2E_PORT=…" >&2
    exit 2
  fi
fi

# `VISUAL_TEST_MODE=1` no SERVIDOR é o que libera `?mock=1` em produção (junto
# do banco *_e2e*). Sem isso o painel serve DADO REAL e telas com data do dia
# divergem do baseline. O CI define a variável no nível do workflow; aqui ela
# precisa ser explícita.
export VISUAL_TEST_MODE=1
export HOSTNAME=127.0.0.1 NODE_ENV=production

echo "→ banco e2e (${DATABASE_URL##*@})…"
PRISMA_TEST_DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy --config prisma.test.config.ts >/dev/null
npm run test:browser:setup

# O build é a metade cara de uma execução que não mudou código nenhum. A marca
# abaixo inclui o conteúdo das fontes rastreadas e novas (exceto Markdown);
# igual à do build anterior, o standalone em disco já serve. `SKIP_BUILD=1`
# continua existindo para forçar na mão.
marca_arvore=""
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  marca_arvore="$(node --input-type=module -e 'import { sourceSnapshot } from "./scripts/lib/release-provenance.mjs"; process.stdout.write(sourceSnapshot().sourceSha256)')"
fi
# Pacotes de fonte sem Git não têm revisão verificável: refazer o build por padrão.
marca_arquivo=".next/.browser-suite-tree"
if [[ "${SKIP_BUILD:-0}" != "1" ]] \
  && [[ -n "$marca_arvore" ]] \
  && [[ -f "$marca_arquivo" ]] \
  && [[ -f ".next/standalone/server.js" ]] \
  && [[ "$(cat "$marca_arquivo")" == "$marca_arvore" ]]; then
  echo "→ build reaproveitado (árvore idêntica à da última execução)."
  SKIP_BUILD=1
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "→ build standalone…"
  # `CI_SKIP_DUPLICATE_TYPECHECK=1`: o build aqui existe para SERVIR as páginas,
  # não para validar tipos — quem faz isso é `check:fast` e o job `verificações` do
  # CI. A segunda passagem de `tsc` multiplicaria o tempo do build.
  #
  # `env -u AUTH_USERS`: exportar a variável ANTES do build a CORROMPE. O
  # `set -a` lá em cima a exporta correta, mas o `@next/env` reexpande o valor
  # por cima do `process.env` e o trecho `$…` do hash some — o build morre em
  # "AUTH_USERS: formato inválido". Sem a variável no ambiente, o Next lê o
  # `.env` sozinho e acerta; o SERVIDOR, que sobe depois, a lê do mesmo jeito.
  CI_SKIP_DUPLICATE_TYPECHECK=1 AB_DEPLOY=1 \
    env -u AUTH_USERS npm run build >"$tmp_dir/build.log" 2>&1 \
    || { tail -30 "$tmp_dir/build.log" >&2; exit 1; }
  # Só depois do build OK: marca inválida faria a próxima execução testar um
  # standalone que não existe.
  if [[ -n "$marca_arvore" ]]; then
    printf '%s' "$marca_arvore" > "$marca_arquivo"
  fi
fi

# Sobe o standalone em "$porta". Saída 3: a porta estava (ou ficou) tomada.
web_pid=""
trap 'if [[ -n "$web_pid" ]]; then kill "$web_pid" 2>/dev/null || true; fi' EXIT
subir_servidor() {
  ab_porta_em_uso "$porta" && return 3
  export PORT="$porta" PLAYWRIGHT_BASE_URL="http://127.0.0.1:${porta}"
  echo "→ servidor isolado em ${PLAYWRIGHT_BASE_URL}…"
  node .next/standalone/server.js >"$tmp_dir/web.log" 2>&1 &
  web_pid=$!
  for _ in $(seq 1 40); do
    kill -0 "$web_pid" 2>/dev/null || break
    curl -fsS "${PLAYWRIGHT_BASE_URL}/login" >/dev/null 2>&1 && break
    sleep 1
  done
  # Responder não basta: PRECISA ser o processo que este script subiu. Se ele
  # morreu (porta tomada, env inválido) e outro servidor atende na mesma porta,
  # a suíte rodaria contra ele — o mesmo risco da porta de produção acima.
  if ! kill -0 "$web_pid" 2>/dev/null || grep -q EADDRINUSE "$tmp_dir/web.log"; then
    grep -q EADDRINUSE "$tmp_dir/web.log" && return 3
    tail -30 "$tmp_dir/web.log" >&2
    echo "o servidor de teste morreu; nada sera executado." >&2
    return 1
  fi
  if ! curl -fsS "${PLAYWRIGHT_BASE_URL}/login" >/dev/null; then
    tail -30 "$tmp_dir/web.log" >&2
    echo "servidor não respondeu em ${PLAYWRIGHT_BASE_URL}" >&2
    return 1
  fi
}

for tentativa in 1 2 3 4 5; do
  if (( porta_auto )); then
    porta="$(ab_porta_livre)"
    [[ "$porta" != "$porta_producao" ]] || continue
  fi
  if subir_servidor; then break; else codigo=$?; fi
  if [[ -n "$web_pid" ]]; then kill "$web_pid" 2>/dev/null || true; web_pid=""; fi
  if (( codigo == 3 && porta_auto && tentativa < 5 )); then
    echo "→ porta ${porta} tomada por outro processo; tentando outra." >&2
    continue
  fi
  if (( codigo == 3 )); then
    echo "Porta ${porta} ja esta em uso; escolha outra com AB_E2E_PORT=…" >&2
    exit 2
  fi
  exit 1
done
[[ -n "$web_pid" ]] || { echo "servidor de teste não subiu." >&2; exit 1; }

if [[ $# -gt 0 ]]; then
  "$@"
else
  bash scripts/run-playwright-canonical.sh \
    node --import tsx node_modules/@playwright/test/cli.js test
fi
