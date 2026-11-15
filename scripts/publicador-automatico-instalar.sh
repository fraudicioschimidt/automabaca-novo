#!/usr/bin/env bash
# Instala (ou confere) no crontab do usuário atual a publicação automática
# (a cada minuto).
#
#   bash scripts/publicador-automatico-instalar.sh            instala / atualiza
#   bash scripts/publicador-automatico-instalar.sh --remover  tira do crontab
#
# Rode como `fabricio`, no WSL, SEM sudo: o publicador usa o `gh` e o
# `ssh hermes` desse usuário. Idempotente: rodar de novo só confirma.
#
# O cron chama CÓPIAS em ~/.local/lib/automabaca/, não os arquivos de um
# checkout: a bancada troca de branch com outras sessões e as worktrees somem
# depois do merge. Mudou `scripts/publicador-automatico.sh`? Rode este de
# novo. O mesmo vale para
# `scripts/lib/notificar-telegram.sh`, por onde o publicador avisa no Telegram.
set -euo pipefail

aqui="$(cd "$(dirname "$0")" && pwd)"
destino="$HOME/.local/lib/automabaca"
estado="${XDG_STATE_HOME:-$HOME/.local/state}/automabaca"
# script | quando | marca da linha no crontab
tarefas=(
  "publicador-automatico.sh|* * * * *|# automabaca: publicação automática da main"
)

[[ $(id -u) -ne 0 ]] || { echo "Rode como o seu usuário, sem sudo." >&2; exit 1; }

novo="$(crontab -l 2>/dev/null || true)"
for tarefa in "${tarefas[@]}"; do
  IFS='|' read -r nome _ marca <<<"$tarefa"
  novo="$(grep -vF "$marca" <<<"$novo" || true)"
done

if [[ "${1:-}" == --remover ]]; then
  printf '%s\n' "$novo" | sed '/^$/d' | crontab -
  echo "Removidas do crontab. Estado e logs continuam em $estado."
  exit 0
fi

for tarefa in "${tarefas[@]}"; do
  IFS='|' read -r nome quando marca <<<"$tarefa"
  [[ -f "$aqui/$nome" ]] || { echo "Não achei $aqui/$nome." >&2; exit 1; }
  if cmp -s "$aqui/$nome" "$destino/$nome"; then
    echo "Cópia em dia: $destino/$nome"
  else
    install -D -m 755 "$aqui/$nome" "$destino/$nome"
    echo "Cópia instalada: $destino/$nome"
  fi
  # O cron roda com PATH mínimo e sem o ambiente do login; `bash -lc` não é
  # necessário: gh, ssh, curl e flock ficam em /usr/bin.
  novo="$(printf '%s\n%s\n' "$novo" "$quando PATH=/usr/local/bin:/usr/bin:/bin /bin/bash $destino/$nome $marca")"
done

# O publicador carrega a biblioteca de aviso do lado da cópia dele.
if cmp -s "$aqui/lib/notificar-telegram.sh" "$destino/lib/notificar-telegram.sh"; then
  echo "Cópia em dia: $destino/lib/notificar-telegram.sh"
else
  install -D -m 755 "$aqui/lib/notificar-telegram.sh" "$destino/lib/notificar-telegram.sh"
  echo "Cópia instalada: $destino/lib/notificar-telegram.sh"
fi

if [[ "$(crontab -l 2>/dev/null || true)" == "$(printf '%s\n' "$novo" | sed '/^$/d')" ]]; then
  echo "Crontab já em dia."
else
  printf '%s\n' "$novo" | sed '/^$/d' | crontab -
  echo "Crontab de $(id -un) atualizado:"
  crontab -l | grep -F "# automabaca:"
fi

echo
echo "Conferências (só leitura):"
systemctl is-active --quiet cron && echo "  cron: ativo" || echo "  AVISO: o serviço cron não está ativo (sudo systemctl enable --now cron)"
env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin gh auth status >/dev/null 2>&1 \
  && echo "  gh: autenticado no ambiente do cron" || echo "  AVISO: gh sem autenticação no ambiente do cron"
env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin ssh -o BatchMode=yes -o ConnectTimeout=15 hermes true 2>/dev/null \
  && echo "  ssh hermes: ok sem agente nem senha" || echo "  AVISO: ssh hermes falhou no ambiente do cron (chave com senha? precisa de agente?)"
echo
echo "Log: $estado/publicador.log (tail -f para acompanhar)."
echo "Commit já tratado pelo publicador: $estado/tratados/<sha>."
