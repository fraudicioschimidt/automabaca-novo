#!/usr/bin/env bash
# Vigia a produção de FORA da VPS e avisa o dono no Telegram.
#
# Todo outro alerta sai do worker, dentro da VPS: se ela cair inteira (host,
# rede, Caddy, banco), ninguém avisa. Este roda no PC do dono, no crontab do
# `fabricio`, a cada minuto (instalado por `scripts/vigia-externo-instalar.sh`).
#
# A cada minuto lê o /api/health público. É falha: sem resposta em 10 s, HTTP
# fora de 200, `ok` ou `worker` falso, heartbeat do worker que não é `fresh`.
#   - 3ª falha seguida → UM aviso dizendo o que falhou;
#   - enquanto durar → repete o aviso no máximo a cada 30 min;
#   - voltou → um aviso de recuperação, com a duração.
# PC sem rede (um destino neutro também não responde) não conta como falha da
# produção, e minutos em que o PC esteve desligado ou suspenso não são
# "seguidos": depois de um intervalo sem voltas, a contagem recomeça.
#
# O aviso sai por `lib/notificar-telegram.sh`. Sem o arquivo de configuração de
# lá, o vigia registra no log e segue sem avisar.
#
# Estado em ~/.local/state/automabaca/vigia-externo.estado; log em
# vigia-externo.log (uma linha por mudança de situação, até ~256 KB mais o
# anterior).
#
# Variáveis para teste: VIGIA_HEALTH_URL e VIGIA_NEUTRAL_URL.
set -euo pipefail

HEALTH="${VIGIA_HEALTH_URL:-https://v2.fraudicio.com.br/api/health}"
# Responde 204 sem corpo; só serve para saber se o PC tem DNS e rota.
NEUTRO="${VIGIA_NEUTRAL_URL:-https://www.google.com/generate_204}"
FALHAS_PARA_AVISAR=3
REPETIR_AVISO_S=1800
# Voltas mais espaçadas que isto não são seguidas (PC desligado ou suspenso).
INTERVALO_MAXIMO_S=300

# shellcheck source=scripts/lib/notificar-telegram.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/notificar-telegram.sh"

estado="${XDG_STATE_HOME:-$HOME/.local/state}/automabaca"
arquivo="$estado/vigia-externo.estado"
log="$estado/vigia-externo.log"
mkdir -p "$estado"
exec 9>"$estado/vigia-externo.lock"
flock -n 9 || exit 0
if [[ -f "$log" ]] && (( $(stat -c %s "$log") > 262144 )); then
  mv -f "$log" "$log.1"
fi
exec >>"$log" 2>&1

registrar() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# falhas: seguidas até agora; desde: a primeira delas; avisado_em: o último
# aviso do incidente (0 = ainda não avisou); incidente: 1 depois da 3ª falha.
falhas=0 desde=0 avisado_em=0 incidente=0 ultima_volta=0 situacao=""
if [[ -f "$arquivo" ]]; then
  while IFS='=' read -r chave valor; do
    case "$chave" in
      falhas|desde|avisado_em|incidente|ultima_volta) [[ "$valor" =~ ^[0-9]+$ ]] && printf -v "$chave" '%s' "$valor" ;;
      situacao) situacao="$valor" ;;
    esac
  done < "$arquivo"
fi

gravar() {
  printf 'falhas=%s\ndesde=%s\navisado_em=%s\nincidente=%s\nultima_volta=%s\nsituacao=%s\n' \
    "$falhas" "$desde" "$avisado_em" "$incidente" "$ultima_volta" "$situacao" > "$arquivo.tmp"
  mv -f "$arquivo.tmp" "$arquivo"
}

# Uma linha no log por MUDANÇA de situação, não uma por minuto.
mudou() {
  [[ "$situacao" == "$1" ]] || { situacao="$1"; registrar "$1"; }
}

duracao() {
  local s="$1"
  if (( s >= 3600 )); then printf '%d h %02d min' $(( s / 3600 )) $(( s % 3600 / 60 ))
  else printf '%d min' $(( (s + 59) / 60 )); fi
}

