# Retenção: o que se guarda, onde, por quanto tempo e por quê

O princípio é um só: **o que prova alguma coisa fica; o que dá para reconstruir
tem prazo.**

Medido em 17/09/2026, antes de haver política: 81 GB usados na VPS, dos quais
25 GB em `/tmp`, 11 GB em imagens Docker antigas e 3 GB de pastas deriváveis em
`evidence/`. Nada estava quebrado; só ninguém tinha decidido quando as coisas
saem. Em 21/09/2026, com o desenvolvimento fora da VPS e uma limpeza, ficou em
27 GB.

## Resumo

| O quê | Onde | Retenção | Automático? |
|---|---|---|---|
| `/tmp` | VPS | 7 dias | sim (`systemd-tmpfiles`) |
| Pastas deriváveis de `evidence/releases/` | VPS | release viva + rollback; `artifact/runtime.tar.gz` nas 5 últimas (o manifesto fica) | sim, no fim de cada publicação (`deploy/limpar-evidencias.sh`) |
| Provas de cada release (`*.json`, `*.log`) | VPS | para sempre | — |
| Imagens Docker da aplicação | VPS | a viva, a de rollback e as de containers | sim, no fim de cada publicação (`deploy/limpar-evidencias.sh`) |
| Dump antes de cada publicação com migration (`backups/`), **em claro** | VPS (root, 0700) | sem prazo | não, de propósito |
| Evidência dos snapshots diários (sem o dump depois de cifrado; o que falhou na conferência, sem dump nenhum) | VPS, `/var/backups/automabaca-novo` | 14 dias (mínimo 2 conferidos) | sim |
| Pacote diário de recuperação | VPS, `exports/` | 30 dias (mínimo os 2 últimos) | sim |
| Pacote diário de recuperação | PC do dono | 7 dias (mínimo 2 verificados) | sim |
| Arquivo de logs sanitizados | VPS | 30 dias, teto de 4 GiB | sim |
| Imagens no ghcr.io | GitHub | 2 versões por imagem | sim (job `imagens` do `check.yml`) |
| Artefatos `release-<sha>` da CI | GitHub | os 3 mais recentes (e expiram em 14 dias) | sim (job `imagens`, mesmo se a publicação falhar) |
| Demais artefatos da CI | GitHub | `ci-build` (runtime de ~80 MB) 1 dia; registros `ci-verificacoes`/`ci-navegador` e traces do navegador 7 dias | sim (retenção) |
| Caches da CI (node_modules, tsc, Next) | GitHub (cache do Actions) | ver abaixo | sim (pelo GitHub) |
| Auditoria, métricas, filas do pg-boss e caches | Banco de produção | de 1 dia a 1 ano, por tabela: ver [Banco](#banco-o-que-o-código-apaga-sozinho) | sim (`audit.purge` e filas) |

## Banco: o que o código apaga sozinho

Quem apaga é o próprio código em produção: o job `audit.purge` (todo dia às
02:20 de São Paulo, em lotes de 5 mil linhas), a manutenção do fechamento no
`operational.actions` (5 min) e a manutenção do pg-boss. Nada aqui depende de
comando manual. Apostas, movimentações, contas, bancas, fichas de time, aliases de mercado,
eventos de liquidação (`settlement_events`) e a caixa de ações **não** têm
purga: são o registro do negócio.

| O quê | Tabela | Retenção | Por quê |
|---|---|---|---|
| Auditoria comum (inclui post de canal descartado, `canal_post_descartado`) | `audit_events` | 30 dias | rastro de rotina; o post descartado pode voltar à captura nesse prazo |
| Auditoria crítica: drifts (`bet_lucro_drift`, `conta_drift`, `bet_ledger_drift`), `budget_alert` e a causa da dead-letter retida (`job.dlq_retained`) | `audit_events` | 90 dias | investigação depois do fato; a causa dura o mesmo que a dead-letter |
| Auditoria financeira: `conta.*`, `bankroll.*`, `bet.create`, `bet.edit`, `bet.soft_delete`, `bet.not_taken_undone` e tudo o que a trilha da aposta exibe | `audit_events` | 365 dias | ciclo anual; a ficha da aposta não pode ficar furada |
| Exceções que ficam além do prazo | `audit_events` | enquanto valem | `bet.soft_delete` de aposta com 👎 ainda reversível; retirada de canal (`bankroll.update.previousTelegramChannelId` e `bankroll.delete.telegramChannelIds` não vazio), que impede recriar o tipster |
| Origens absorvidas por deduplicação | `absorbed_bet_sources` | enquanto a aposta existe | recibo técnico independente da auditoria; ao excluir o tipster, vai para `retired_bet_sources` |
| Prova antiga de origem absorvida, ainda sem recibo | `audit_events` (`bet.duplicate_absorbed`) | enquanto a aposta existe e falta o recibo | preserva a idempotência das capturas anteriores; ao excluir o tipster, aposenta a origem e apaga a prova detalhada |
| Recibos de criação solicitada pelo painel | `creation_receipts` | sem purga | identificador do pedido/recurso, executor e hash, sem dados do formulário; excluir o recurso não pode permitir sua recriação por reenvio |
| Agendamento da captura pela DM/conserto (`capture.followup`) | `audit_events` | pendente: sem expiração; confirmado: 30 dias | a outbox precisa retomar mesmo após uma interrupção longa |
| Recibo do aviso de incidente (`ops.alert_once_delivered`) | `audit_events` | 30 dias; preservado enquanto pertence ao ciclo aberto ou assumido da ação | evita repetir aviso já entregue durante uma condição persistente |
| Métricas operacionais | `operational_metrics` | 30 dias | SLO e painel olham 1 h a 7 dias |
| Séries diárias (`kind = 'daily'`: o casamento do dia) | `operational_metrics` | sem purga (uma linha por dia) | linha de base que se compara semanas depois e não se reconstrói; ver "Casamento do dia" em `docs/OBSERVABILIDADE.md` |
| Atividade dos canais | `telegram_channel_activity` | 90 dias | ritmo de cada canal para o vigia de canal calado |
| Sessões do painel | `auth_device_sessions` | até expirar; revogada, 30 dias depois da revogação | aviso de dispositivo novo e auditoria de acesso |
| Álbuns, rascunhos de DM, evidência da captura (30 dias), cooldowns do IA-Judge | `telegram_media_albums`, `telegram_dm_drafts`, `bet_capture_evidence`, `ia_judge_cooldowns` | até o `expiresAt` de cada linha | vida curta por desenho |
| Cache de provider | `provider_caches` | até vencer; o snapshot da BridgeOdds (`match:v2:*`) fica 30 dias depois de colhido | a identidade lê esse snapshot vencido; o resto nunca é lido vencido |
| Consumo de provider | `provider_budgets` | 90 dias pela última atualização | conferir cobrança; tela e briefing leem só o período corrente e 7 dias |
| Reserva de cota sem dono | `provider_budget_reservations` | 72 h | reserva que nenhum trabalho vai consumir |
| Arquivo de preço da Pinnacle | `price_archive_observations` | 30 dias (`PRICE_ARCHIVE_RETENTION_DAYS`) | o fechamento lê daqui o preço que a captura ao vivo não gravou |
| Série de fechamento | `closing_price_watches` | 30 dias depois do kickoff | repescagem do fechamento |
| Ligação de jogo dos catálogos (Pinnacle17 × FlashScore) | `catalog_game_links` | 90 dias depois do início do jogo | a liquidação e o aprendizado leem a do jogo da aposta, que é da semana |
| Ficha do time, as evidências dela e os nomes de tipster | `team_cards`, `team_card_evidence`, `team_tipster_names` | sem purga | o id do FlashScore com os nomes da Pinnacle17 e dos tipsters não se reconstrói; cresce com os times, não com os dias |
| Nome de tipster esperando a ligação do jogo | `team_tipster_name_waits` | 2 dias depois do jogo | o pareamento só liga jogo que ainda não começou |

O histórico da captura (`bet.create`) guarda os termos normalizados, o horário,
a origem, a unidade monetária e as pernas ou o contrato de jogador. Não depende
da evidência temporária de captura. A edição guarda país e campeonato antes e
depois, além dos valores efetivamente persistidos para o esporte. O casamento
automático e o decidido pelo juiz preservam o contexto anterior e o aplicado,
tanto pela Pinnacle17 quanto pela BridgeOdds. A restauração
guarda o resultado, lucro, instante de liquidação e conta restaurados, sem
depender da permanência do registro antigo de remoção.

Antes de uma edição ou reabertura invalidar a leitura de resultado, a prova
normalizada anterior é preservada: placar, jogo vinculado, snapshot do provider
e, quando houver, contrato e evidência de jogador. Na reabertura de uma aposta
liquidada, essa prova e os termos financeiros anteriores ficam em
`settlement_events`, sem purga. Em edição de uma aposta ainda pendente, ficam
na auditoria da edição, com retenção de um ano. Campos que não foram gravados
em acontecimentos antigos não são reconstruídos a partir do estado atual.

### Filas do pg-boss

| O quê | Retenção | Onde se decide |
|---|---|---|
| Job concluído de cron de até 5 min (`outbox.dispatch`, `closing.price_series_sweep`, `health.heartbeat`, `sharp.revive`, `closing.sync`, `operational.actions`) | 1 dia | `scheduledJobRetentionSeconds` em `src/jobs/queues.ts` |
| Job concluído dos demais crons | 2 dias; o semanal (`channels.weekly_digest`), 14, para o vigia de "parou de rodar" ainda achar a última conclusão | idem |
| Disparo interno dos crons (`__pgboss__send-it`) | 1 dia | `tunePgBossCronDispatchRetention`, no boot |
| Job concluído das filas de trabalho (enrich, captura, Telegram…) | 7 dias | padrão do pg-boss |
| Job que nunca começou | 14 dias | padrão do pg-boss |
| Dead-letter de fila de trabalho, esperando decisão | 90 dias | `DEAD_LETTER_RETENTION_SECONDS` |
| Dead-letter de fila agendada | sai na hora; fica o rastro `job.dlq_tick_discarded` (30 dias). Cron longo: o disparo volta à fila antes de sair | o próximo disparo (ou a retentativa) refaz o trabalho |

O pg-boss grava o prazo em cada job quando o cria: mudar a retenção vale para
os jobs novos, e os que já estavam na tabela saem no prazo antigo. O disparo
interno dos crons é a maior parte da tabela, e por isso fica só 1 dia.

## Cota de armazenamento do GitHub

Imagens do ghcr.io e artefatos da CI dividem os ~2 GB do plano. Em 21/09/2026 os
artefatos chegaram a 27 GB (cada execução subia o `runtime.tar.gz` de 81 MB duas
vezes), o GitHub passou a recusar uploads com `403` e a `main` parou de publicar.
Hoje: 2 versões de cada imagem (~1 GB) e 3 artefatos de release (~240 MB). O teste
`poda-do-registry.unit.test.ts` soma os dois e falha se passar do limite. Se um
upload voltar a dar `403`, olhe isto primeiro.

## `/tmp` na VPS: automático, 7 dias

[`deploy/tmpfiles-tmp.conf`](../deploy/tmpfiles-tmp.conf), instalado como
`/etc/tmpfiles.d/tmp.conf`, troca o padrão do sistema (30 dias) por 7. O
`systemd-tmpfiles-clean.timer` roda todo dia. A regra `x /tmp/claude-*` protege o
scratchpad de sessões do Claude ainda vivas, que podem ter arquivos com acesso
antigo.

Para limpar fora do horário, use a própria ferramenta do sistema, que respeita a
mesma regra:

```bash
sudo systemd-tmpfiles --clean
```

Não há script nosso para isso, de propósito: um `rm -rf` caseiro varrendo `/tmp`
seria a operação mais perigosa do repositório.

## Evidências de release: o derivável sai, a prova fica

Cada `evidence/releases/<release>/` ocupa ~650 MB, quase tudo derivado:

| Pasta | O que é | Retenção |
|---|---|---|
| `verified-runtime` | artefato da CI extraído | release viva + rollback |
| `web-layer`, `worker-layer` | contextos de build montados do anterior | release viva + rollback |
| `artifact/runtime.tar.gz` | runtime do artefato da CI | 5 releases |
| `artifact/release-manifest.json` | manifesto da CI, prova do conteúdo da imagem | **para sempre** |
| `*.json`, `*.log` | o que prova o que foi publicado | **para sempre** |

[`deploy/limpar-evidencias.sh`](../deploy/limpar-evidencias.sh) aplica isso, e o
`publicar.sh` o roda com `--apagar` depois de cada publicação (à mão, sem
argumento, só mostra). Com uma publicação por merge, eram ~20 GB por dia de
evidências mais as imagens, no mesmo disco do PostgreSQL. Ele descobre a
release viva lendo o `compose.yaml` e a de rollback pelo `baseRelease` do
`release.json` dela, não por uma lista escrita à mão. Se não conseguir ler o
compose, **aborta** (roda com `sudo`: o compose é do root). A remoção passa por
`ab_safe_remove_tree` ([`scripts/lib/safe-delete.sh`](../scripts/lib/safe-delete.sh)),
que exige raiz gerenciada e recusa symlink, alvo fora da raiz e travessia de
sistema de arquivos. Uma pasta preparada por `--preflight` e podada antes de
publicar é preparada de novo pelo `publicar.sh`.

## Imagens Docker na VPS: a viva e a de rollback

O `publish.py` exige que a imagem da release anterior exista **localmente**,
porque é ela que o rollback restaura. Remover imagem é a operação em que um
engano custa um rollback impossível, por isso o `limpar-evidencias.sh` só tira
as outras com as duas releases conferidas:

- ficam as imagens cujo ID está no `images.json` da viva e da de rollback, e as
  de qualquer container, parado ou não; sem os IDs das duas releases ou sem ler
  os containers `automabaca-novo-web` e `-worker`, **nenhuma** sai;
- só entram as referências `automabaca-novo-{web,worker}` (a tag local da
  release e a do ghcr.io, as duas: tirar só uma não libera espaço). Postgres,
  Node e o resto ficam;
- `docker image rm` sem `-f`, uma referência por vez; nada de `docker image
  prune -a`, que levaria a imagem da base (ela não tem container).

Apagar do ghcr.io não afeta o rollback.

## Dumps de publicação: sem prazo, de propósito

Cada publicação com migration (ou com `--com-backup`) grava um dump em
`/srv/apps/automabaca-novo/backups/` (~2 GB no total em 23/09/2026, quando toda
publicação gravava um). **Nenhuma limpeza automática os toca.** Um dump é a última linha de
defesa contra uma migration ruim, e o dia em que ele for preciso não é o dia de
descobrir que a política o apagou. Se o espaço apertar, a decisão é do dono,
caso a caso.

## CI no GitHub

A CI roda nos runners hospedados do GitHub e não deixa nada em máquina nossa.
O cache do Actions guarda o `node_modules` (pela chave do lockfile), o
`tsbuildinfo` e o cache do Next (uma entrada por execução); o GitHub apaga
sozinho o que fica 7 dias sem uso e o que passa do teto de 10 GB do
repositório. O PostgreSQL de cada job (em RAM, `scripts/ci-postgres.sh`) morre
com o runner.

O publicador automático guarda, no usuário que roda o cron dele, o log (até
~2 MB) e uma marca por commit tratado (60 dias) em `~/.local/state/automabaca/`.

## Desenvolvimento não vive mais na VPS

Até 21/09/2026 havia worktrees e servidores de IDE na VPS, com ~1,3 GB por
worktree. Hoje o desenvolvimento é no WSL do dono (ver `AGENTS.md`), e na VPS só
fica o checkout de referência `source/`, usado pelo deploy e pelo backup diário.
**Não apague `source/`**: sem ele o backup diário falha.
