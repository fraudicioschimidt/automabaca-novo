#!/usr/bin/env bash
# Poda o peso derivável das evidências de release e as imagens da aplicação
# que só serviam a releases antigas, preservando a auditoria. O publicar.sh
# roda isto (--apagar) depois de cada publicação.
#
# Cada diretório em evidence/releases/<tag>/ ocupa ~650 MB, e quase tudo é
# derivado: `verified-runtime` é o artefato da CI extraído, `web-layer` e
# `worker-layer` são os contextos de build montados a partir dele. O que prova
# o que foi publicado são os arquivos de poucos KB — release.json,
# publication.json, images.json, os logs e o manifesto — e esses NUNCA saem.
#
# A release em produção e a anterior (alvo de rollback) ficam intactas, com as
# imagens delas: são lidas do compose vivo e do release.json dela, não de uma
# lista escrita à mão que envelhece.
#
# A remoção de pastas passa por ab_safe_remove_tree, que recusa alvo fora da
# raiz gerenciada, symlink e travessia de sistema de arquivos. Imagem sai por
# `docker image rm` de cada referência, sem -f: a que um container usa fica.
#
# Uso:  sudo ./limpar-evidencias.sh            (só mostra o que sairia)
#       sudo ./limpar-evidencias.sh --apagar   (apaga de verdade)
#
# Com pipefail, nada aqui corta a saída de um pipe (`head`): o comando da
# esquerda levaria SIGPIPE e o script abortaria sem podar. Quem lê só o começo
# é o `sed -n`, que lê tudo.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/lib/safe-delete.sh
source "$AQUI/../scripts/lib/safe-delete.sh"

RAIZ=${AUTOMABACA_EVIDENCE_DIR:-/srv/apps/automabaca-novo/evidence/releases}
COMPOSE=${AUTOMABACA_COMPOSE:-/srv/apps/automabaca-novo/deploy/compose.yaml}
MANTER_ARTEFATO=${MANTER_ARTEFATO:-5}
APAGAR=0
[[ "${1:-}" == "--apagar" ]] && APAGAR=1

[[ -d "$RAIZ" ]] || { echo "Sem $RAIZ nesta máquina."; exit 0; }

# A release viva vem do compose; sem conseguir lê-la não há como saber o que
# proteger, e apagar às cegas é exatamente o que este script existe para evitar.
if ! EM_PRODUCAO=$(grep -m1 -oP 'AUTOMABACA_RELEASE_ID:\s*\K\S+' "$COMPOSE" 2>/dev/null) || [[ -z "$EM_PRODUCAO" ]]; then
  echo "ABORTADO: não consegui ler a release publicada em $COMPOSE." >&2
  echo "Rode com sudo, ou aponte AUTOMABACA_COMPOSE para o arquivo certo." >&2
  exit 1
fi

# A anterior é a base registrada pela release viva — quem o rollback restaura.
ANTERIOR=$(grep -oP '"baseRelease":\s*"\K[^"]+' "$RAIZ/$EM_PRODUCAO/release.json" 2>/dev/null || true)

echo "Em produção: $EM_PRODUCAO"
echo "Rollback:    ${ANTERIOR:-<nenhuma registrada>}"
echo

DERIVADAS=(verified-runtime web-layer worker-layer)
recentes=$(ls -1t "$RAIZ" | sed -n "1,${MANTER_ARTEFATO}p" | tr '\n' ' ')
alvos=() files=()

for dir in "$RAIZ"/*/; do
  tag=${dir%/}; tag=${tag##*/}
  [[ "$tag" == "$EM_PRODUCAO" || "$tag" == "$ANTERIOR" ]] && continue
  for sub in "${DERIVADAS[@]}"; do
    [[ -d "$dir$sub" ]] && alvos+=("${dir}${sub}")
  done
  # O runtime do artefato da CI sai depois das 5 mais recentes; o manifesto
  # dele, que prova o conteúdo da imagem, fica.
  [[ " $recentes " == *" $tag "* ]] || { [[ -f "${dir}artifact/runtime.tar.gz" ]] && files+=("${dir}artifact/runtime.tar.gz"); }
