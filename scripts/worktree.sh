#!/usr/bin/env bash
# Worktree de agente, com banco de teste próprio no servidor compartilhado.
#
#   bash scripts/worktree.sh nova <tarefa> <tipo/assunto> [base] [--build]   (base: origin/main)
#   bash scripts/worktree.sh build <tarefa>
#   bash scripts/worktree.sh remover <tarefa>
#   bash scripts/worktree.sh podar
#
# Roda de qualquer checkout do repositório; a worktree é ../wt-<tarefa>, ao
# lado da árvore principal. A tarefa é a-z e 0-9, com hífen entre trechos.
#
# `nova` liga o node_modules da árvore principal, copia o .env dela com o
# TEST_DATABASE_URL no servidor de teste da porta 5433 (o `db-test` do compose)
# e no banco automabaca_test_<tarefa>, e gera o client do Prisma e a ponte Rust
# (rust/crates/dominio-node, com o rust/target da worktree). Cada worktree
# tem a sua família de bancos nesse servidor (scripts/lib/test-databases.mjs):
# as suítes rodam juntas sem esperar umas pelas outras, e não sobra container
# por worktree para morrer quando o PC reinicia.
#
# O Turbopack (build do Next e suíte de navegador) recusa node_modules que
# aponta para fora da worktree. `build` (ou `nova --build`) troca o link por
# uma cópia com hardlinks: ~2 s e sem ocupar disco, mas dependência atualizada
# na árvore principal não chega a ela (aí, `npm ci` na worktree).
#
# `remover` recusa enquanto houver arquivo sem commit ou commit fora do GitHub
# (nem numa branch da origin, nem num PR mergeado), e mostra quais. Depois
# apaga os bancos da worktree, a worktree e a branch local que já entrou na
# main. `podar` apaga os bancos de worktree que já não existe, os que ninguém
# está usando.
set -euo pipefail

lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test-databases.mjs"
porta="${AUTOMABACA_TEST_DB_PORT:-5433}"

falhar() {
  echo "worktree.sh: $*" >&2
  exit 1
}

uso() {
  echo "uso: bash scripts/worktree.sh nova <tarefa> <tipo/assunto> [base] [--build]" >&2
  echo "     bash scripts/worktree.sh build <tarefa>" >&2
  echo "     bash scripts/worktree.sh remover <tarefa>" >&2
  echo "     bash scripts/worktree.sh podar" >&2
  exit 64
}

comum="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
  || falhar "rode de dentro de um checkout do repositório"
principal="$(dirname "$comum")"
raiz="$(dirname "$principal")"
cd "$principal"

# Ponte para scripts/lib/test-databases.mjs. O .env vai pelo disco, e não pela
# linha de comando, onde as senhas apareceriam no `ps`.
bancos() { # base <tarefa> [outras pastas] | env <tarefa> | apagar <tarefa> | podar [pastas]
  node --input-type=module - "$lib" "$principal/.env" "$porta" "$@" <<'JS'
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [lib, arquivoEnv, porta, comando, ...args] = process.argv.slice(2);
const bancos = await import(pathToFileURL(lib).href);
const env = existsSync(arquivoEnv) ? readFileSync(arquivoEnv, "utf8") : "";
const semServidor = (motivo) => process.stderr.write(`aviso: sem conexão com o servidor de teste da porta ${porta} `
  + `(${motivo}); banco que tenha sobrado lá some quando o container reiniciar.\n`);
try {
  if (comando === "base") {
    const [tarefa, ...outras] = args;
    const base = bancos.worktreeTestDatabaseBase(tarefa);
    const outra = bancos.worktreeSharingBase(tarefa, outras);
    if (outra) throw new Error(`a pasta wt-${outra} já cai no banco ${base}; escolha outro nome para a tarefa.`);
    process.stdout.write(base);
  }
  if (comando === "env") process.stdout.write(bancos.worktreeEnvText(env, args[0], porta));
  if (comando === "apagar") {
    const resultado = await bancos.dropWorktreeTestDatabases(env, args[0], porta);
    if ("unreachable" in resultado) semServidor(resultado.unreachable);
    else {
      process.stdout.write(resultado.dropped.length
        ? `→ bancos apagados: ${resultado.dropped.join(", ")}\n`
        : "→ nenhum banco desta worktree no servidor de teste\n");
    }
  }
  if (comando === "podar") {
    const resultado = await bancos.pruneOrphanTestDatabases(env, args, porta);
    if ("unreachable" in resultado) semServidor(resultado.unreachable);
    else {
      process.stdout.write(resultado.dropped.length
        ? `→ bancos apagados: ${resultado.dropped.join(", ")}\n`
        : "→ nenhum banco de worktree que já não existe\n");
      if (resultado.busy.length) process.stdout.write(`→ em uso, ficaram: ${resultado.busy.join(", ")}\n`);
    }
  }
} catch (erro) {
  process.stderr.write(`worktree.sh: ${erro.message}\n`);
  process.exit(1);
}
JS
}

