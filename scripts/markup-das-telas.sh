#!/usr/bin/env bash
# Rede de regressão de markup das telas do painel, sob demanda (fora da CI).
# Gera o HTML de cada tela/aba/estado (tests/painel/markup-das-telas.test.tsx)
# na árvore atual e numa ref base, e mostra o que mudou.
#
#   bash scripts/markup-das-telas.sh                 # compara com origin/main
#   bash scripts/markup-das-telas.sh HEAD            # só o que não foi commitado
#   MARKUP_DIR=/tmp/mk bash scripts/markup-das-telas.sh v1   # guarda a saída ali
#
# A base roda o gerador da árvore ATUAL (o arquivo de teste é copiado para
# ela), com o node_modules e o client Prisma daqui: a comparação mede as telas,
# não diferenças entre versões do gerador.
set -euo pipefail

cd "$(dirname "$0")/.."
repo="$(pwd)"
base_ref="${1:-origin/main}"
teste="tests/painel/markup-das-telas.test.tsx"

base_sha="$(git rev-parse --verify --quiet "${base_ref}^{commit}")" || {
  echo "Ref base desconhecida: $base_ref" >&2
  exit 2
}

out="${MARKUP_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/markup-das-telas.XXXXXX")}"
if [[ -e "$out/atual" || -e "$out/base" ]]; then
  echo "$out já tem uma comparação; aponte MARKUP_DIR para um diretório novo." >&2
  exit 2
fi
mkdir -p "$out"
fonte_base="$(mktemp -d "${TMPDIR:-/tmp}/markup-base.XXXXXX")"

# O worktree leva junto os links e cópias que o script pôs nele.
limpar() {
  git -C "$repo" worktree remove --force "$fonte_base/src" >/dev/null 2>&1 || true
  rmdir "$fonte_base" 2>/dev/null || true
}
trap limpar EXIT

# Fuso fixo: as datas das telas saem no fuso do processo.
export TZ=America/Sao_Paulo VITE_CONFIG_NATIVE_IGNORE_WARNING=true

gerar() { # $1 = diretório do código, $2 = saída
  (cd "$1" && MARKUP_OUT="$2" npx vitest run --project unit "$teste" --reporter=dot >"$2.log" 2>&1) || {
    echo "Falha ao gerar o markup em $1 (log: $2.log):" >&2
    tail -n 30 "$2.log" >&2
    exit 1
  }
}

echo "Gerando o markup da árvore atual ($(git rev-parse --short HEAD)$(git diff --quiet HEAD -- || echo ' + alterações locais'))…"
gerar "$repo" "$out/atual"

echo "Gerando o markup da base $base_ref ($(git rev-parse --short "$base_sha"))…"
git worktree add --detach --quiet "$fonte_base/src" "$base_sha"
ln -s "$(realpath "$repo/node_modules")" "$fonte_base/src/node_modules"
[[ -e "$fonte_base/src/src/generated" ]] || ln -s "$(realpath "$repo/src/generated")" "$fonte_base/src/src/generated"
[[ -f "$repo/.env" ]] && cp "$repo/.env" "$fonte_base/src/.env"
mkdir -p "$fonte_base/src/$(dirname "$teste")"
cp "$repo/$teste" "$fonte_base/src/$teste"
gerar "$fonte_base/src" "$out/base"

total="$(find "$out/atual" -name '*.html' | wc -l)"
mudaram="$(diff -rq "$out/base" "$out/atual" || true)"
echo
if [[ -z "$mudaram" ]]; then
  echo "Markup idêntico: $total arquivos iguais entre $base_ref e a árvore atual."
  echo "Saída: $out"
  exit 0
fi
echo "Markup diferente em $(grep -c . <<<"$mudaram") de $total arquivos (base → atual):"
# Por tela/variante, sem largura e tema, para o resumo caber na tela.
sed -E 's#^Files .*/base/(.*)\.html and .*#\1#; s#^Only in .*/(base|atual): (.*)\.html#\2 (só na \1)#' <<<"$mudaram" \
  | sed -E 's/-(ssr-)?(390|1440)-(light|dark)( |$)/\4/' | sort | uniq -c | sort -rn | head -n 60
echo
echo "Linhas alteradas no total: $(diff -r "$out/base" "$out/atual" | grep -c '^[<>]' || true)"
echo "Saída: $out  (ex.: diff -u $out/base/<arquivo> $out/atual/<arquivo>)"
exit 1
