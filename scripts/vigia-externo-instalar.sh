#!/usr/bin/env bash
# Instala (ou confere) no crontab do usuário atual o vigia de fora da VPS
# (`scripts/vigia-externo.sh`, a cada minuto).
#
#   bash scripts/vigia-externo-instalar.sh            instala / atualiza
#   bash scripts/vigia-externo-instalar.sh --remover  tira do crontab
#
# Rode como `fabricio`, no WSL, SEM sudo. Idempotente: rodar de novo só confirma.
#
# O cron chama CÓPIAS em ~/.local/lib/automabaca/, pelo mesmo motivo do
# publicador. Mudou `scripts/vigia-externo.sh` ou
# `scripts/lib/notificar-telegram.sh`? Rode este de novo.
set -euo pipefail

aqui="$(cd "$(dirname "$0")" && pwd)"
destino="$HOME/.local/lib/automabaca"
estado="${XDG_STATE_HOME:-$HOME/.local/state}/automabaca"
configuracao="$HOME/.config/automabaca/notificar.env"
marca="# automabaca: vigia de fora da VPS"

[[ $(id -u) -ne 0 ]] || { echo "Rode como o seu usuário, sem sudo." >&2; exit 1; }

novo="$(crontab -l 2>/dev/null | grep -vF "$marca" || true)"

if [[ "${1:-}" == --remover ]]; then
  printf '%s\n' "$novo" | sed '/^$/d' | crontab -
  echo "Removido do crontab. Estado e log continuam em $estado."
  exit 0
fi

for nome in vigia-externo.sh lib/notificar-telegram.sh; do
  [[ -f "$aqui/$nome" ]] || { echo "Não achei $aqui/$nome." >&2; exit 1; }
  if cmp -s "$aqui/$nome" "$destino/$nome"; then
    echo "Cópia em dia: $destino/$nome"
  else
    install -D -m 755 "$aqui/$nome" "$destino/$nome"
    echo "Cópia instalada: $destino/$nome"
  fi
done
novo="$(printf '%s\n%s\n' "$novo" "* * * * * PATH=/usr/local/bin:/usr/bin:/bin /bin/bash $destino/vigia-externo.sh $marca")"

if [[ "$(crontab -l 2>/dev/null || true)" == "$(printf '%s\n' "$novo" | sed '/^$/d')" ]]; then
  echo "Crontab já em dia."
else
  printf '%s\n' "$novo" | sed '/^$/d' | crontab -
  echo "Crontab de $(id -un) atualizado:"
  crontab -l | grep -F "$marca"
fi

echo
echo "Conferências (só leitura):"
systemctl is-active --quiet cron && echo "  cron: ativo" || echo "  AVISO: o serviço cron não está ativo (sudo systemctl enable --now cron)"
command -v jq >/dev/null && echo "  jq: instalado" || echo "  AVISO: falta o jq (sudo apt install jq); sem ele toda resposta do health conta como falha"
if [[ ! -f "$configuracao" ]]; then
  echo "  AVISO: falta $configuracao; o vigia só registra no log, sem avisar no Telegram"
elif [[ ! "$(stat -c %a "$configuracao")" =~ ^[0-7]00$ ]]; then
  echo "  AVISO: $configuracao está legível por outros usuários; o vigia o recusa (chmod 600)"
elif ! grep -q '^TELEGRAM_NOTIFY_BOT_TOKEN=.' "$configuracao" || ! grep -q '^TELEGRAM_NOTIFY_CHAT_ID=.' "$configuracao"; then
  echo "  AVISO: $configuracao sem TELEGRAM_NOTIFY_BOT_TOKEN ou TELEGRAM_NOTIFY_CHAT_ID"
else
  echo "  configuração do aviso: presente, modo 600"
fi
echo
echo "Log: $estado/vigia-externo.log (uma linha por mudança de situação)."
