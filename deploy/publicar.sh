#!/usr/bin/env bash
# Publica em produção um commit da `main` (o topo, ou o do `--commit`), num comando só.
#
# Encadeia o fluxo de docs/RELEASE.md sem mudar nenhuma guarda: quem decide se
# a release é publicável continuam sendo o prepare.py e o publish.py. Existe
# porque o fluxo tem sete passos, e improvisá-los à mão pode derrubar uma
# publicação no meio.
#
# Roda na VPS, como o usuário `deploy` (NÃO sob sudo: o `docker pull` usa a
# credencial do ghcr.io do ~/.docker desse usuário; os passos que precisam de
# root chamam `sudo -n` sozinhos). De qualquer máquina:
#
#   ssh hermes 'bash /srv/apps/automabaca-novo/source/deploy/publicar.sh --nome <assunto> --preflight'
#   ssh hermes 'bash /srv/apps/automabaca-novo/source/deploy/publicar.sh --nome <assunto> --commit <sha>'
#
#   --nome     prefixo da release (ex.: ci-self-hosted). Vira <nome>-AAAAMMDD-<sha7>.
#   --commit   sha (ou prefixo) a publicar. Precisa estar na main e pode ser
#              anterior ao topo (o publicador leva o mais novo com a CI verde),
#              mas não ao que está no ar. Sem ele, o topo da main.
#   --preflight  para depois do preflight: só lê, não muda nada em produção.
#   --com-migration  a release traz migration e o dono aprovou aplicá-la. Só
#              migration compatível com a versão no ar passa (deploy/migrar.py);
#              sem esta opção, uma release com migration mostra o plano e para.
#              O worker antigo para logo antes do migrate e o novo sobe na troca.
#   --migration-manual <nome>  aplica também a migration manual com esse nome
#              exato, que o dono aprovou depois de ver o SQL (implica
#              --com-migration). Mesmo backup conferido e mesma verificação.
#   --com-backup  faz o backup conferido do banco antes da troca mesmo sem
#              migration (release com migration sempre faz). Para uma release
#              arriscada para os dados; custa ~25 s e um dump em claro em backups/.
#
# Saída: 0 publicado (ou preflight aprovado, ou já estava publicado);
#        2 recusado por uma guarda (CI, deriva, migration);
#        1 erro inesperado. Um publish que falha depois de trocar as imagens é
#        revertido pelo próprio publish.py;
#        3 falhou depois de trocar as imagens e a reversão não saiu: estado
#        desconhecido, confira os containers;
#        4 causa passageira (produção não saudável antes de publicar, rede no
#        download do artefato ou no pull das imagens): as imagens não foram
#        trocadas, e basta rodar de novo. O publicador tenta de novo sozinho.
#
# Jogo começando não segura a publicação: a troca reinicia o worker a qualquer
# hora. Numa release com migration, o worker parado para o migrate volta a rodar
# (o antigo, contra o schema novo) se a publicação não sair.
set -euo pipefail

REPO_GH=fraudicioschimidt/automabaca-novo
APP=/srv/apps/automabaca-novo
CHECKOUT="$APP/source"
EVIDENCIAS="$APP/evidence/releases"
COMPOSE="$APP/deploy/compose.yaml"
HEALTH_PUBLICO=https://v2.fraudicio.com.br/api/health

nome="" commit_esperado="" so_preflight=0 com_migration=0 aprovada="" com_backup=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --nome) nome="${2:-}"; shift 2 ;;
    --commit) commit_esperado="${2:-}"; shift 2 ;;
    --preflight) so_preflight=1; shift ;;
    --com-migration) com_migration=1; shift ;;
    --migration-manual) aprovada="${2:-}"; com_migration=1; shift 2 ;;
    --com-backup) com_backup=1; shift ;;
    *) echo "argumento desconhecido: $1" >&2; exit 1 ;;
  esac
done

etapa() { printf '\n==> %s\n' "$*"; }
recusa() { printf '\nRECUSADO: %s\n' "$*" >&2; exit 2; }
passageiro() { printf '\nPASSAGEIRO: %s\n' "$*" >&2; exit 4; }

[[ $(id -un) == deploy ]] || { echo "Rode como o usuário deploy, sem sudo." >&2; exit 1; }
[[ "$nome" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]] \
  || { echo "--nome obrigatório: minúsculas, dígitos e hífen (ex.: ci-self-hosted)." >&2; exit 1; }