done

if [[ $(( ${#alvos[@]} + ${#files[@]} )) -eq 0 ]]; then
  echo "Nada derivável para podar."
else
  echo "$(( ${#alvos[@]} + ${#files[@]} )) pasta(s) e runtime(s) deriváveis:"
  du -sh "${alvos[@]}" "${files[@]}" 2>/dev/null | sort -rh | sed -n 1,15p
  echo "..."
  du -sh --total "${alvos[@]}" "${files[@]}" 2>/dev/null | tail -1
fi

# Imagens da aplicação: ficam as da viva e as da base de rollback (o publish.py
# exige a da base localmente), pelos IDs do images.json de cada uma, e as de
# qualquer container, parado ou não: `image rm` sem -f não as tira, e a falha
# se repetiria a cada publicação. Cada imagem tem duas referências (a tag local
# da release e a do registry); só tirar uma não libera nada. Sem os IDs das
# duas releases e dos containers da aplicação, nenhuma imagem sai.
APP_IMAGES='^(ghcr\.io/fraudicioschimidt/)?automabaca-novo-(web|worker):'
keep_ids="" reason="" images=()
if [[ -z "$ANTERIOR" ]]; then
  reason="sem a release de rollback registrada"
else
  for tag in "$EM_PRODUCAO" "$ANTERIOR"; do
    ids=$(grep -oE 'sha256:[0-9a-f]{64}' "$RAIZ/$tag/images.json" 2>/dev/null | sort -u || true)
    if [[ $(grep -c . <<<"$ids") -ne 2 ]]; then
      reason="não li as duas imagens em $tag/images.json"
      break
    fi
    keep_ids+="$ids"$'\n'
  done
fi
if [[ -z "$reason" ]]; then
  if live_ids=$(docker inspect --format '{{.Image}}' automabaca-novo-web automabaca-novo-worker 2>/dev/null) \
      && container_ids=$(docker ps -aq --no-trunc | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null); then
    keep_ids+="$live_ids"$'\n'"$container_ids"
  else
    reason="não consegui ler as imagens dos containers"
  fi
fi
echo
if [[ -n "$reason" ]]; then
  echo "Nenhuma imagem sai: $reason."
else
  while read -r id ref; do
    [[ "$ref" =~ $APP_IMAGES && "$ref" != *:"<none>" ]] || continue
    grep -qxF "$id" <<<"$keep_ids" || images+=("$ref")
  done < <(docker image ls --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}')
  echo "${#images[@]} referência(s) de imagem da aplicação fora da viva, da de rollback e dos containers."
  [[ ${#images[@]} -eq 0 ]] || printf '  %s\n' "${images[@]:0:15}"
fi

if [[ $APAGAR -eq 0 ]]; then
  echo
  echo "Nada foi apagado. Para apagar: $0 --apagar"
  exit 0
fi

if [[ $(( ${#alvos[@]} + ${#files[@]} )) -gt 0 ]]; then
  ab_initialize_managed_delete_root "$RAIZ"
  for alvo in "${alvos[@]}"; do
    ab_safe_remove_tree "$RAIZ" "${alvo%/}"
  done
  for file in "${files[@]}"; do
    ab_safe_remove_file "$RAIZ" "$file"
  done
  echo
  echo "Podado. evidence/releases agora: $(du -sh "$RAIZ" 2>/dev/null | cut -f1)"
  echo "Nenhum release.json, publication.json, images.json, manifesto ou log foi tocado."
fi

failures=0
for ref in "${images[@]}"; do
  docker image rm "$ref" >/dev/null || failures=$((failures + 1))
done
if [[ ${#images[@]} -gt 0 ]]; then
  echo "Imagens: $(( ${#images[@]} - failures )) referência(s) removida(s)."
fi
if [[ $failures -gt 0 ]]; then
  echo "AVISO: $failures referência(s) de imagem não saíram (o motivo do docker está acima)." >&2
  exit 1
fi
