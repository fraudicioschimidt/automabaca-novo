#!/usr/bin/env bash
# Publica sozinho o commit mais novo da `main` com a CI verde.
#
# Roda na VPS, no crontab do usuário `deploy`, a cada minuto (instalado por
# `scripts/publicador-automatico-instalar.sh`). Usa o `gh` desse usuário para
# ler a CI e chama o `deploy/publicar.sh` direto, como o usuário `deploy`; a CI
# continua sem acesso nenhum à VPS.
#
# Não decide nada que o `deploy/publicar.sh` já decida: ele só o chama, do jeito
# que o AGENTS.md manda, para o commit escolhido. As guardas continuam lá
# (CI, deriva, migration, reversão automática). Passa sempre
# `--com-migration`: sem migration na release não muda nada; com migration, o
# `deploy/migrar.py` aplica só a que ele aprova (aditiva, depois do backup
# conferido) e recusa as outras com saída 2.
#
# A cada minuto, do topo da main para trás até o que está no ar, pega o commit
# mais novo com a CI verde (inclusive imagens) ainda não tratado. Por commit, uma vez:
#   - nenhum verde (CI rodando, sem imagens) → espera;
#   - a busca para no primeiro commit já tratado (recusado, falhou, pulado): o
#     que vem antes dele não sai sozinho;
#   - commit anterior ao topo com migration depois dele → espera o topo, para as
#     migrations saírem juntas;
#   - já no ar → marca "no ar";
#   - desde a release no ar só mudou documentação (*.md, docs/) → marca "pulado",
#     a mesma regra do AGENTS.md (o próximo deploy de código leva a documentação);
#   - senão publica. Saída 2 (uma guarda recusou; por exemplo migration que o
#     migrar.py não aprova, que sai à mão com o dono) → marca "recusado" e NÃO
#     tenta de novo.
#     Saída 4 (causa passageira: produção não saudável antes de publicar,
#     rede no download do artefato ou no pull das imagens; nada foi trocado) →
#     tenta de novo a cada 5 min, até 8 vezes; depois marca "falhou".
#     Outra falha → marca "falhou" e também não repete: falha de publicação é
#     para uma pessoa olhar (AGENTS.md: "pare e relate").
#
# Estado e log em ~/.local/state/automabaca/ (log `publicador.log`, até ~1 MB
# mais o anterior). `tratados/<sha>` guarda o que foi feito com cada commit;
# apagar o arquivo faz o publicador tentar aquele commit de novo.
# `tentativas/<sha>` conta as tentativas com causa passageira.
#
# Commit marcado "recusado" ou "FALHOU" vira um aviso no Telegram do dono, uma
# vez por commit, por `lib/notificar-telegram.sh`: o texto espera em
# `avisos/<sha>` até o envio dar certo. Sem a configuração de lá, fica só no log.
#
#   bash scripts/publicador-automatico.sh --simular   diz na tela o que faria
set -euo pipefail

REPO=fraudicioschimidt/automabaca-novo
PUBLICAR="${AUTOMABACA_PUBLICAR:-/srv/apps/automabaca-novo/source/deploy/publicar.sh}"
HEALTH=https://v2.fraudicio.com.br/api/health
JOB_IMAGENS="imagens publicadas no registry"
MAX_TENTATIVAS=8
ESPERA_ENTRE_TENTATIVAS_S=300

estado="${XDG_STATE_HOME:-$HOME/.local/state}/automabaca"
tratados="$estado/tratados"
tentativas="$estado/tentativas"
log="$estado/publicador.log"
avisos="$estado/avisos"
mkdir -p "$tratados" "$tentativas" "$avisos"

# Cópia instalada antes de a biblioteca existir segue publicando, sem avisar.
notificar_telegram() { return 2; }
biblioteca="$(dirname "${BASH_SOURCE[0]}")/lib/notificar-telegram.sh"
# shellcheck source=scripts/lib/notificar-telegram.sh
[[ ! -f "$biblioteca" ]] || source "$biblioteca"

simular=0
[[ "${1:-}" == --simular ]] && simular=1
exec 9>"$estado/publicador.lock"
flock -n 9 || { (( ! simular )) || echo "outra execução do publicador está rodando (uma publicação?); simule depois"; exit 0; }

if (( ! simular )); then
  if [[ -f "$log" ]] && (( $(stat -c %s "$log") > 1048576 )); then
    mv -f "$log" "$log.1"
  fi
  exec >>"$log" 2>&1
fi

registrar() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Uma linha no log por MUDANÇA de situação, não uma por minuto.
situacao() {
  local texto="$1" arquivo="$estado/situacao"
  (( ! simular )) || { registrar "(simulação) $texto"; return; }
  if [[ "$(cat "$arquivo" 2>/dev/null || true)" != "$texto" ]]; then
    printf '%s\n' "$texto" > "$arquivo"
    registrar "$texto"
  fi
}

marcar() {
  local sha="$1" resultado="$2"
  (( ! simular )) || { registrar "(simulação) ${sha:0:7}: marcaria \"$resultado\""; return; }
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$resultado" > "$tratados/$sha"
  registrar "${sha:0:7}: $resultado"
}