# Só sha: um nome de branch resolveria para a `main` local da referência, que
# fica parada desde que a referência anda desanexada.
[[ -z "$commit_esperado" || "$commit_esperado" =~ ^[0-9a-f]{7,40}$ ]] \
  || { echo "--commit espera um sha (7 a 40 caracteres hexadecimais)." >&2; exit 1; }

# Uma publicação por vez. O publish.py também trava, mas só na troca; aqui a
# trava cobre o checkout e o download, que duas execuções corromperiam.
exec 8>"$APP/.publicar.lock"
flock -n 8 || recusa "outra publicação está em andamento."

# ---------------------------------------------------------------------------
etapa "Checkout de referência no commit a publicar"
cd "$CHECKOUT"
[[ -z "$(git status --porcelain)" ]] || recusa "$CHECKOUT tem alterações; ele deve ficar limpo (AGENTS.md)."
git fetch -q origin main
# Sem --commit, o topo da main. Com --commit, aquele commit, desde que esteja na
# main: o publicador leva à produção o mais novo com a CI verde, que pode não
# ser o topo quando a CI do topo ainda roda. A referência fica nele, desanexada.
alvo="$(git rev-parse origin/main)"
if [[ -n "$commit_esperado" ]]; then
  alvo="$(git rev-parse -q --verify "${commit_esperado}^{commit}")" \
    || recusa "o commit $commit_esperado não existe no repositório."
  git merge-base --is-ancestor "$alvo" origin/main || recusa "o commit ${commit_esperado:0:7} não está na main."
fi
# A produção não volta para trás por aqui (desfazer uma release é revert na
# main), e a recusa vem antes de mexer na referência, que o backup diário e o
# split-env usam.
vivo_sha="$(sudo -n docker inspect automabaca-novo-worker \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^AUTOMABACA_RELEASE_SHA=//p')"
if [[ -n "$vivo_sha" && "$alvo" != "$vivo_sha"* ]] && git merge-base --is-ancestor "$alvo" "$vivo_sha" 2>/dev/null; then
  recusa "${alvo:0:7} é anterior ao que está no ar (${vivo_sha:0:7}). Para desfazer uma release, reverta na main (RELEASE.md)."
fi
antes="$(sha256sum deploy/publicar.sh 2>/dev/null || true)"
de="$(git rev-parse HEAD)"
git switch -q --detach "$alvo"
# Este próprio script pode ter mudado no commit a publicar: roda a versão dele,
# não a anterior, quando o commit vem depois da referência ou quando a versão
# dele também sabe publicar um commit que não é o topo (tem a marca abaixo). As
# versões mais antigas só publicavam o topo e recusariam.
# publicar.sh: publica commit anterior ao topo
if [[ "$(sha256sum deploy/publicar.sh 2>/dev/null || true)" != "$antes" && -z "${PUBLICAR_REEXEC:-}" ]] \
    && { git merge-base --is-ancestor "$de" "$alvo" \
         || grep -qxF '# publicar.sh: publica commit anterior ao topo' deploy/publicar.sh; }; then
  exec 8>&-
  PUBLICAR_REEXEC=1 exec bash deploy/publicar.sh --nome "$nome" \
    ${commit_esperado:+--commit "$commit_esperado"} $([[ $so_preflight == 1 ]] && echo --preflight) \
    $([[ $com_migration == 1 ]] && echo --com-migration) \
    ${aprovada:+--migration-manual "$aprovada"} $([[ $com_backup == 1 ]] && echo --com-backup)
fi
sha="$(git rev-parse HEAD)"
curto="${sha:0:7}"
echo "commit = $sha"

# ---------------------------------------------------------------------------
etapa "Produção atual"
vivo_id="$(sudo -n docker inspect automabaca-novo-worker \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^AUTOMABACA_RELEASE_ID=//p')"
echo "em produção: $vivo_id ($vivo_sha)"
if [[ "$vivo_sha" == "$sha" ]]; then
  echo "Este commit já está em produção. Nada a fazer."
  exit 0
fi

# ---------------------------------------------------------------------------
etapa "CI da main neste commit"
run_id="$(gh run list -R "$REPO_GH" --workflow check.yml --branch main --event push --commit "$sha" \
  --json databaseId,status,conclusion --jq '[.[] | select(.status == "completed")][0].databaseId // empty')"
[[ -n "$run_id" ]] || recusa "nenhuma execução concluída do check.yml na main para $curto (ainda rodando?)."
jobs="$(gh run view "$run_id" -R "$REPO_GH" --json jobs --jq '.jobs[] | "\(.name)=\(.conclusion)"')"
echo "$jobs" | sed 's/^/  /'
for job in "release verificada" "imagens publicadas no registry"; do
  grep -qx "$job=success" <<<"$jobs" || recusa "job \"$job\" não está verde na execução $run_id."
