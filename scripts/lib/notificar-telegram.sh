# Aviso no Telegram pelo bot de NOTIFICAÇÕES de produção
# (o que só envia; nunca o bot que lê os canais). Para `source`.
#
# O token e o chat ficam fora do repositório e do `.env` do projeto, em
# ~/.config/automabaca/notificar.env (modo 600):
#   TELEGRAM_NOTIFY_BOT_TOKEN=<TELEGRAM_NOTIFICATION_BOT_TOKEN da produção>
#   TELEGRAM_NOTIFY_CHAT_ID=<TELEGRAM_NOTIFICATION_CHAT_ID da produção>
#
#   notificar_telegram "texto"
#     0  enviado
#     1  não enviado (rede, Telegram recusou): quem chama decide se tenta de novo
#     2  sem configuração (arquivo ausente, aberto a outros ou incompleto): quem
#        chama registra e segue; nunca é motivo para o script falhar
#
# Variáveis para teste: AUTOMABACA_NOTIFICAR_ENV (o arquivo) e
# AUTOMABACA_TELEGRAM_API (a base da API).

# Valor de `CHAVE=valor` do arquivo, sem executar o arquivo como shell.
_notificar_valor() {
  local valor
  valor="$(sed -n "s/^[[:space:]]*$1=//p" "$2" | tail -n 1)"
  valor="${valor%$'\r'}"
  valor="${valor#[\"\']}"
  printf '%s' "${valor%[\"\']}"
}

notificar_telegram() {
  local texto="$1" arquivo="${AUTOMABACA_NOTIFICAR_ENV:-$HOME/.config/automabaca/notificar.env}"
  local api="${AUTOMABACA_TELEGRAM_API:-https://api.telegram.org}" token chat http
  [[ -f "$arquivo" && -r "$arquivo" ]] || return 2
  # Arquivo legível por outros usuários da máquina não é lugar de token.
  [[ "$(stat -c %a "$arquivo")" =~ ^[0-7]00$ ]] || return 2
  token="$(_notificar_valor TELEGRAM_NOTIFY_BOT_TOKEN "$arquivo")"
  chat="$(_notificar_valor TELEGRAM_NOTIFY_CHAT_ID "$arquivo")"
  [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ && "$chat" =~ ^-?[0-9]+$ ]] || return 2

  texto="${texto:0:3500}"
  # Aspas do arquivo de configuração do curl: só \\, \" e \n precisam de escape.
  texto="${texto//\\/\\\\}"
  texto="${texto//\"/\\\"}"
  texto="${texto//$'\r'/}"
  texto="${texto//$'\n'/\\n}"
  # O token vai pela entrada padrão (`printf` é do próprio bash): não aparece no
  # `ps`. A saída de erro do curl é descartada para a URL nunca chegar a um log.
  http="$(printf 'url = "%s/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\n' \
    "$api" "$token" "$chat" "$texto" \
    | curl --silent --max-time 15 --output /dev/null --write-out '%{http_code}' --config - 2>/dev/null)" || return 1
  [[ "$http" == 200 ]]
}