# Avisos que esperam envio: o que não saiu (rede caída na hora da falha) sai
# numa volta seguinte; enviado ou sem configuração, o arquivo some.
enviar_avisos() {
  local arquivo codigo
  for arquivo in "$avisos"/*; do
    [[ -f "$arquivo" ]] || continue
    codigo=0
    notificar_telegram "$(cat "$arquivo")" || codigo=$?
    case "$codigo" in
      0) registrar "$(basename "$arquivo" | cut -c1-7): aviso enviado ao Telegram" ;;
      2) registrar "$(basename "$arquivo" | cut -c1-7): sem ~/.config/automabaca/notificar.env válido; não avisei no Telegram" ;;
      *) continue ;;
    esac
    rm -f "$arquivo"
  done
}

# Publicação que parou e precisa de uma pessoa: guarda o aviso e tenta enviar.
avisar() {
  local sha="$1" titulo="$2" motivo
  # O fim da saída do publicar.sh é onde a guarda ou o erro se explicam.
  motivo="$(grep -v '^[[:space:]]*$' "$saida" 2>/dev/null | tail -n 4 | cut -c1-300 || true)"
  printf '%s\ncommit %s\n%s\n👉 Log: %s na VPS; e evidence/releases.\n' \
    "$titulo" "${sha:0:7}" "${motivo:-(o publicar.sh não disse o motivo)}" "$log" > "$avisos/$sha"
  enviar_avisos
}

(( simular )) || enviar_avisos
(( simular )) || find "$tratados" "$tentativas" "$avisos" -maxdepth 1 -type f -mtime +60 -print0 | xargs -0 -r rm -f

topo="$(gh api "repos/$REPO/commits/main" --jq .sha 2>/dev/null)" || { situacao "gh api falhou; tento no próximo minuto"; exit 0; }
[[ "$topo" =~ ^[0-9a-f]{40}$ ]] || { situacao "resposta inesperada do gh: $topo"; exit 0; }
# Commit já tratado: registra "em dia" uma vez, para uma falha passageira
# (gh, rede) não ficar como última linha do log depois de resolvida.
[[ -f "$tratados/$topo" ]] && { situacao "${topo:0:7}: em dia ($(cut -d" " -f2- "$tratados/$topo"))"; exit 0; }
curto="${topo:0:7}"

# CI do check.yml na main para um commit, procurada em `execucoes` (abaixo):
# "<execução> <situação>", com situação "verde" (terminou bem e com as imagens),
# "rodando", "sem-ci" ou o desfecho.
ci_do_commit() {
  local sha="$1" execucao status conclusao imagens
  read -r execucao status conclusao < <(awk -v s="$sha" '$1 == s { print $2, $3, $4; exit }' <<<"$execucoes"; echo) || true
  if [[ -z "$execucao" ]]; then echo "- sem-ci"; return; fi
  if [[ "$status" != completed ]]; then echo "$execucao rodando"; return; fi
  if [[ "$conclusao" != success ]]; then echo "$execucao $conclusao"; return; fi
  imagens="$(gh run view "$execucao" -R "$REPO" --json jobs \
    --jq ".jobs[] | select(.name == \"$JOB_IMAGENS\") | .conclusion" 2>/dev/null || true)"
  [[ "$imagens" == success ]] && echo "$execucao verde" || echo "$execucao imagens-$imagens"
}

# O que está no ar, visto de fora (o mesmo /api/health que o publicar.sh confere).
no_ar="$(curl -fsS --max-time 20 "$HEALTH" 2>/dev/null | sed -n 's/.*"release":"\([0-9a-f]\{7,40\}\)".*/\1/p' || true)"
if [[ -n "$no_ar" && "$topo" == "$no_ar"* ]]; then
  marcar "$topo" "no ar"
  exit 0
fi

# O alvo é o commit mais novo da main à frente do que está no ar com a CI verde,
# do topo para trás. Com merges seguidos, a CI do topo ainda roda enquanto a de
# um commit anterior já terminou: ele sai na frente, e o topo vem na volta
# seguinte. A busca para no primeiro commit já tratado.
candidatos=("$topo")
if [[ -n "$no_ar" ]]; then
  mapfile -t candidatos < <(gh api "repos/$REPO/compare/$no_ar...$topo" \
    --jq '[.commits[].sha] | reverse | .[]' 2>/dev/null || echo "$topo")
fi
# As execuções recentes do check.yml na main numa consulta só, em vez de uma por
# commit: "<sha> <execução> <status> <desfecho>", da mais nova para a mais velha.
execucoes="$(gh run list -R "$REPO" --workflow check.yml --branch main --event push --limit 40 \
  --json headSha,databaseId,status,conclusion \
  --jq '.[] | "\(.headSha) \(.databaseId) \(.status) \(if (.conclusion // "") == "" then "-" else .conclusion end)"' 2>/dev/null)" \
  || { situacao "gh run list falhou; tento no próximo minuto"; exit 0; }
alvo="" execucao="" espera=""
for c in "${candidatos[@]}"; do
  [[ "$c" =~ ^[0-9a-f]{40}$ ]] || continue
  # Depois de uma recusa ou falha, o que vem antes não sai sozinho.
  [[ -f "$tratados/$c" ]] && break
  read -r exec_c situacao_c < <(ci_do_commit "$c") || continue
  if [[ "$situacao_c" == verde ]]; then alvo="$c"; execucao="$exec_c"; break; fi
  # Só a situação do mais novo vira a linha de espera do log.
  [[ -n "$espera" ]] || espera="${c:0:7}: CI da main $situacao_c$([[ "$exec_c" == - ]] || echo " (execução $exec_c)")"
done
if [[ -z "$alvo" ]]; then situacao "${espera:-${topo:0:7}: nada novo com a CI verde}"; exit 0; fi
curto="${alvo:0:7}"

# Commit anterior ao topo só sai se nenhuma migration vem depois dele: as de PRs
# próximos saem juntas, com um backup e uma parada do worker só.
if [[ "$alvo" != "$topo" ]]; then
  depois="$(gh api "repos/$REPO/compare/$alvo...$topo" \
    --jq 'if (.files | length) < 300 then .files[].filename else "(muitos)" end' 2>/dev/null)" \
    || { situacao "$curto: verde, mas a comparação com o topo falhou; tento no próximo minuto"; exit 0; }
  if grep -qE '^(prisma/migrations/|\(muitos\)$)' <<<"$depois"; then
    situacao "$curto: verde, mas vem migration depois dele; espero a CI do topo ${topo:0:7} para as migrations saírem juntas"
    exit 0
  fi
fi

if [[ -n "$no_ar" ]]; then
  # Até 300 arquivos a API lista todos; com mais, trata como código.
  arquivos="$(gh api "repos/$REPO/compare/$no_ar...$alvo" --jq 'if (.files | length) < 300 then .files[].filename else "(muitos)" end' 2>/dev/null)" \
    || arquivos="(comparação falhou)"
  if [[ -z "$arquivos" ]] || ! grep -qvE '(\.md$|^docs/)' <<<"$arquivos"; then
    marcar "$alvo" "pulado: desde ${no_ar:0:7} (no ar) só mudou documentação"
    exit 0
  fi
fi

# Depois de uma causa passageira, dá tempo para ela passar.
if [[ -f "$tentativas/$alvo" ]] && (( $(date +%s) - $(stat -c %Y "$tentativas/$alvo") < ESPERA_ENTRE_TENTATIVAS_S )); then
  (( ! simular )) || registrar "(simulação) $curto: esperando para tentar de novo depois de uma causa passageira"
  exit 0
fi

(( ! simular )) || { registrar "(simulação) publicaria $curto (CI verde na execução $execucao; no ar: ${no_ar:-?}; topo: ${topo:0:7})"; exit 0; }
registrar "$curto: publicando (CI verde na execução $execucao; no ar: ${no_ar:-?}; topo: ${topo:0:7})"
saida="$(mktemp)"
trap 'rm -f "$saida"' EXIT
set +e
# Na própria VPS: o `publicar.sh` roda até o fim, com a reversão automática
# dele, e a saída vai para o log e para o motivo do aviso.
bash "$PUBLICAR" --nome "auto-$curto" --commit "$alvo" --com-migration </dev/null 2>&1 | tee "$saida"
codigo=${PIPESTATUS[0]}
set -e

case "$codigo" in
  0)
    rm -f "$tentativas/$alvo"
    marcar "$alvo" "publicado" ;;
  2)
    if grep -q "outra publicação está em andamento" "$saida"; then
      situacao "$curto: outra publicação em andamento; tento de novo no próximo minuto"
    elif grep -q "anterior ao que está no ar" "$saida"; then
      marcar "$alvo" "superado: a produção já estava à frente dele"
    else
      marcar "$alvo" "recusado por uma guarda (saída 2): publique à mão, com o dono (motivo acima)"
      avisar "$alvo" "⛔ Publicação recusada por uma guarda (saída 2): sai à mão, com o dono"
    fi ;;
  4)
    feitas=$(( $(cat "$tentativas/$alvo" 2>/dev/null || echo 0) + 1 ))
    if (( feitas >= MAX_TENTATIVAS )); then
      rm -f "$tentativas/$alvo"
      marcar "$alvo" "FALHOU: a causa passageira (saída 4) não passou em $feitas tentativas; veja o motivo acima; não tento de novo"
      avisar "$alvo" "❌ Publicação FALHOU: a causa passageira (saída 4) não passou em $feitas tentativas"
    else
      printf '%s\n' "$feitas" > "$tentativas/$alvo"
      situacao "$curto: causa passageira (saída 4, motivo acima), tentativa $feitas de $MAX_TENTATIVAS; tento de novo em $(( ESPERA_ENTRE_TENTATIVAS_S / 60 )) min"
    fi ;;
  *)
    marcar "$alvo" "FALHOU (saída $codigo): veja o log acima e a pasta evidence/releases na VPS; não tento de novo"
    avisar "$alvo" "❌ Publicação FALHOU (saída $codigo): não tento de novo" ;;
esac
