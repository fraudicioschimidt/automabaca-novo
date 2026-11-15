#!/usr/bin/env bash
# Exclusoes locais centralizadas. Todo chamador deve trabalhar sob uma raiz
# gerenciada e marcada; caminho vazio, raiz do sistema e symlink falham fechados.

AB_DELETE_MARKER_NAME=".automabaca-managed-delete-root"
AB_DELETE_MARKER_VALUE="automabaca-managed-delete-root:v1"

ab_delete_error() {
  echo "exclusao recusada: $*" >&2
  return 1
}

ab_canonical_path() {
  [[ -n "${1:-}" ]] || return 1
  realpath -m -- "$1"
}

# Raízes em uso hoje. Único chamador: deploy/limpar-evidencias.sh. Raiz nova
# entra aqui junto com o script que a usa.
ab_delete_root_allowed() {
  case "$1" in
    /srv/apps/automabaca-novo/evidence/releases)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

ab_initialize_managed_delete_root() {
  [[ "$#" -eq 1 ]] || { ab_delete_error "raiz gerenciada exige um argumento"; return 1; }
  local root marker temp
  root="$(ab_canonical_path "$1")" || { ab_delete_error "raiz vazia"; return 1; }
  ab_delete_root_allowed "$root" || { ab_delete_error "raiz nao autorizada: $root"; return 1; }
  [[ -d "$root" && ! -L "$root" ]] || { ab_delete_error "raiz ausente ou symlink: $root"; return 1; }

  marker="$root/$AB_DELETE_MARKER_NAME"
  if [[ -f "$marker" && ! -L "$marker" && "$(cat "$marker")" == "$AB_DELETE_MARKER_VALUE" ]]; then
    return 0
  fi
  temp="${marker}.tmp.$$"
  printf '%s\n' "$AB_DELETE_MARKER_VALUE" > "$temp"
  chmod 600 "$temp"
  mv -f -- "$temp" "$marker"
}

ab_assert_managed_delete_root() {
  [[ "$#" -eq 1 ]] || { ab_delete_error "validacao de raiz exige um argumento"; return 1; }
  local root marker
  root="$(ab_canonical_path "$1")" || { ab_delete_error "raiz vazia"; return 1; }
  ab_delete_root_allowed "$root" || { ab_delete_error "raiz nao autorizada: $root"; return 1; }
  [[ -d "$root" && ! -L "$root" ]] || { ab_delete_error "raiz ausente ou symlink: $root"; return 1; }
  marker="$root/$AB_DELETE_MARKER_NAME"
  [[ -f "$marker" && ! -L "$marker" ]] || { ab_delete_error "marcador ausente em $root"; return 1; }
  [[ "$(cat "$marker")" == "$AB_DELETE_MARKER_VALUE" ]] || {
    ab_delete_error "marcador invalido em $root"
    return 1
  }
  printf '%s\n' "$root"
}

ab_validate_delete_target() {
  [[ "$#" -eq 2 ]] || { ab_delete_error "validacao exige raiz e alvo"; return 1; }
  local root target
  root="$(ab_assert_managed_delete_root "$1")" || return 1
  [[ -n "${2:-}" && "$2" == /* ]] || { ab_delete_error "alvo vazio ou relativo"; return 1; }
  [[ ! -L "$2" ]] || { ab_delete_error "alvo symlink recusado: $2"; return 1; }
  target="$(ab_canonical_path "$2")" || { ab_delete_error "alvo invalido"; return 1; }
  [[ "$target" != "$root" && "$target" == "$root/"* ]] || {
    ab_delete_error "alvo fora da raiz gerenciada: $target"
    return 1
  }
  printf '%s\n' "$target"
}

ab_safe_remove_tree() {
  [[ "$#" -eq 2 ]] || { ab_delete_error "remocao recursiva exige raiz e alvo"; return 1; }
  local target
  target="$(ab_validate_delete_target "$1" "$2")" || return 1
  [[ ! -e "$target" ]] && return 0
  [[ -d "$target" && ! -L "$target" ]] || { ab_delete_error "alvo nao e diretorio real: $target"; return 1; }
  rm -rf --one-file-system -- "$target"
}

ab_safe_remove_file() {
  [[ "$#" -eq 2 ]] || { ab_delete_error "remocao de arquivo exige raiz e alvo"; return 1; }
  local target
  target="$(ab_validate_delete_target "$1" "$2")" || return 1
  [[ ! -e "$target" ]] && return 0
  [[ -f "$target" && ! -L "$target" ]] || { ab_delete_error "alvo nao e arquivo real: $target"; return 1; }
  rm -f -- "$target"
}

ab_safe_delete_old_files() {
  [[ "$#" -eq 3 ]] || { ab_delete_error "rotacao exige raiz, dias e padrao"; return 1; }
  local root days pattern
  root="$(ab_assert_managed_delete_root "$1")" || return 1
  days="$2"
  pattern="$3"
  [[ "$days" =~ ^[0-9]+$ && "$days" -le 3650 ]] || { ab_delete_error "retencao invalida"; return 1; }
  [[ "$pattern" == "*" || "$pattern" =~ ^\*\.[A-Za-z0-9._-]+$ ]] || {
    ab_delete_error "padrao de arquivo invalido"
    return 1
  }
  find "$root" -mindepth 1 -maxdepth 1 -type f -name "$pattern" -mtime "+$days" -delete
}
