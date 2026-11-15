# Como uma release chega à produção

Escrito para quem vai publicar, pessoa ou agente, e para quem precisa auditar
depois o que foi publicado.

## Publicar

Desde 21/09/2026 o dono autorizou publicar todo merge na `main` com a CI verde,
sem consulta a cada commit (relate o que saiu depois). Desde 23/09/2026 isso é
automático: o [`scripts/publicador-automatico.sh`](../scripts/publicador-automatico.sh),
no crontab do `deploy` na VPS, olha a cada minuto os commits da `main`
à frente do que está no ar e, para o mais novo com a execução do `check.yml`
verde (inclusive *imagens*), roda o comando 2 abaixo com `--nome auto-<sha7>` e
`--commit`. Com a CI do topo ainda rodando, um commit anterior já verde sai na
frente (a CI da `main` não cancela a execução em andamento), desde que nenhuma
migration venha depois dele: aí espera o topo, para as migrations saírem
juntas. Ele pula merge que só mudou documentação desde a release no ar e passa
`--com-migration`: sai sozinha só a migration que o `migrar.py` aprova, com o
backup conferido antes. Não repete um commit que uma guarda recusou (saída 2)
ou que falhou, e não publica sozinho nada anterior a ele: esses saem à mão.
Causa passageira (saída 4 do `publicar.sh`: produção não saudável antes de
publicar, rede no download do artefato ou no pull das imagens) ele tenta de
novo a cada 5 min, até 8 vezes, e só então marca como falha. Log e estado em
`~/.local/state/automabaca/` do `deploy`; instalação por `scripts/publicador-automatico-instalar.sh`,
na VPS como `deploy`. Ele chama o `publicar.sh` direto, sem ssh, com a reversão
automática de sempre.

À mão (migration que o `migrar.py` recusou, ou refazer uma release recusada):

```bash
# 1. Mostrar o que vai sair, sem mudar nada em produção
ssh hermes 'bash /srv/apps/automabaca-novo/source/deploy/publicar.sh --nome <assunto> --preflight'

# 2. Publicar
ssh hermes 'bash /srv/apps/automabaca-novo/source/deploy/publicar.sh --nome <assunto> --commit <sha>'
```

- `--nome` é o assunto da release: minúsculas, dígitos e hífen. A release se
  chama `<nome>-AAAAMMDD-<sha7>`.
- Publica-se um commit **da `main`**: o topo, ou o de `--commit`, que precisa
  estar na `main` e pode ser anterior ao topo, mas não ao que está no ar (para
  desfazer uma release, reverta na `main`). Publicando, a referência fica nele.
- Rode como o usuário `deploy`, **sem** `sudo`: o `docker pull` usa a
  credencial do ghcr.io desse usuário, e os passos que precisam de root chamam
  `sudo -n` sozinhos.
- Uma publicação por vez. Uma segunda execução simultânea é recusada, e o
  backup diário (04:15–04:25 UTC) segura a mesma trava por menos de um minuto:
  a recusa "outra publicação está em andamento" pede só tentar de novo.
