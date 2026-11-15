# Configuração do servidor

O que transforma "código que roda" em "sistema que opera": publicação, TLS,
backup cifrado e logs. Até 18/09/2026 nada disto estava versionado; existia só
como estado de uma máquina, e uma reconstrução noutro lugar não o teria.

## O que há aqui

| Arquivo | Onde vive em produção |
|---|---|
| `publicar.sh` | roda do checkout `/srv/apps/automabaca-novo/source/`; publica um commit da `main`, o topo ou o do `--commit` (ver `docs/RELEASE.md`). Chamado sozinho pelo `scripts/publicador-automatico.sh`, no crontab do PC do dono |
| `prepare.py`, `publish.py`, `backup.py`, `migrar.py` | rodam do mesmo checkout, chamados pelo `publicar.sh` (`migrar.py` só em release com migration) |
| `compose.yaml` | `/srv/apps/automabaca-novo/deploy/compose.yaml`, com a release e os digests preenchidos |
| `Dockerfile.web`, `Dockerfile.worker` (na raiz do repo) | copiados para cada release pelo `prepare.py` |
| `split-env.cjs`, `env-allowlist.cjs` | geram `/etc/automabaca-novo/{web,worker}.env` a partir do `runtime.env`; rodam do checkout (ver `docs/RELEASE.md`) |
| `systemd/automabaca-novo-backup.*` | `/etc/systemd/system/` |
| `backup-diario.py`, `restore-check.sql` | `/usr/local/lib/automabaca-novo/backup.py` e `restore-check.sql`, lado a lado. **Não** se atualizam com o deploy: reinstale à mão (abaixo) quando mudarem |
| `limpar-evidencias.sh` | roda do checkout, no fim de cada publicação (`publicar.sh`): poda evidências deriváveis e imagens de releases antigas (ver `docs/RETENCAO.md`) |
| `reset-llm-attempts.py` | manutenção sob demanda (ver `docs/OBSERVABILIDADE.md`) |

