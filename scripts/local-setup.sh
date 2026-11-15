#!/usr/bin/env bash
# Prepara uma estação local com bancos Docker e ambiente de desenvolvimento.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$EUID" -eq 0 ]]; then
  echo "dev:setup deve rodar como usuário normal, não root." >&2
  exit 1
fi
for command_name in node npm docker cargo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "dependência ausente: $command_name" >&2
    exit 1
  fi
done
npm run toolchain:check
if ! docker info >/dev/null 2>&1; then
  echo "Docker não está acessível para $(whoami)." >&2
  exit 1
fi

node scripts/init-local-env.mjs
docker compose -f docker-compose.dev.yml up -d --wait
npm ci --no-audit --fund=false
(cd rust && rustup toolchain install)
npm run build:dominio-node
npm run prisma:deploy
npm run prisma:seed

if [[ "${1:-}" == "--with-browser" ]]; then
  npx playwright install --with-deps chromium
fi

echo "✓ ambiente local pronto."
echo "  aplicação + worker: npm run dev:local → http://127.0.0.1:3100"