# Devolve 0 quando o assunto está encerrado (enviado, ou sem configuração e
# registrado) e 1 quando vale tentar de novo na próxima volta.
avisar() {
  local codigo=0
  notificar_telegram "$1" || codigo=$?
  case "$codigo" in
    0) registrar "aviso enviado: ${1%%$'\n'*}" ;;
    2) registrar "sem ~/.config/automabaca/notificar.env válido (modo 600, token e chat); não avisei: ${1%%$'\n'*}" ;;
    *) registrar "o Telegram não aceitou o aviso; tento de novo no próximo minuto"; return 1 ;;
  esac
}

agora="$(date +%s)"

# O que falhou, em uma frase; vazio quando a produção está saudável.
corpo="$(mktemp)"
trap 'rm -f "$corpo"' EXIT
motivo=""
codigo_curl=0
http="$(curl --silent --max-time 10 --output "$corpo" --write-out '%{http_code}' "$HEALTH" 2>/dev/null)" || codigo_curl=$?
if (( codigo_curl == 28 )); then motivo="sem resposta em 10 s"
elif (( codigo_curl == 6 )); then motivo="o endereço não resolve (DNS)"
elif (( codigo_curl != 0 )); then motivo="sem conexão (curl $codigo_curl)"
elif [[ "$http" != 200 ]]; then
  motivo="HTTP $http"
  # O health responde 503 com o mesmo corpo: diz qual parte caiu.
  parte="$(jq -r 'if type != "object" then empty elif .db == false then "banco fora" elif .worker == false then "worker fora (heartbeat \(.heartbeat // "?"))" else empty end' "$corpo" 2>/dev/null || true)"
  [[ -z "$parte" ]] || motivo="$motivo, $parte"
else
  motivo="$(jq -sr 'if length != 1 or (.[0] | type) != "object" then "resposta que não é o health"
    else .[0] | if .ok != true then "ok falso" + (if .db == false then " (banco fora)" else "" end)
    elif .db != true then "banco falso"
    elif .worker != true then "worker falso"
    elif .heartbeat != "fresh" then "heartbeat do worker \(.heartbeat // "ausente")"
    else "" end end' "$corpo" 2>/dev/null)" || motivo="resposta que não é JSON"
fi

if [[ -z "$motivo" ]]; then
  if (( incidente )); then
    tempo="$(duracao $(( agora - desde )))"
    # A recuperação só fecha o incidente depois de avisada (ou de registrada, sem configuração).
    avisar "✅ AutomaBACA voltou (visto de fora da VPS)
Ficou fora por $tempo, desde $(date -d "@$desde" '+%d/%m %H:%M')." || { ultima_volta="$agora"; gravar; exit 0; }
    registrar "produção voltou depois de $tempo"
  fi
  falhas=0 desde=0 avisado_em=0 incidente=0 ultima_volta="$agora"
  mudou "produção saudável"
  gravar
  exit 0
fi

# Falhou daqui: antes de culpar a produção, confere se o PC tem rede.
if ! curl --silent --max-time 8 --output /dev/null "$NEUTRO" 2>/dev/null; then
  mudou "PC sem rede (o destino neutro também não responde); não conto como falha da produção"
  gravar
  exit 0
fi

if (( falhas > 0 && ! incidente && agora - ultima_volta > INTERVALO_MAXIMO_S )); then
  falhas=0
fi
(( falhas > 0 )) || desde="$agora"
falhas=$(( falhas + 1 ))
ultima_volta="$agora"
mudou "produção com falha: $motivo"

if (( falhas >= FALHAS_PARA_AVISAR )); then
  if (( ! incidente )); then
    incidente=1
    registrar "incidente aberto: $falhas falhas seguidas"
  fi
  if (( avisado_em == 0 )); then
    texto="🚨 AutomaBACA fora do ar (visto de fora da VPS)
$motivo
$falhas verificações seguidas falharam, desde $(date -d "@$desde" '+%d/%m %H:%M').
👉 $HEALTH; no servidor: docker ps e journalctl -u caddy. Aviso de novo em 30 min se continuar."
    ! avisar "$texto" || avisado_em="$agora"
  elif (( agora - avisado_em >= REPETIR_AVISO_S )); then
    texto="🚨 AutomaBACA continua fora do ar há $(duracao $(( agora - desde )))
$motivo"
    ! avisar "$texto" || avisado_em="$agora"
  fi
fi
gravar