done

# ---------------------------------------------------------------------------
etapa "Deriva entre o servidor e o repositório"
sudo -n node scripts/check-deploy-drift.mjs || recusa "há deriva; o servidor precisa ser o que está revisado (RELEASE.md, passo 3)."

# ---------------------------------------------------------------------------
dia="$(date -u +%Y%m%d)"
release="$nome-$dia-$curto"
dir="$EVIDENCIAS/$release"
etapa "Release $release"
if [[ -f "$dir/publication.json" ]]; then
  echo "$dir já tem publication.json: esta release já foi publicada."
  exit 0
fi
mkdir -p "$dir/artifact"
if [[ ! -f "$dir/artifact/release-manifest.json" ]]; then
  # Baixa ao lado e só então move: download pela metade não passa por artefato
  # na próxima tentativa.
  parcial="$dir/artifact.baixando"
  mkdir -p "$parcial"
  rm -f "$parcial"/runtime.tar.gz "$parcial"/release-manifest.json
  gh run download "$run_id" -R "$REPO_GH" -n "release-$sha" -D "$parcial" \
    || passageiro "o download do artefato da CI falhou (acima); nada mudou em produção."
  mv "$parcial"/runtime.tar.gz "$parcial"/release-manifest.json "$dir/artifact/"
  rmdir "$parcial"
fi
# O publish.py compara o compose vivo com esta cópia antes de trocar qualquer
# coisa: se alguém mexer em produção no meio, ele recusa.
sudo -n cat "$COMPOSE" > "$dir/compose-before.yaml"
chmod 600 "$dir/compose-before.yaml"

etapa "Preparar (confere o artefato, monta as camadas, puxa as imagens do registry)"
# O fluxo recomendado é `--preflight` e depois publicar, com o mesmo nome no
# mesmo dia: os dois caem nesta pasta. O prepare.py recusa montar camadas por
# cima de camadas (com razão), e a segunda execução falharia aqui. O
# `images.json` só é gravado no fim de um
# preparo completo; com ele presente, o mesmo commit no `release.json` e as
# camadas (a poda de uma publicação no meio tira as de quem não está no ar), a
# pasta está pronta. O publish.py confere de novo IDs, digests e o compose vivo.
if [[ -f "$dir/images.json" && -d "$dir/verified-runtime" && -d "$dir/web-layer" && -d "$dir/worker-layer" ]] \
    && grep -q "\"sha\": \"$sha\"" "$dir/release.json" 2>/dev/null; then
  echo "Já preparada nesta pasta para $curto (pelo --preflight, por exemplo); reaproveitando."
else
  set +e
  python3 deploy/prepare.py --nome "$nome" --data "$dia" --release-dir "$dir" | tail -1
  codigo=${PIPESTATUS[0]}
  set -e
  # 75: o pull falhou, antes de o prepare.py montar qualquer camada.
  if [[ $codigo == 75 ]]; then
    passageiro "o pull das imagens do registry falhou (acima e em $dir/image-*.log); nada mudou em produção."
  fi
  [[ $codigo == 0 ]] || exit 1
fi

preflight() {
  set +e
  saida="$(sudo -n python3 deploy/publish.py --release-dir "$dir" --preflight 2>&1)"
  codigo=$?
  set -e
  echo "$saida" | tail -3
}

