#!/usr/bin/env bash
# Vez na máquina para comando pesado (gate, suíte de testes, build, navegador).
#
# Agentes e os runners da CI (usuário ghrunner) dividem o mesmo WSL, e o WSL
# divide a RAM com o Windows. Sem limite, suítes e builds simultâneos esgotam a
# memória e o Windows trava inteiro. Cada comando pesado ocupa vagas (arquivos
# com flock em /run/lock/automabaca-vez) e só começa quando há vaga e memória
# livre. A trava é do kernel: some sozinha se o processo morrer.
#
#   bash scripts/vez.sh [--peso N] -- <comando> [args...]
#
# Vagas na máquina: AUTOMABACA_VEZ_VAGAS, ou uma a cada 2 GB acima dos 5 GB
# que ficam para o sistema (24 GB no WSL → 9 vagas). `--peso` é quantas vagas
# o comando ocupa: medido em 23/09, o `check:ci` sobe ~5,2 GB (peso 3), a
# suíte de banco ~2,1 GB e o build ~1,7 GB (peso 1). Chamada aninhada (um gate
# que roda outro script pesado) usa a vaga de quem chamou.
#
# A espera por vaga tem teto (AUTOMABACA_VEZ_ESPERA_MAX_S, 45 min): passou
# dele, sai com 75 e diz por quê, em vez de o job da CI morrer calado no tempo
# limite de 60 min.
set -euo pipefail

peso=1
while (( $# )); do
  case "$1" in
    --peso) peso="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
(( $# )) || { echo "uso: bash scripts/vez.sh [--peso N] -- <comando> [args...]" >&2; exit 64; }
[[ -z "${AUTOMABACA_VEZ:-}" ]] || exec "$@"

kb() { awk -v chave="$1:" '$1 == chave { print $2 }' /proc/meminfo; }
vagas="${AUTOMABACA_VEZ_VAGAS:-$(( ($(kb MemTotal) / 1048576 - 5) / 2 ))}"
(( vagas >= 1 )) || vagas=1
(( peso <= vagas )) || peso=$vagas
piso_gb="${AUTOMABACA_VEZ_MEMORIA_GB:-3}"
dir="${AUTOMABACA_VEZ_DIR:-/run/lock/automabaca-vez}"
espera_max_s="${AUTOMABACA_VEZ_ESPERA_MAX_S:-2700}"
mkdir -p "$dir" 2>/dev/null && chmod 1777 "$dir" 2>/dev/null || true

# Pega `peso` vagas de uma vez ou nenhuma: segurar uma e esperar a outra
# travaria dois comandos de peso 2 um no outro.
pegas=()
abertas=0
pegar() {
  local i arquivo fd
  pegas=()
  abertas=0
  for (( i = 1; i <= vagas && ${#pegas[@]} < peso; i++ )); do
    arquivo="$dir/vaga-$i"
    [[ -e "$arquivo" ]] || { : >"$arquivo" && chmod 0666 "$arquivo"; } 2>/dev/null || true
    # Sem `2>/dev/null` aqui: num `exec` sem comando, o redirecionamento
    # ficaria valendo para o resto do script e para o comando pesado.
    [[ -r "$arquivo" ]] || continue
    exec {fd}<"$arquivo" || continue
    abertas=$(( abertas + 1 ))
    if flock -n "$fd"; then pegas+=("$fd"); else exec {fd}<&-; fi
  done
  (( ${#pegas[@]} == peso )) && return 0
  for fd in "${pegas[@]}"; do exec {fd}<&-; done
  return 1
}

avisado=-60
until pegar; do
  # Nenhum arquivo de vaga abriu (permissão, disco): rodar sem vez é melhor
  # do que esperar para sempre.
  if (( abertas == 0 )); then
    echo "vez.sh: não consegui abrir as vagas em $dir; rodando sem esperar a vez" >&2
    break
  fi
  if (( SECONDS - avisado >= 60 )); then
    echo "vez.sh: sem vaga livre ($vagas na máquina); esperando para rodar: $*" >&2
    avisado=$SECONDS
  fi
  if (( SECONDS >= espera_max_s )); then
    echo "vez.sh: desisti depois de $(( SECONDS / 60 )) min sem vaga livre ($peso de $vagas na máquina); não rodou: $*" >&2
    echo "vez.sh: veja quem segura as vagas com: lslocks | grep automabaca-vez" >&2
    exit 75
  fi
  sleep $(( 1 + RANDOM % 3 ))
done

# Com a vaga na mão, espera a memória livre passar do piso. Até 10 min: o que
# ocupa a memória pode não passar pela vez, e aí esperar mais não adianta.
esperou=0
while (( $(kb MemAvailable) < piso_gb * 1048576 && esperou < 600 )); do
  (( esperou % 60 )) || echo "vez.sh: menos de ${piso_gb} GB livres; esperando para rodar: $*" >&2
  sleep 5
  esperou=$(( esperou + 5 ))
done

export AUTOMABACA_VEZ=1
exec "$@"
