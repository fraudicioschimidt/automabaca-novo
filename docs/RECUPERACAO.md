# Recuperar o AutomaBACA noutra máquina

Escrito para o dia ruim: a VPS morreu, foi comprometida ou perdeu o disco, e é
preciso subir o sistema em outro lugar.

**Estado honesto (21/09/2026): o exercício completo nunca foi feito.** O que está
provado todo dia é a restauração do banco: o backup diário restaura o dump num
PostgreSQL isolado antes de aceitá-lo. O resto abaixo é procedimento, não
ensaio, e os tempos são estimativa até alguém cronometrar.

## De onde vem cada peça

Tudo o que não está no GitHub ou no ghcr.io está no **pacote diário de
recuperação**, e esse pacote já é copiado todo dia para o PC do dono.

| Peça | Recupera de |
|---|---|
| Código | GitHub: `git clone` |
| Imagens web e worker | `ghcr.io/fraudicioschimidt/automabaca-novo-{web,worker}:<commit>` |
| Banco | pacote diário, `database/database.dump` |
| Papéis do PostgreSQL | pacote diário, `postgres-roles.sql` |
| Segredos (`/etc/automabaca-novo/*.env`) | pacote diário, `config/` |
| Site do Caddy | pacote diário, `config/automabaca.caddy` |
| Compose vivo (qual release e quais digests estavam no ar) | pacote diário, `deploy/compose.yaml` |
| Logos dos tipsters | pacote diário, `persistent-data.tar.gz` |
| Timers, backup e observabilidade do host | repositório: `deploy/` e `infra/observability/` |
| Histórico de logs | cópias cifradas no PC do dono; não é preciso para subir |

### O pacote diário

- Gerado entre 04:15 e 04:25 UTC (04:15 com até 10 min de atraso aleatório)
  por `automabaca-novo-backup.timer`
  (`deploy/backup-diario.py`, instalado como
  `/usr/local/lib/automabaca-novo/backup.py`).
- Nome: `automabaca-novo-recovery-AAAAMMDDTHHMMSSZ.tar.age`. Cifrado com `age`
  para a chave **pública** em `/etc/automabaca-novo/backup-recipient.txt`. A
  chave privada nunca esteve na VPS: fica com o dono.
- O `manifest.json` de dentro lista o SHA-256 de cada arquivo, e
  `database/verification.json` registra a restauração isolada daquele dump.
- Do dump até o fim do pacote (menos de um minuto), o backup segura a trava do
  `publicar.sh` (`/srv/apps/automabaca-novo/.publicar.lock`): o dump e o compose
  saem da mesma release. A publicação que chega nesse intervalo recusa com
  "outra publicação está em andamento", e o publicador automático tenta de novo
  no minuto seguinte; publicação em andamento faz o backup esperar até 15 min.
- **No PC do dono:** a tarefa "AutomaBACA - Backup criptografado" baixa o pacote
  todo dia, guarda 7 dias e devolve à VPS um comprovante; sem comprovante há
  36 h, o painel e o Telegram avisam. Onde fica e como conferir:
  `deploy/README.md`.

Existe um segundo tipo de backup, com outro propósito: o `deploy/backup.py`
grava um dump **sem cifra** em `/srv/apps/automabaca-novo/backups/` antes de
cada publicação com migration (chamado pelo `migrar.py`) ou pedida com
`--com-backup` (chamado pelo `publish.py`), para desfazer uma migration ruim. Ele mora na própria VPS, então não
serve para o desastre.

## Ordem

1. **Máquina nova** com Docker, Caddy e `age`. A imagem do PostgreSQL tem de ser
   a mesma: `postgres:17.11-alpine` (a ordenação de texto do Alpine difere da do
   Debian).
2. **Abrir o pacote mais recente**, num diretório privado (`chmod 700`), fora de
   qualquer pasta de aplicação:

   ```bash
   age -d -i <chave-privada> automabaca-novo-recovery-<data>.tar.age | tar -x
   sha256sum -c database/SHA256SUMS
   ```

   Confira também os demais arquivos contra o `manifest.json`.
3. **Segredos:** copiar `config/*.env` para `/etc/automabaca-novo/` (root, `0600`).
   O `web.env` e o `worker.env` já vêm prontos. Se editar o `runtime.env`, gere
   os dois de novo com `sudo node deploy/split-env.cjs`, **de dentro de um
   checkout no commit que será publicado** (ver `docs/RELEASE.md`).
4. **Banco:** subir o PostgreSQL pelo `deploy/compose.yaml`, aplicar os papéis e
   restaurar o dump:

   ```bash
   docker exec -i automabaca-novo-db psql -U automabaca_novo -d postgres < postgres-roles.sql
   docker exec -i automabaca-novo-db pg_restore -U automabaca_novo -d automabaca_novo < database/database.dump
   ```

   Os papéis vêm antes do dump de propósito: web e worker usam a role
   `automabaca_runtime` (sem superuser, dona do schema `pgboss`), e o
   `pg_restore` precisa dela para devolver a cada objeto o dono certo. O aviso
   de que `automabaca_novo` já existe é esperado, porque o container a cria.