etapa "Preflight (só leitura)"
preflight
if [[ $codigo != 0 ]] && grep -q "migration set differs" <<<"$saida"; then
  # A release traz migration. O migrar.py diz quais e se são compatíveis com a
  # versão no ar, sem mudar nada.
  etapa "Migration: plano (só leitura)"
  sudo -n python3 deploy/migrar.py --release-dir "$dir" --plano ${aprovada:+--aprovada "$aprovada"} \
    || recusa "a migration desta release não pode sair por aqui (motivo acima). Caminho manual em docs/RELEASE.md, com o dono."
  if [[ $com_migration != 1 ]]; then
    recusa "esta release traz migration compatível (acima). Com o sim do dono para ela, rode de novo com --com-migration."
  fi
  if [[ $so_preflight == 1 ]]; then
    echo
    echo "PREFLIGHT APROVADO COM MIGRATION: $release aplicaria as migrations acima e publicaria. Nada foi alterado."
    exit 0
  fi
  etapa "Migration: backup conferido e CLI; o worker para só para o migrate (a web continua)"
  # O migrar.py deixa o worker antigo parado para o publish.py subir o novo. Se
  # esta execução terminar sem publicar (preflight recusando, erro, sinal), o
  # antigo volta a rodar, contra o schema novo, com aviso: melhor que nenhum.
  religar_worker() {
    sudo -n python3 deploy/migrar.py --release-dir "$dir" --religar-worker || true
  }
  trap religar_worker EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  set +e
  sudo -n python3 deploy/migrar.py --release-dir "$dir" --aplicar ${aprovada:+--aprovada "$aprovada"}
  codigo=$?
  set -e
  if [[ $codigo == 2 ]]; then
    recusa "a migration não começou (motivo acima); o banco não mudou e as imagens continuam em $vivo_id."
  elif [[ $codigo != 0 ]]; then
    religar_worker
    if [[ "$(sudo -n docker inspect -f '{{.State.Running}}' automabaca-novo-worker 2>/dev/null)" == true ]]; then
      worker_agora="o worker antigo está rodando"
    else
      worker_agora="o worker está PARADO: suba-o com 'sudo docker start automabaca-novo-worker'"
    fi
    echo "FALHOU na migration (motivo acima); $worker_agora e as imagens continuam em $vivo_id. NÃO publique: veja $dir/migrate.log e decida com o dono." >&2
    exit 1
  fi
  etapa "Preflight de novo, agora com o banco igual à release"
  preflight
fi
if [[ $codigo != 0 ]]; then
  # Container reiniciando ou healthcheck atrasado passa sozinho; as outras
  # reprovações do preflight são guardas.
  if grep -q 'production not healthy before publishing' <<<"$saida"; then
    passageiro "a produção não está saudável agora (saída acima); as imagens não foram trocadas."
  fi
  recusa "o preflight não aprovou (saída acima)."
fi
if [[ $so_preflight == 1 ]]; then
  echo
  echo "PREFLIGHT APROVADO: $release está pronta. Nada foi alterado em produção."
  exit 0
fi

# ---------------------------------------------------------------------------
etapa "Publicar (troca, saúde, heartbeat; reverte sozinho se falhar)"
opcoes_publish=()
[[ $com_backup == 1 ]] && opcoes_publish+=(--com-backup)
set +e
saida="$(sudo -n python3 deploy/publish.py --release-dir "$dir" "${opcoes_publish[@]}" 2>&1)"
codigo=$?
set -e
echo "$saida" | grep -E '^(STEP|\{|Previous|ROLLBACK)' || true
if [[ $codigo != 0 ]]; then
  echo "$saida" | tail -15 >&2
  # Os marcadores são desta tentativa: o publish.py apaga os de uma anterior.
  if [[ -f "$dir/rollback-failed.json" ]]; then
    echo "FALHOU e a REVERSÃO FALHOU (motivo acima): compose e containers podem estar na release nova, em $vivo_id ou misturados. Confira com 'sudo docker ps' e decida com o dono. Detalhes em $dir." >&2
    exit 3
  elif [[ -f "$dir/rollback.json" ]]; then
    echo "FALHOU e foi REVERTIDO para $vivo_id. Detalhes em $dir." >&2
  elif [[ -f "$dir/swap-started.json" ]]; then
    echo "FALHOU depois de trocar as imagens, sem registro de reversão: estado desconhecido. Confira com 'sudo docker ps' e decida com o dono. Detalhes em $dir." >&2
    exit 3
  else
    echo "FALHOU antes de trocar as imagens; produção continua em $vivo_id." >&2
  fi
  exit 1
fi

# ---------------------------------------------------------------------------
etapa "Conferência final, de fora"
publico="$(curl -fsS --max-time 20 "$HEALTH_PUBLICO")"
echo "$publico"
grep -q "\"release\":\"${sha:0:12}\"" <<<"$publico" || { echo "health público não mostra ${sha:0:12}" >&2; exit 1; }
echo
echo "PUBLICADO: $release ($sha). Anterior: $vivo_id. Evidências: $dir"

# ---------------------------------------------------------------------------
# Cada publicação deixa ~650 MB de evidência derivável e duas imagens; ficam as
# da viva e as da base de rollback (docs/RETENCAO.md). Com sudo: o compose vivo
# é do root. A poda não muda o resultado: a publicação já saiu.
etapa "Poda das evidências e imagens de releases antigas"
sudo -n bash deploy/limpar-evidencias.sh --apagar | tail -4 \
  || echo "AVISO: a poda falhou (acima); o disco não foi liberado. Rode deploy/limpar-evidencias.sh com sudo e veja." >&2