- **Release com migration:** o `--preflight` mostra quais migrations viriam e se
  são compatíveis. As que o `migrar.py` aprova saem com `--com-migration`; as
  recusadas vão pelo caminho manual, com o dono. Ver [Releases com migration](#releases-com-migration).
- `--com-backup` faz o backup conferido antes da troca mesmo sem migration
  (ver o passo 8), para uma release de código arriscada para os dados.

| Saída | Significado |
|---|---|
| 0 | publicado, preflight aprovado ou o commit já estava no ar |
| 2 | uma guarda recusou: CI, deriva ou migration. **Não contorne**: leve ao dono |
| 1 | erro inesperado. Se já tinha trocado as imagens, o `publish.py` reverteu sozinho |
| 3 | falhou depois de trocar as imagens e a reversão não saiu (`rollback-failed.json`, ou a troca começou sem registro de reversão): a produção pode estar na release nova, na anterior ou misturada. Confira os containers e leve ao dono |

## O que o `publicar.sh` faz

[`deploy/publicar.sh`](../deploy/publicar.sh) só encadeia os passos; quem decide
se a release pode sair são o `prepare.py` e o `publish.py`.

1. Põe `/srv/apps/automabaca-novo/source/` no commit a publicar (o topo da
   `main`, ou o `--commit`, desde que esteja na `main`) e recusa se ele tiver
   alterações; commit anterior ao que está no ar é recusado antes de mexer
   nela. Se o próprio `publicar.sh` desse commit é outro, roda a versão dele
   (menos a de antes de 24/09, que só sabia publicar o topo).
2. Não faz nada se o commit já estiver em produção.
3. Exige a execução do `check.yml` na `main` para aquele commit concluída, com
   *release verificada* e *imagens publicadas no registry* verdes.
4. Roda `scripts/check-deploy-drift.mjs`: se o servidor divergir do que está
   versionado (compose, Dockerfiles, `split-env.cjs`), recusa.
5. Cria `evidence/releases/<release>/`, baixa ali o artefato `release-<sha>` da
   CI e guarda uma cópia do compose vivo (`compose-before.yaml`).
6. `prepare.py`: confere o artefato contra o commit (`scripts/verify-release.mjs`),
   monta as camadas de auditoria e puxa as imagens do registry.
7. `publish.py --preflight`, só leitura: produção na release base e saudável,
   digests do commit certo, imagem de rollback presente e migrations idênticas.
   Se a release trouxer migration, o `migrar.py` mostra o plano; com
   `--com-migration`, para o worker antigo e aplica (ver
   [Releases com migration](#releases-com-migration)), e o preflight roda de
   novo, aceitando o worker parado por ele.
8. `publish.py`: troca das imagens (sem esperar jogo começar), saúde,
   heartbeat do worker novo, hashes dos bundles em execução e ambiente
   inalterado. Qualquer falha depois da troca reverte. Backup do banco com
   restauração conferida só quando a release aplicou migration (o do
   `migrar.py`, reaproveitado) ou com `--com-backup`: sem migration a troca não
   mexe no schema e o que ela desfaz são as imagens; o ponto de volta dos dados
   é o backup diário conferido. Até 23/09/2026 rodava em toda publicação (~25 s
   e um dump em claro por merge).
9. Confere de fora, no `/api/health` público, que o commit novo está no ar.
10. Poda as evidências deriváveis e as imagens das releases que não são a viva
    nem a de rollback (`deploy/limpar-evidencias.sh --apagar`, ver
    [RETENCAO.md](RETENCAO.md)). Uma poda que falha vira aviso: a publicação já
    saiu.

`prepare.py`, `publish.py` e `backup.py` vivem no repositório, um de cada,
parametrizados. Até 17/09/2026 eram copiados para cada release e editados à mão,
e isso custou caro no mesmo dia: uma cópia trouxe etapas de Caddy que não
pertenciam à release e derrubou a publicação no meio; outra gravou os backups
com o nome da release anterior. **Não improvise os passos à mão.**

## O que roda em produção

Nenhum diretório do servidor: o código vive **dentro das imagens**. Os containers
`automabaca-novo-web` e `automabaca-novo-worker` sobem imagens referenciadas por
digest imutável. Do host, só enxergam os logos e o status de observabilidade.

Quem decide qual imagem sobe é `/srv/apps/automabaca-novo/deploy/compose.yaml`,
gerado de [`deploy/compose.yaml`](../deploy/compose.yaml) com a release no lugar
de `__RELEASE_ID__`/`__RELEASE_SHA__` e os digests no lugar de
`__WEB_IMAGE__`/`__WORKER_IMAGE__`.

## De onde vêm as imagens

Do artefato que a CI produziu e testou, **nunca** de um build no servidor.

1. O job *release verificada* do `check.yml` publica `runtime.tar.gz` e
   `release-manifest.json`, amarrados ao commit e aos resultados de cada job.
   A ponte Rust (`@automabaca/dominio-node`) vai no pacote duas vezes (no
   standalone e no worker), e o manifesto exige que as duas sejam o binário
   que o job `rust` compilou e testou; o `verify-release` as confere de novo
   dentro do `runtime.tar.gz`.
2. Na `main`, o job *imagens publicadas no registry* confere esse artefato,
   monta as camadas com [`scripts/montar-camadas-de-imagem.mjs`](../scripts/montar-camadas-de-imagem.mjs)
   e publica `ghcr.io/<dono>/automabaca-novo-{web,worker}:<commit>`.
3. O servidor **puxa** essas imagens e as etiqueta localmente como
   `automabaca-novo-<papel>:<release>`, para conferir o ID e manter o rollback.
   O `publish.py` exige o `image-digests.json` do mesmo commit e grava no compose
   o digest, nunca a tag local.

A montagem das camadas é o mesmo script dos dois lados. Conferido em 17/09: as
camadas saem byte a byte idênticas às da imagem em produção. É isso que sustenta
a frase "em produção está o mesmo código que passou nos testes".

Como o repositório é privado, o servidor precisa de token com `read:packages` e
de um `docker login ghcr.io` válido do usuário `deploy`.

`prepare.py --build-local` existe só para diagnóstico com o registry fora do ar.
É explícito de propósito: sem digest do registry, o `publish.py` recusa publicar.

## Guardas, e por que existem

**Ambiente inalterado.** O `publish.py` compara o ambiente dos containers antes e
depois. Mudar configuração e trocar imagem são operações separadas: se precisar
das duas, faça a configuração primeiro, com restart e verificação próprios.

**Migrations idênticas.** O `publish.py` só troca as imagens com o banco
exatamente no conjunto de migrations da release. Se faltar alguma, entra o
caminho da seção seguinte; se o banco estiver à frente ou divergente, recusa.

**Deriva.** O que está no servidor precisa ser o que foi revisado aqui. Em
17/09/2026 o `Dockerfile.worker` do servidor descrevia uma imagem que não existia
mais, e ninguém percebia porque nada comparava os dois.

**Jogo começando não é guarda.** Por decisão do dono, a publicação não espera
jogo: a troca de imagens reinicia o worker, e a release com migration o para
antes do migrate, mesmo com jogo Pinnacle17 começando. O custo aceito é que um
restart nos minutos finais antes de um kickoff pode perder a captura final de
fechamento daquela aposta.

**Agendamentos.** O boot instala os crons de `WORKER_JOBS` e derruba o worker
se algum estiver ausente ou com cron diferente. Renomear ou tirar uma fila
agendada é seguro numa release comum: o boot desagenda sozinho o que saiu do
manifesto (`removeSchedulesOutsideManifest`, com log `schedule fora do manifesto
removido`), e um revert faz o caminho inverso. A fila antiga fica registrada no
pg-boss, vazia e sem efeito. Depois da publicação, confira:

```sql
SELECT name, cron FROM pgboss.schedule ORDER BY name;
SELECT name, state, count(*) FROM pgboss.job
WHERE name = '<fila antiga>' AND state IN ('created', 'retry', 'active') GROUP BY 1, 2;
```

Job que o cron antigo criou e ninguém consumiu fica em `created`: a execução
seguinte, já na fila nova, cobre o que ele faria.

## Releases com migration

[`deploy/migrar.py`](../deploy/migrar.py), chamado pelo `publicar.sh`. Existe
desde 21/09/2026; antes, a última release com migration
(`auditoria-c01-c06-20260916-3bc4b87`) foi feita à mão.

**Só passa migration compatível com a versão que está no ar.** A web antiga
continua no ar durante a aplicação, o worker antigo volta a rodar se a
publicação falhar, e o rollback automático do `publish.py` volta as imagens,
**não** o schema: nos três casos, código antigo roda contra o schema novo. E um
dado reescrito não volta com rollback nenhum.

A régua é uma **lista do que passa**; todo o resto vai para o caminho manual.
Até 21/09/2026 era uma lista do que proibir, e uma auditoria achou sete formas
de reescrever dado que ela aprovava (`UPDATE` dentro de `DO $$`, `INSERT ... ON
CONFLICT DO UPDATE`, `MERGE`, `DROP "coluna"` sem `COLUMN`, `CREATE RULE`,
`DISABLE TRIGGER`, `COPY FROM PROGRAM`).

| Passa (a lista inteira) | Exemplos do que não passa |
|---|---|
| `CREATE TABLE`, `CREATE INDEX`, `CREATE TYPE ... AS ENUM`, `ALTER TYPE ... ADD VALUE` | qualquer `DROP` fora de índice; `RENAME` fora de índice; trocar tipo |
| `ALTER TABLE` só com `ADD COLUMN` (anulável ou com `DEFAULT`), `ADD CONSTRAINT`, `ALTER COLUMN ... SET DEFAULT` ou `DROP NOT NULL` | `NOT NULL` sem `DEFAULT`, `SET NOT NULL`, `DROP DEFAULT`, `DROP CONSTRAINT` |
| `COMMENT ON`, `CREATE FUNCTION` nova (inerte: nada a chama) | `CREATE OR REPLACE FUNCTION`, trigger, rule, `DO`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY`, `TRUNCATE` |
| `ALTER INDEX ... RENAME TO`, `DROP INDEX` de índice comum, sem `CASCADE` (o código não usa nome de índice) | `DROP INDEX ... CASCADE`; `DROP INDEX` de índice único (pelo catálogo do banco no deploy; na CI, pelo histórico das migrations e pelos sufixos `_key`/`_uidx`): sem ele o código antigo grava duplicata e o `ON CONFLICT` falha |

Constraint nova (`PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE`, `CHECK`) e
`CREATE UNIQUE INDEX` só passam em tabela criada na mesma migration: numa tabela
existente, o código antigo ainda no ar pode violá-las, também quando vêm escritas
junto de um `ADD COLUMN`. A exceção é a `CHECK` de coluna nova que só lê essa
coluna, que o código antigo não escreve, e só chama funções nativas que não
escrevem: o PostgreSQL a executa em cada linha que já existe.

Ele também recusa se o banco tiver migration que a release não conhece, se uma
já aplicada mudou de conteúdo ou se houver migration inacabada. Medido contra
as 90 migrations do projeto em 21/09/2026: 47 passariam, 43 iriam para o
caminho manual.

Migration nova com nome anterior à última aplicada (dois PRs com migration que
entraram sem rebase, e a de nome menor chegou depois) não é recusada por isso:
o `prisma migrate deploy` aplica a pendente fora de ordem, ela passa pela mesma
régua e o plano a marca como "fora de ordem". No PR, a CI reprova migration nova
com nome anterior à última da `main`, para ela ser renomeada antes do merge.

**A CI roda a mesma régua em todo PR** (passo "Migrations novas passam na régua
do deploy", no job `verificações`): migration nova que não passa reprova o PR, a não
ser que declare na primeira linha que vai pelo caminho manual:

```sql
-- @migration-manual: backfill de <coluna>, aplicado à mão com o dono
```

A marca só libera a CI. O `publicar.sh --com-migration` continua recusando.
Migration já publicada não pode mudar nem sumir (a CI também recusa): o banco
de produção guarda o hash de cada uma.

Com uma release que traz migration:

1. `publicar.sh --preflight` mostra o plano (cada migration com **os comandos
   SQL** dela, e se é compatível) e para. Guarde o SQL para o relato ao dono.
2. Compatível: `publicar.sh --com-migration --commit <sha>`. O `migrar.py`,
   nesta ordem:
   1. faz backup com restauração conferida;
   2. lê o `DATABASE_URL_ADMIN` (sem ele, recusa com saída 2) e instala o CLI
      do Prisma num container **sem nenhum segredo** (a instalação roda
      scripts de terceiros);
   3. grava em `migration.json` qual worker vai parar (`workerStopped`,
      `workerContainerId`) e **para o worker antigo** (`docker stop`, com o
      shutdown gracioso do compose), sem esperar jogo começar, e só ele: a web
      continua no ar, o webhook do Telegram grava no pg-boss e o worker novo
      consome o que ficou na fila;
   4. aplica com `prisma migrate deploy` num container com nome
      (`automabaca-novo-migrate-<release>`), que recebe só o
      `DATABASE_URL_ADMIN`, pelo ambiente, e confere que o banco ficou igual à
      release. A sessão do migrate tem `lock_timeout` de 15 s (se outra sessão
      segura a tabela, desiste em vez de esperar) e `statement_timeout` de
      4 min; o container tem teto de 5 min, e estourado é removido junto com a
      sessão dele no banco.

   Depois o preflight roda de novo e aceita o worker parado **por esta
   migração** (o mesmo container, com o migrate concluído): a web, cujo
   healthcheck cai sem worker, precisa responder e alcançar o banco. O
   `publish.py` troca as imagens e sobe o worker novo.

   Por que parar: em 22/09/2026 o worker antigo rodou 17 minutos contra um
   schema que tinha perdido uma coluna e o valor `FULL` de `SharpMode`, e falhou
   25 vezes. Quanto tempo fica sem worker é **estimativa**, pelos tempos dos
   passos nas releases com migration de 23/09 (o worker ainda não parava):
   menos de 1 minuto no caso comum (migrate ~5 s, preflight e troca ~20 s); no
   pior caso, uns 10 minutos (shutdown de até 110 s, o teto de 5 min do
   migrate, até 2 min para o worker novo ficar saudável).
3. Se a migration falhar, passar do teto ou for interrompida (Ctrl-C, SIGTERM),
   o `migrar.py` sobe de novo o worker antigo e a publicação para antes de
   trocar as imagens, com saída 1, o motivo (lock que não veio em 15 s, comando
   que passou de 4 min, teto) e o backup de antes indicado em `migration.json`.
   Interrompido no meio do `docker stop`, ele espera a parada terminar antes
   de religar: um `docker start` antes disso seria ignorado. Interrompido no
   meio do migrate, espera o container acabar (até 30 s) ou o encerra antes de
   religar. **Não publique**: leia `migrate.log` e decida com o dono. O Prisma
   não aplica a migration numa transação: se ela falhou no meio, os comandos
   anteriores ficaram, e a migration aparece como falha em `_prisma_migrations`
   (o próximo `migrate deploy` recusa até um `prisma migrate resolve`). O
   worker antigo roda contra esse schema até a decisão; acompanhe os erros dele.
4. Se o `publicar.sh` sair depois de um migrate bem-sucedido sem publicar
   (preflight recusando, erro antes da troca, sinal), ele religa o worker
   antigo ao sair (`migrar.py --religar-worker`) e avisa. É o risco de antes
   desta mudança, código antigo contra o schema novo, só que agora visível: publique
   a release (de novo, com o mesmo comando) ou decida com o dono. Se o
   `publish.py` já tinha trocado as imagens e reverteu, o rollback sobe o
   worker antigo contra o schema novo do mesmo jeito, e o `rollback.json` fica
   na pasta da release.

Para provar o caminho sem mudar nada (rede, papel administrativo, CLI e
conexão), `sudo python3 deploy/migrar.py --release-dir <dir> --ensaio` roda
`prisma migrate status`, que só lê. Feito em 21/09/2026: ok, em cerca de 1 minuto.

Migration incompatível sai em duas releases. Primeiro o código que para de usar
o que ela vai apagar ou mudar (o banco continua como está); depois a migration,
marcada com `-- @migration-manual: <motivo>`. Mostre o SQL ao dono (o
`--preflight` imprime) e, com o sim dele para **aquela** migration:

```bash
ssh hermes 'bash /srv/apps/automabaca-novo/source/deploy/publicar.sh --nome <assunto> --commit <sha> --migration-manual <pasta-da-migration>'
```

O nome tem de bater exatamente: aprovar uma não libera outra. O caminho é o
mesmo do `--com-migration`: backup com restauração conferida, `prisma migrate
deploy` com o papel administrativo, conferência do banco e publicação.

## Desfazer uma release

Se a troca falhar, o `publish.py` volta sozinho para a release anterior (fica
registrado em `rollback.json`). Se a própria reversão falhar, ou o compose tiver
sido mexido por outro no meio, fica `rollback-failed.json` com o motivo e o
`publicar.sh` sai com 3: nada garante em que release estão os containers.

Para desfazer uma release que subiu bem mas trouxe um problema, reverta o commit
na `main` por PR e publique de novo: o caminho é o mesmo de qualquer release,
com as mesmas guardas.

A release que sobe bem e quebra um caminho aparece no **veredito da release**
(`ops.release_verdict`, a cada 15 min): 45 min depois de o worker dela ficar
pronto, um erro de fila que não aparecia antes e se repetiu ao menos 3 vezes
vira aviso no Telegram ("Erro novo junto com a release …", com o commit e as
mudanças desde a anterior) e fica em Monitoramento › Desempenho › Releases. O
aviso diz que o erro apareceu junto com a release, não que ela o causou: confira
o diff antes de reverter. Não há revert automático.

Os limites do veredito:

- Erro novo com menos de 3 tentativas na observação não vira aviso e passa a
  contar como conhecido por 30 dias depois da última vez que apareceu: as
  releases seguintes não o apontam, por mais que ele se repita. Ele fica no
  cartão da release que o trouxe ("abaixo do mínimo"). Em fila de pouco volume
  e sem retentativa (`closing.price_series`, um job por aposta), um bug novo
  raramente chega a 3 falhas em 45 min: olhe essa linha do cartão depois de
  uma release que mexeu numa fila assim.
- O pg-boss guarda só a mensagem da última falha de cada job. A tentativa cujo
  erro (o nome, gravado na métrica) não é o da última falha fica de fora; com o
  mesmo nome e outra mensagem, ela leva a mensagem da última.
- Depois de um rollback do `publish.py`, a release que voltou não é registrada
  de novo, e o link "Mudanças desde a anterior" da release seguinte parte da que
  foi desfeita.
- Erro de fornecedor não conta, com qualquer status: o 400, 404 ou 422 de uma
  URL ou parâmetro que a release quebrou também fica de fora. Ele aparece no
  cartão de Jobs como fornecedor fora.
- Falha do banco conta: a primeira queda ou lentidão do banco com 3 tentativas
  numa observação aponta a release que estava no ar (alarme falso), e depois
  fica conhecida.
- A métrica que o limite de capacidade descarta (`OBSERVABILITY_METRICS_DROPPED`)
  leva a tentativa junto: numa rajada, a contagem fica menor que a real.
- Cada passada lê até 20.000 tentativas, das mais velhas para as mais novas. Com
  muitas releases pendentes numa rajada de falhas, as mais novas perdem as
  tentativas depois do corte e podem sair sem erro novo; o log `RELEASE_VERDICT`
  avisa quando o teto foi atingido.

Voltar para uma versão anterior à fila `telegram.updates` não é um revert
simples: a versão antiga não consome essa fila, e o que estiver nela para. O SQL
que devolvia esses jobs às filas antigas ficou no histórico
(`git show 555397f:deploy/telegram-updates-devolver.sql`); decida com o dono
antes.

## Configuração de produção

Segredos e listas ficam em `/etc/automabaca-novo/runtime.env`, fora do Git.
[`deploy/split-env.cjs`](../deploy/split-env.cjs) gera o `web.env` e o
`worker.env` a partir da allowlist de
[`deploy/env-allowlist.cjs`](../deploy/env-allowlist.cjs): a web nunca recebe o
token do bot nem as chaves de LLM, só as flags de LLM (os modelos ficam no
catálogo em código, `src/infra/llm/models.ts`), nem as chaves e os modos da
Pinnacle17 e do FlashScore (lá eles ficam `off`); a BridgeOdds chega aos dois,
porque o botão "Odds fechamento" a consulta na web; o worker nunca recebe
as credenciais do painel; nenhum dos dois recebe o `DATABASE_URL_ADMIN`. O
`publicar.sh` não roda o `split-env`: mudar configuração é operação à parte.

O `split-env` lê a allowlist **da árvore em que ele mesmo está**, então rode-o de
dentro de um checkout no commit publicado:

```bash
cd /srv/apps/automabaca-novo/source
sudo node deploy/split-env.cjs
```

A cópia solta em `/srv/apps/automabaca-novo/deploy/` falha de propósito: ela
existe para o verificador de deriva comparar, não para rodar. Até 17/09/2026 o
script lia um caminho fixo para `source/`, que outras sessões trocavam de branch,
e o ambiente de produção chegou a ser gerado a partir de um commit de nove dias
antes.

Depois de mexer no `runtime.env`, **compare antes de reiniciar**: gere os
arquivos, confira variável por variável contra o que está rodando e confirme que
só mudou o que você queria.

## Evidências

Cada release deixa `evidence/releases/<release>/` com o artefato da CI, os logs
de montagem, o preflight, o backup e o `publication.json`. É o registro de
auditoria do que foi publicado, e por isso a limpeza de disco só remove as
pastas deriváveis (ver `docs/RETENCAO.md`).