**O site do Caddy e as units de log ficam em `infra/observability/`**
(`automabaca.caddy` e `automabaca-log-*`), e só lá. Até 21/09/2026 havia uma
segunda cópia aqui, e ela estava sem a normalização da rota
`/api/bankrolls/<slug>/version` que a produção tinha: quem reinstalasse por aqui
perderia a correção. Nem o deploy nem a verificação de deriva olham esses
arquivos: a instalação é à mão (`docs/OBSERVABILIDADE.md`, "Publicação e
restauração").

## Os timers, e por que existem

**`automabaca-novo-backup`**, diário às 04:15 UTC, com até 10 min de atraso
aleatório (`RandomizedDelaySec`). Faz o dump, valida
restaurando num PostgreSQL descartável (`restore-check.sql`: tabelas, estado
das migrations, saldo contra lançamentos, fila), **cifra com `age`** e, com o
pacote cifrado pronto, apaga o dump em claro do snapshot. Em
`/var/backups/automabaca-novo` ficam 14 dias só da evidência (verificação e
SHA-256). A VPS só tem a chave **pública**: quem invadir a máquina não abre os
pacotes diários. A privada fica com o dono.

Snapshot que não chega a ser conferido (dump, restauração ou `restore-check.sql`
que falha, execução interrompida) não é backup: perde o dump na hora, fica com
um `FAILED` e sai na mesma rotação de 14 dias. O que uma execução morta deixou
sem marca é tratado assim no começo da seguinte. Numa falha, o serviço tenta de
novo 30 min depois, no máximo 3 vezes por noite (`StartLimitBurst`); a noite
seguinte recomeça pelo timer. Esgotadas as três, o systemd recusa um
`systemctl start` à mão (`start-limit-hit`) até 6 h depois da primeira: antes
dele, rode `sudo systemctl reset-failed automabaca-novo-backup`.

**Quem vigia o backup** é o `automabaca-log-watchdog` (de minuto em minuto): ele
lê o `status.json` de `/var/lib/automabaca-novo/backup-status/` e o
`exports/latest.json`, que só muda quando sai um pacote conferido. A última
execução que falhou vira a ação "Backup diário do banco falhou" na caixa de
ações, sem Telegram, porque a nova tentativa costuma resolver; 26 h sem pacote
conferido (a noite inteira falhou, ou o timer parou) vira "Backup diário do
banco atrasado", com aviso no Telegram. O Monitoramento mostra a faixa "Backup
do banco": quando saiu o último e quantas apostas a cópia restaurada tinha
(`counts` do `restore-check.sql`, gravado no `status.json`).

O que fica **em claro** na VPS, e por quê:

- o próprio banco, claro: quem é root lê o PostgreSQL vivo;
- o dump de antes de cada publicação com migration (ou com `--com-backup`) em
  `/srv/apps/automabaca-novo/backups/`, root, 0700, de propósito: é a volta de
  uma migration que dê errado, e ela não pode depender do PC do dono;
- o snapshot conferido de uma noite em que a cifragem falhou: ele é o único
  backup daquela noite e fica até a rotação.

Até 21/09/2026 este texto dizia que ninguém na VPS lia os backups, e os 14 dias
de snapshots estavam com o dump em claro (675 MB).

Além do dump, o pacote diário de recuperação
(`/srv/apps/automabaca-novo/exports/automabaca-novo-recovery-*.tar.age`, com
índice em `exports/latest.json`) leva o necessário para reconstruir a produção:
os `.env` de `/etc/automabaca-novo` (segredos), o site do Caddy, os papéis do
PostgreSQL, o código, o compose vivo e os logos. A VPS guarda os pacotes
cifrados de 30 dias (e sempre os dois últimos). O que tem dentro e como restaurar: `docs/RECUPERACAO.md`.

**`automabaca-log-collect`**, **`automabaca-log-export`** e
**`automabaca-log-watchdog`**: coleta contínua dos logs, exportação cifrada
para `exports/logs/` e um vigia da própria coleta, porque pipeline de log que
falha calado é pior que não ter. Detalhes em `docs/OBSERVABILIDADE.md`.

## Cópias fora da VPS (conferido em 21/09/2026)

O PC do dono puxa as duas coisas sozinho. Não é preciso criar outro agendamento.

| | Backup (pacote de recuperação) | Logs |
|---|---|---|
| Tarefa do Windows | `AutomaBACA - Backup criptografado` | `AutomaBACA - copia de logs` |
| Quando | todo dia às 03:30 (Brasília), depois do backup das 04:15–04:25 UTC | a cada 15 minutos |
| Destino | `Documents/Codex/2026-09-04/vamos-l-eu-tenho-uma-vps/outputs/AutomaBACA-backups` | `%LOCALAPPDATA%\AutomaBACA\logs` |
| Como | `infra/observability/backup-windows.ps1` (na pasta da tarefa, com o nome `download.ps1`): `scp` pelo alias `hermes`, lê `latest.json`, baixa o `.tar.age` e confere tamanho e SHA-256 | `infra/observability/sync-windows.ps1`, instalado por `install-windows.ps1` |
| Retenção | 7 dias, nunca menos que os 2 últimos verificados | — |
| Como saber se funciona | comprovante devolvido à VPS; sem um válido há 36 h, `backup_offsite_stale` abre uma ação em `/operacoes` e avisa no Telegram | status da cópia externa em `/monitoramento` |

As cópias continuam cifradas no PC: só a chave privada `age` do dono abre.

Depois de conferir o pacote, o `backup-windows.ps1` grava na VPS
`/var/lib/automabaca-novo/observability-receipts/windows-backup-receipt.json`
(nome do pacote, SHA-256, tamanho e hora), ao lado do comprovante dos logs, e o
`watchdog.py` julga a idade pela hora em que o arquivo chegou. No PC, a pasta
dos backups guarda `last-success.json` (a última cópia conferida) e
`last-attempt.json` (o código da última execução:
`computer_backup_download_failed`, `computer_backup_receipt_failed`). Se o
aviso chegar, confira a tarefa no Agendador de Tarefas e se `ssh hermes`
funciona no Windows.

Se a transferência normal travar, o script recupera o pacote por blocos pequenos
em conexões SSH independentes (até uma hora). O `.partial` fica na pasta, sob a
mesma trava da tarefa, e a próxima execução retoma os blocos completos. Parcial
não é backup verificado: o tamanho e o SHA-256 do pacote inteiro precisam bater
antes do rename e do comprovante. Divergência de checksum descarta o parcial;
as cópias já verificadas continuam preservadas. Uma execução bem-sucedida
remove parciais abandonados há mais de sete dias.
No Agendador, o limite de execução é de 75 minutos, com três novas tentativas
a cada 15 minutos em caso de falha; mantenha a opção de iniciar quando disponível.

A tarefa do Windows chama o script pelo caminho da pasta dela, fora do
repositório. Mudou `infra/observability/backup-windows.ps1`? Copie por cima,
do WSL (o caminho da pasta está na ação da tarefa:
`schtasks.exe /Query /TN "AutomaBACA - Backup criptografado" /V /FO LIST`):

```bash
cp infra/observability/backup-windows.ps1 "<pasta da tarefa>/download.ps1"
```

## Instalar noutra máquina

Backup e timers:

```bash
sudo cp systemd/automabaca-novo-backup.* /etc/systemd/system/
sudo cp backup-diario.py /usr/local/lib/automabaca-novo/backup.py
sudo cp restore-check.sql /usr/local/lib/automabaca-novo/restore-check.sql
sudo systemctl daemon-reload
sudo systemctl enable --now automabaca-novo-backup.timer
```

Antes, crie `/etc/automabaca-novo/backup-recipient.txt` com a chave **pública**
`age` do dono. O script recusa um destinatário que não case com
`age1[0-9a-z]{58}`: um backup que ninguém consegue abrir é pior que nenhum.

Observabilidade (coletor, exportador, vigia, timers e as ferramentas da cópia
para o Windows): `sudo bash infra/observability/install-host.sh`.

Caddy: copie `infra/observability/automabaca.caddy` para `/etc/caddy/sites-enabled/automabaca.caddy`
(o `Caddyfile` importa `sites-enabled/*.caddy`), valide e recarregue:

```bash
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

O passo a passo completo de uma reconstrução está em `docs/RECUPERACAO.md`.

## O que fica fora do Git, e deve ficar

`/etc/automabaca-novo/runtime.env` e os `.env` derivados dele: todas as chaves de
produção. A cópia deles fora da VPS é o pacote diário cifrado.

## Deriva

`sudo -n node scripts/check-deploy-drift.mjs` (ou `npm run check:deploy-drift`
com `sudo`) compara com o servidor o compose, os Dockerfiles e o `split-env.cjs`,
e falha quando divergem. O `publicar.sh` roda isso e
recusa publicar com deriva. Em 17/09/2026 o `Dockerfile.worker` do servidor
descrevia uma imagem que não existia mais, e ninguém percebia porque nada
comparava os dois. O Caddy e os timers **não** estão nessa comparação.

Mudança no serviço `db` do compose (o `command:` do PostgreSQL, por exemplo)
não chega ao banco pela publicação, que só recria web e worker, e precisa do
compose vivo editado junto com o merge, senão a deriva recusa a publicação.
Editado o compose vivo, um commit anterior ao merge também é recusado pela
deriva (descreve o compose antigo): é o esperado, e a produção sai no commit
do merge. O caso das consultas lentas está em `docs/OBSERVABILIDADE.md`,
"Consultas lentas".