5. **Imagens:** `docker login ghcr.io` e puxar as duas pelos digests que estão no
   `deploy/compose.yaml` do pacote. É exatamente o que estava no ar.
6. **Release × banco:** antes de subir web e worker, confira que o schema do dump
   é o daquela release. Um pacote tirado antes de a VPS ter a trava descrita em
   "O pacote diário" pode ter juntado um dump e um compose de releases vizinhas,
   e a conferência custa um minuto.

   ```bash
   grep -m1 AUTOMABACA_RELEASE_SHA deploy/compose.yaml
   docker exec automabaca-novo-db psql -U automabaca_novo -d automabaca_novo -At -c \
     "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1"
   git ls-tree --name-only <sha> prisma/migrations/   # num clone do repositório
   ```

   As duas listas devem ser iguais. Se a release tem migration que o dump não
   tem, rode o `prisma migrate deploy` daquele commit com a role administrativa
   (como o `deploy/migrar.py` faz) antes de subir web e worker: as migrations que
   saem sozinhas são aditivas. Se o dump tem migration que a release não tem,
   suba a release que a trouxe ou use o pacote do dia anterior.
7. **Topologia:** colocar esse `compose.yaml` em `/srv/apps/automabaca-novo/deploy/`
   e subir web e worker.
8. **Arquivos persistentes:** extrair `persistent-data.tar.gz` em
   `/var/lib/automabaca-novo/` (logos). A observabilidade pode começar
   vazia.
9. **Borda:** instalar `config/automabaca.caddy`, apontar o DNS de
   `v2.fraudicio.com.br` para o IP novo e recarregar o Caddy.
10. **Host:** reinstalar timers, backup e observabilidade conforme
    `deploy/README.md`, e o checkout de referência em
    `/srv/apps/automabaca-novo/source/`, que o deploy e o backup usam.
11. **Conferir:** `curl https://v2.fraudicio.com.br/api/health` deve responder
    `ok`, `db` e `worker` verdadeiros, e `release` igual ao commit esperado.

## Quanto se perde

- **Banco corrompido, servidor vivo:** no pior caso, as últimas 24h (o intervalo
  do backup diário). Se houve publicação com migration no meio, o dump dela
  reduz a perda.
- **VPS perdida:** o que entrou depois do último pacote que chegou ao PC do
  dono. O pacote sai entre 04:15 e 04:25 UTC e a cópia é feita às 03:30 no horário de
  Brasília (06:30 UTC), então normalmente é menos de um dia.

**Tempo:** o dump comprimido tem dezenas de MB e restaura em segundos. O que
domina é provisionar a máquina, trocar o DNS e puxar as imagens. A estimativa é
de 1 a 2 horas para quem já fez; desconhecido para quem não fez.

## Antes do dia ruim

1. **Ensaiar** numa máquina descartável, seguindo esta página, e cronometrar. Um
   procedimento que nunca rodou é uma hipótese.
2. **Conferir de vez em quando a chave privada `age`**: abrir um pacote de teste
   com ela. Backup que ninguém consegue abrir é pior que nenhum.
3. **Criar um acesso administrativo independente do `deploy`** (pendência "C07",
   aberta desde 16/09/2026). Hoje `deploy` tem `sudo` irrestrito e está no grupo
   `docker`, que também dá controle da máquina, e não há outro acesso
   administrativo confirmado. Perder essa credencial é perder a VPS; restringir
   `deploy` antes de haver o outro acesso seria trancar a porta com a chave
   dentro. Ordem segura:
   1. Confirmar um console de recuperação no painel da Contabo, ou criar um
      login administrativo próprio, com chave guardada só pelo dono (fora da
      home e do alcance dos agentes).
   2. Abrir uma sessão por esse acesso e confirmar root de fato; configuração
      que "parece certa" não prova acesso.
   3. Levantar o que usa `deploy` (timers, backup, `publicar.sh`) e dar às
      operações administrativas um caminho que não execute como root scripts
      editáveis por `deploy`. Um wrapper `sudo` que aceite comandos, imagens,
      caminhos ou volumes arbitrários só troca o nome do acesso root.
   4. Salvar grupos e sudoers, validar com `visudo -c` e tirar a regra
      irrestrita e a associação de `deploy` aos grupos `sudo` e `docker`.
   5. Numa janela combinada, sem publicação em andamento, encerrar e reabrir as
      sessões de `deploy` (processo antigo mantém os grupos), confirmar que
      `sudo` e o socket Docker são recusados e, pelo acesso independente, que
      saúde, backups, logs e deploy seguem funcionando.

## Higiene

`/etc/automabaca-novo/` guarda cópias antigas do `runtime.env` e do
`worker.env`, feitas a cada edição, e cada uma carrega todos os segredos de
produção. As permissões são restritas, mas cópia a mais é chance a mais de
vazar num backup ou num diagnóstico. Mantenha as duas ou três últimas.