# Nomes das pastas ../wt-*, sem o `wt-`, inclusive as criadas à mão.
pastas_wt() {
  local pasta
  for pasta in "$raiz"/wt-*; do
    [[ -d "$pasta" ]] || continue
    pasta="${pasta##*/}"
    echo "${pasta#wt-}"
  done
}

# Recusa tarefa fora do padrão antes de ela virar caminho: `x/../wt-outra`
# levaria à pasta e aos bancos de outra worktree.
validar_tarefa() { # <tarefa>
  bancos base "$1" >/dev/null
}

# Caminho da worktree ../wt-<tarefa>, conferindo que ela é deste repositório.
worktree_existente() { # <tarefa>
  local destino="$raiz/wt-$1"
  [[ -f "$destino/.git" ]] || falhar "$destino não é uma worktree"
  [[ "$(git -C "$destino" rev-parse --path-format=absolute --git-common-dir)" == "$comum" ]] \
    || falhar "$destino é worktree de outro repositório"
  echo "$destino"
}

# O `rm` tira só o link; se a cópia falhar no meio, o `npm ci` refaz a pasta.
modulos_para_build() { # <destino>
  if [[ -d "$1/node_modules" && ! -L "$1/node_modules" ]]; then
    echo "→ $1/node_modules já é uma pasta da worktree"
    return 0
  fi
  if [[ -L "$1/node_modules" ]]; then rm "$1/node_modules"; fi
  cp -al "$principal/node_modules" "$1/node_modules" \
    || falhar "a cópia com hardlinks falhou; rode npm ci em $1"
  echo "→ node_modules copiado com hardlinks: build e navegador rodam nesta worktree"
}

nova() {
  local para_build=0 argumentos=() argumento
  for argumento in "$@"; do
    if [[ "$argumento" == "--build" ]]; then para_build=1; else argumentos+=("$argumento"); fi
  done
  [[ ${#argumentos[@]} -ge 2 && ${#argumentos[@]} -le 3 ]] || uso
  local tarefa="${argumentos[0]}" branch="${argumentos[1]}" base="${argumentos[2]:-origin/main}"

  # Tudo o que pode recusar vem antes de criar a worktree.
  local banco env outras
  mapfile -t outras < <(pastas_wt)
  banco="$(bancos base "$tarefa" "${outras[@]}")"
  local destino="$raiz/wt-$tarefa"
  [[ ! -e "$destino" ]] || falhar "$destino já existe"
  [[ -d node_modules ]] || falhar "a árvore principal não tem node_modules: rode npm ci em $principal"
  [[ -f .env ]] || echo "aviso: $principal não tem .env; a worktree recebe só o TEST_DATABASE_URL" >&2
  env="$(bancos env "$tarefa")"

  git fetch -q origin || echo "aviso: git fetch falhou; usando a $base que já está aqui" >&2
  git worktree add -q --no-track -b "$branch" "$destino" "$base"
  ln -s "../$(basename "$principal")/node_modules" "$destino/node_modules"
  (umask 077 && printf '%s\n' "$env" >"$destino/.env")
  local saida
  saida="$(cd "$destino" && npx prisma generate 2>&1)" || { echo "$saida" >&2; falhar "prisma generate falhou em $destino"; }
  # A ponte Rust é por worktree: o binário fica em rust/crates/dominio-node dela.
  saida="$(cd "$destino" && npm run --silent build:dominio-node 2>&1)" || { echo "$saida" >&2; falhar "build da ponte Rust falhou em $destino"; }
  echo "→ $destino na branch $branch, a partir de $base"
  echo "→ banco de teste: $banco, no servidor da porta $porta"
  if (( para_build )); then modulos_para_build "$destino"; fi
}

build() {
  [[ $# -eq 1 ]] || uso
  validar_tarefa "$1"
  local destino
  destino="$(worktree_existente "$1")"
  modulos_para_build "$destino"
}

# PR mergeado da branch que contém o commit, como "<número>". Com o squash e o
# `delete_branch_on_merge` do GitHub, a branch some depois do merge e os
# commits dela só continuam lá, no pull/<número>/head.
pr_mergeado() { # <branch> <commit>
  command -v gh >/dev/null || return 0
  local numero cabeca
  while read -r numero cabeca; do
    [[ -n "$numero" ]] || continue
    git fetch -q origin "pull/$numero/head" 2>/dev/null || continue
    if git merge-base --is-ancestor "$2" "$cabeca" 2>/dev/null; then
      echo "$numero"
      return 0
    fi
  done < <(gh pr list --state merged --head "$1" --json number,headRefOid \
    --jq '.[] | "\(.number) \(.headRefOid)"' 2>/dev/null || true)
}

remover() {
  [[ $# -eq 1 ]] || uso
  local tarefa="$1" destino
  validar_tarefa "$tarefa"
  destino="$(worktree_existente "$tarefa")"

  local sujos
  sujos="$(git -C "$destino" status --porcelain --untracked-files=all)"
  if [[ -n "$sujos" ]]; then
    echo "worktree.sh: $destino tem arquivo sem commit. Faça o commit numa branch e envie ao GitHub antes de remover:" >&2
    echo "$sujos" >&2
    exit 1
  fi

  git fetch -q origin || echo "aviso: git fetch falhou; conferindo com as branches da origin que já estão aqui" >&2
  local branch commit pr=""
  branch="$(git -C "$destino" symbolic-ref --quiet --short HEAD || true)"
  commit="$(git -C "$destino" rev-parse HEAD)"
  [[ -z "$branch" ]] || pr="$(pr_mergeado "$branch" "$commit")"
  local fora
  # Só a origin é o GitHub do projeto; outro remoto (espelho, fork) não conta.
  fora="$(git log --oneline "$commit" --not --remotes=origin)"
  if [[ -n "$fora" && -z "$pr" ]]; then
    echo "worktree.sh: commit fora do GitHub (nem numa branch da origin, nem num PR mergeado). Envie antes de remover:" >&2
    echo "$fora" >&2
    exit 1
  fi

  bancos apagar "$tarefa"
  git worktree remove "$destino"
  echo "→ worktree $destino removida"
  [[ -n "$branch" ]] || return 0
  if [[ -n "$pr" ]] || git merge-base --is-ancestor "$commit" origin/main 2>/dev/null; then
    git branch -q -D "$branch"
    echo "→ branch $branch apagada: já entrou na main${pr:+ pelo PR #$pr}"
  else
    echo "→ branch $branch mantida: ainda não entrou na main"
  fi
}

podar() {
  [[ $# -eq 0 ]] || uso
  local pastas
  mapfile -t pastas < <(pastas_wt)
  bancos podar "${pastas[@]}"
}

case "${1:-}" in
  nova) shift && nova "$@" ;;
  build) shift && build "$@" ;;
  remover) shift && remover "$@" ;;
  podar) shift && podar "$@" ;;
  *) uso ;;
esac
