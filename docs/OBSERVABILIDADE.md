# Observabilidade e investigação

Como os logs andam:

1. Web e worker escrevem JSON (Pino) no stdout; o Docker entrega ao journald do
   host.
2. O coletor (`automabaca-log-collect`) copia web, worker, PostgreSQL e Caddy
   para arquivos JSONL gzip sanitizados em `/var/log/automabaca-novo/archive/`,
   com retenção de 30 dias e teto de 4 GiB.
3. O exportador (`automabaca-log-export`) empacota esses arquivos cifrados com
   `age`, com manifesto e SHA-256, em `/srv/apps/automabaca-novo/exports/logs/`.
4. O PC do dono puxa os pacotes a cada 15 minutos (tarefa "AutomaBACA - copia de
   logs", ver `deploy/README.md`) e devolve um comprovante: é isso que o painel
   chama de **cópia externa**.

O código dessas etapas está em `infra/observability/`. O que vigia a produção
de fora da VPS está em "Vigia de fora", abaixo. AuditEvent e o ledger
financeiro são trilhas de negócio no banco, separadas dos logs técnicos e das
métricas de 30 dias.

## Primeiros passos

No host, conferir os timers e o estado independente do banco:

```bash
systemctl list-timers 'automabaca-log-*'
sudo cat /var/lib/automabaca-novo/observability/status.json
sudo cat /var/lib/automabaca-novo/observability/collection.json
sudo cat /var/lib/automabaca-novo/observability/export.json
```

`fresh` da cópia externa significa comprovante recente validado; não equivale
a uma restauração independente. Falhas/lacunas/atrasos aparecem também em
`/operacoes`. Não reconhecer lacuna de cursor antes de investigar o intervalo
perdido. O procedimento de reconhecimento exige timestamp exato e justificativa
em `infra/observability/acknowledge-gap.py`.

## Buscar uma operação

O header de resposta `x-correlation-id` identifica a requisição. Ações observadas
do painel herdam esse ID; payloads de fila o transportam em `_observability`.
Jobs agendados sem requisição têm identidade própria. Falhas de autorização
anteriores à ação continuam cobertas pelo proxy/Caddy e hook do Next.

Exemplo para os registros JSON da aplicação (inclusive containers substituídos):

```bash
sudo journalctl CONTAINER_NAME=automabaca-novo-web CONTAINER_NAME=automabaca-novo-worker --since '24 hours ago' --no-pager -o cat |
  jq -R 'fromjson? | select(.correlationId == "http_EXEMPLO") | {time,level,releaseId,mod,eventCode,correlationId,jobId,betId,msg}'
```

Trocar o filtro por `.releaseId == "RELEASE_EXEMPLO"`, `.betId == "ID_EXEMPLO"`
ou `.eventCode == "TELEGRAM_UPDATE_FAILED"` conforme a investigação. IDs são
exemplos. Não copiar conteúdo pessoal, prompts, corpos de requisição ou segredos
para tickets. Para períodos fora do journal, usar os arquivos sanitizados em
`/var/log/automabaca-novo/archive/logs-*.jsonl.gz`: cada linha tem `timestamp`,
`service` e `entry`; os campos da aplicação ficam dentro de `entry`.

## Contrato de eventos

- `eventCode`: código estável em `src/infra/log-events.ts`; texto é explicação,
  não chave de agrupamento. Warn/error novo em ponto crítico ganha código.
- `mod`, `process`, `releaseSha`, `releaseId`: origem do registro.
- `correlationId`, `jobId`, `betId`, `llmCallId`: vínculos, quando disponíveis.
- Duração em milissegundos. HTTP informa no log a duração do handler. A métrica
  HTTP mede o handler e é gravada depois de a resposta sair: a resposta não
  espera o INSERT. O `/api/health` grava métrica só quando o status muda e, com o
  status parado, uma amostra a cada 5 min (`sampling=status_change_or_5min`);
  `/api/logos/[file]` grava só falha técnica, como a rota de versão abaixo; o
  `/api/health/observability`, público, não grava métrica (o 503 é o veredito
  do vigia, que já alerta). Cada rota grava no máximo 120 amostras por minuto
  de cada classe de status; o excesso sai em `OBSERVABILITY_METRICS_DROPPED`
  com `reasonCode=http_route_budget`, para um flood de recusas anônimas não
  virar uma linha por requisição.
- Recusa de negócio não é falha técnica. Tentativa LLM falha não prova falha da
  cascata: cruzar com `LLM_CASCADE_COMPLETED`. `LLM_PROVIDER_EXHAUSTED` significa
  pool/orçamento daquele provider esgotado, podendo haver próximo provider.
- Acesso na borda (Caddy, `EDGE_REQUEST_COMPLETED`, `service: caddy` no arquivo):
  `route` é o molde da rota do Next (`/tipsters/[slug]/analyzer`, `/api/logos/[file]`),
  uma linha por página, API ou pasta pública em `infra/observability/automabaca.caddy`,
  e `/other` para o resto; nunca o caminho nem a query. `nextAction` (id da
  Server Action, 42 hex), `rsc` e `nextRouterPrefetch` separam action,
  navegação e prefetch da carga da página, que têm a mesma rota. O sanitizador
  refaz a rota com a mesma tabela e troca por `[invalid]` o cabeçalho fora do
  formato do Next. Página ou rota de API nova entra nas duas tabelas
  (`automabaca.caddy` e `archive_sanitize.py`), senão aparece como `/other`.
- Rota `/api/bankrolls/[slug]/version`: GET/POST têm correlação; polling bem-sucedido
  fica no acesso Caddy, sem INSERT HTTP por consulta. Falhas técnicas são medidas.
  Essas amostras recebem `sampling=errors_only` e ficam fora do cálculo de
  disponibilidade/SLO, pois não têm denominador de sucessos; continuam
  consultáveis nas métricas e nos logs de erro.

## Alertas e contenção

O responsável pela operação acompanha `/operacoes` e os eventos abaixo. Ações
de infraestrutura/código são do mantenedor; decisões financeiras continuam com
o dono, pelas ferramentas autorizadas do projeto.

| Evento/condição | Ação inicial |
|---|---|
| `OBSERVABILITY_METRICS_WRITE_FAILED` | Verificar DB/pool/locks; painel e SLO podem ter amostras ausentes |
| `OBSERVABILITY_METRICS_DROPPED` | Conferir concorrência/custo; não tratar SLO incompleto como disponibilidade comprovada |
| `OBSERVABILITY_METRICS_SLOW` | Escrita levou ≥200ms; comparar com carga e locks |
| `TELEGRAM_UPDATE_FAILED` | Update do Telegram falhou e volta pelo retry de `telegram.updates`; `chatIdHash`, `messageId` e `attempt` dizem qual post e quantas vezes |
| `CAPTURE_EVIDENCE_OFF_CONTRACT` | Uma captura gravou a evidência (`bet_capture_evidence.parsedJson`) fora do contrato de `src/domain/bet-capture.ts`; a aposta entrou assim mesmo. `parser` e `issues` dizem o caminho e o campo: acertar o escritor ou o contrato |
| `JOB_RETRY_EXHAUSTED` | Inspecionar DLQ e causa antes de reenfileirar. Em fila agendada a dead-letter sai ou volta à fila sozinha (ver [Tarefas agendadas](#tarefas-agendadas)) |
| Ação "Tarefa agendada parada" (`jobs.schedule-stale`) | A fila de cron não conclui há mais que o intervalo dela e a folga: ver log do worker e `pgboss.schedule`. Fecha sozinha quando ela volta a concluir |
| `SCHEDULE_TICK_MISSED` | Um disparo de cron de 30 min ou mais caiu no reinício do worker. Com `recovered: true` o pg-boss já criou um job dele no primeiro ciclo; com `false` (agendamento gravado sem a recuperação, só no primeiro boot depois da mudança) aquele disparo não roda |
| Ação "Tarefa agendada falhando" ou "não rodou" (`jobs.scheduled-failure`) | Cron curto: duas execuções esgotaram as tentativas em 6 h. Cron longo: o disparo e as 3 retentativas falharam. Ver o erro no log. Fecha quando a fila conclui depois da última falha |
| `WORKER_SELF_RESTART` / ação "Worker se reiniciou sozinho" (`worker.self-restart`) | O worker ficou 20 min sem concluir o heartbeat e saiu para o Docker subir outro; o processo novo avisa na primeira prova de vida. Ver o log do worker perto do último heartbeat (ver [Worker parado ou banco fora](#worker-parado-ou-banco-fora)) |
| `WORKER_SELF_RESTART_EXHAUSTED` / ação "Autocura do worker esgotada" | Três reinícios automáticos em 3 h não curaram: o worker segue travado de pé. Achar a causa e reiniciar à mão. Fecha sozinha quando um worker volta a concluir o heartbeat |
| `HEALTH_OUTAGE_ALERTED` / ação "Worker fora do ar" ou "Banco fora do ar" (`health.outage`) | A web viu o `/api/health` fora por 20 min seguidos. Fecha sozinha na volta, com o aviso de quanto durou (`HEALTH_OUTAGE_RECOVERED`) |
| `SLO_BREACH_DETECTED` / `SLO_BREACH_CHANGED` | Inspecionar série, amostra e causas em `/operacoes` |
| `PROVIDER_CIRCUIT_TRIPPED` | Circuito abriu de verdade: conferir `reason`/`failures` e a série `<provider>.breaker` (mede abertura, não recusa) |
| `LLM_MODEL_PARKED` | Modelo inexistente ou não liberado saiu da rotação por 7 dias (ou pelo `Retry-After`); tirar o modelo do catálogo (`src/infra/llm/models.ts`) ou, sem deploy, pô-lo em `LLM_MODELS_DISABLED`. Aparece também no card Modelos de OCR |
| `LLM_CREDENTIAL_BLOCKED` | O provedor recusou a chave (401, 402, crédito esgotado ou a chave inválida, expirada ou bloqueada que o Gemini responde com 400/403) e ela saiu da rotação por 1 h em todos os modelos; trocar a chave ou tirá-la do runtime.env (`GEMINI_API_KEYS`, `GEMINI_PAID_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`) |
| `LLM_MODELS_DISABLED_UNKNOWN` | `LLM_MODELS_DISABLED` cita um `provedor/modelo` fora do catálogo (grafia ou modelo que saiu) e ele foi ignorado; corrigir o runtime.env |
| `RELEASE_VERDICT` / aviso "Erro novo junto com a release" | Uma fila falhou pelo menos 3 vezes, nos 45 min depois da release ficar pronta, com um erro que não aparecia antes (fila, nome do erro e a impressão digital da mensagem, a mesma dos alertas). Abrir o link das mudanças e decidir se reverte na `main` ([RELEASE.md](RELEASE.md#desfazer-uma-release)); fornecedor que mudou dá o mesmo sinal. Fica em Monitoramento › Desempenho › Releases |
| `SLO_RECOVERED` | Série voltou a healthy com amostra suficiente |
| `SLO_NO_RECENT_SAMPLES` | Série saiu da janela; não é prova de recuperação. A ação do SLO violado continua aberta enquanto a série teve amostra nas últimas 24 h; depois fecha dizendo que não houve prova de recuperação |
| Coleta/exportação/cópia externa degradada | Consultar status, espaço e última execução dos timers |

As séries de IA por provedor (`llm.transport.*`) aparecem no painel, mas não
abrem ação nem mandam aviso: quando um provedor falha, a cascata segue para o
próximo. O aviso vem do desfecho, em `llm.cascade` (cascata sem leitura, ou
lenta) e no SLO das filas que esperam a leitura. Uma cascata que termina só com
recusas de conteúdo é `expected_retry`, mas se algum provedor tentado não
respondeu nada (transporte, cota, cooldown) ela conta como erro, com o label
`providersDown`: queda parcial também derruba o sucesso de `llm.cascade`.

Os logs de SLO saem na abertura, mudança de causa ou faixa expressiva de
gravidade, recuperação e resumo horário com contador de repetições suprimidas.
Esse estado de emissão é local ao processo e reinicia no deploy; o estado
durável e o cooldown das notificações permanecem no banco. O silêncio de uma
hora do SLO começa só com entrega confirmada; uma recusa deixa o aviso para
a próxima avaliação, mantendo a ação aberta.

A escrita de métricas tem pool próprio de 2 conexões por processo (web e
worker), separado do pool do negócio: cada métrica é um INSERT de um comando só,
sem transação, e a conexão leva `statement_timeout=250ms` e `lock_timeout=100ms`,
cobrados pelo servidor. A métrica não disputa conexão com o negócio nem abre
transação interativa, que falharia justo sob carga. Admite até duas escritas
simultâneas por processo, com fila de até 32 esperas por no máximo
100 ms para absorver rajadas curtas; excedentes ou esperas expiradas são
descartados com contador no log. Não há retry de amostras perdidas. Falha,
descarte, lentidão (≥ 200 ms) e sucesso após perdas têm resumos limitados a um
por minuto por categoria. Verificar descarte após publicar e antes de tirar
conclusões estatísticas.

## Tarefas agendadas

Os crons ficam em `src/jobs/worker-jobs.ts`, escritos no relógio de São Paulo
em UTC−3 fixo (`Etc/GMT+3`), o mesmo offset do resto do código: o "07:10" de um
comentário é o "10 7" do cron, e sem horário de verão nenhum disparo some nem se
repete. O boot faz upsert de cada agendamento em `pgboss.schedule` e confere
cron, fuso e recuperação: trocar um cron no código vale na release seguinte,
sem passo manual, e um agendamento que ficou diferente derruba o boot.

- **Disparo que cai no reinício.** O pg-boss só cria o job de um disparo num
  ciclo do cron (a cada 30 s) até 60 s depois dele, e a publicação (drenagem do
  worker e boot do novo) deixa um buraco maior. Nos crons de 30 min ou mais o
  agendamento leva `missed: "once"`: o primeiro ciclo depois do buraco cria UM
  job do disparo mais recente que ficou nele, numa vaga própria daquele disparo,
  e o ciclo seguinte já não o vê, então ele nunca roda em dobro. O boot registra
  cada um no log (`SCHEDULE_TICK_MISSED`). Nos crons de 1 a 20 min o disparo
  seguinte cobre.
- **Minutos espalhados.** Os crons de 5 a 20 min não se acumulam no mesmo
  minuto: cada família de minuto (o resto por 5) tem um cron de 5 em 5 e no
  máximo mais um. Alinhados no minuto cheio, disputariam o pool do banco no mesmo
  segundo, que é onde as gravações de métrica lentas ou perdidas se concentram.
- **Dead-letter de fila agendada não espera replay.** O job é um disparo do
  cron, e voltar sem chave ocuparia a vaga da fila `exclusive` (os disparos
  seguintes seriam recusados até ele rodar).
  - Cron curto (intervalo menor que 2 h): a dead-letter sai, e o próximo disparo
    refaz o trabalho. Fica o rastro `job.dlq_tick_discarded` em `audit_events` e,
    se repetir em 6 h, uma ação "Tarefa agendada falhando".
  - Cron longo (diário, de 2 em 2 h): o disparo volta à fila com chave própria
    (`scheduled-retry:<disparo>`), que não disputa a vaga dos disparos do cron,
    e roda de novo em até 2 h (no máximo metade do intervalo). Até 3 vezes por
    disparo; esgotadas, a ação "Tarefa agendada não rodou".
- **Vigia.** O heartbeat (5 min) compara a última conclusão de cada fila do
  manifesto com o maior intervalo do cron dela mais uma folga de 15 min a 1 h, e
  abre a ação "Tarefa agendada parada". Na primeira hora depois do boot (ou no
  prazo da fila, se for menor) a fila atrasada não abre aviso novo, para o
  deploy não alarmar, mas a ação que já estava aberta continua aberta: ela e a
  "Tarefa agendada falhando/não rodou" só fecham quando a fila volta a concluir.
  O `/api/health` continua olhando só o heartbeat, que é quem roda o vigia.
- **Retenção.** Job concluído de cron de até 5 min e a fila interna
  `__pgboss__send-it` ficam 1 dia; os demais crons, 2 dias (ver
  `docs/RETENCAO.md`).
- **Revival.** Roda às 04:30 com teto de 1 h: aos 50 min para de pegar aposta
  nova, respeita o cancelamento do job e nunca roda duas vezes ao mesmo tempo. A
  avaliação de probation vem depois, às 05:45.

Dead-letter de fila de trabalho (não agendada) fica retida até 90 dias esperando
decisão. Quando o job sai da dead-letter, a ação da caixa fecha dizendo por quê:
reprocessada, descartada porque a aposta foi removida, tique descartado, ou
"saiu da fila sem decisão" (expirou ou foi apagada fora do painel).

A classificação da falha (`src/domain/dlq-classification.ts`) lê erro do Prisma
pelo código: P1001/P1002/P1008/P1017/P2024/P2028/P2034/P2037, os SQLSTATE de
cancelamento, conexão, recurso e deadlock (no `code` do driver ou no
``Code: `…` `` do Prisma) e a conexão quebrada do driver `pg` são passageiros;
P2002 e P2025 são recusa do dado; o resto (schema divergente, por exemplo) é
`other`. Nas filas que esperam provider, a falha do banco conta como erro no SLO
e vai ao log com `errorCode` e `errorMessage`, mesmo sendo retentada.

## Comparar modelos de leitura (OCR/visão)

O card **Modelos de OCR** em `/operacoes` tem duas leituras, e elas respondem
perguntas diferentes.

**Diagnóstico por modelo** conta *tentativas*. Serve para achar quota, erro de
API e consumo, mas **não compara modelos**: o carrossel para na primeira leitura
aceita, então um modelo só é chamado quando os anteriores falharam. Quem é
chamado por último recebe a sobra difícil e parece pior do que é; quem quase não
responde, bloqueado por capacidade, aparece bem porque só entra na conta nas
raras vezes em que conseguiu responder.

**Comparação por item** é a que decide. Um *item* é uma extração — um
`llmCallId`. A posição do modelo dentro do item é a ordem da primeira tentativa
dele. Apenas a **posição 1** entra na amostra, e como a primeira posição é
sorteada durante a avaliação (`evaluationOrder`, com `LLM_VISION_EVALUATION=1`),
cada modelo recebe uma amostra aleatória da mesma população de posts. Daí saem:

- **Resolveu** = leituras aceitas / itens atribuídos — a verdade operacional,
  incluindo o que a capacidade do provedor impediu.
- **Quando respondeu** = aceitas / (aceitas + rejeitadas) — qualidade pura de
  extração, sem quota no meio.
- **IC 95%** (Wilson) — faixa provável. Amostra pequena abre a faixa, e é isso
  que impede eleger um modelo por três acertos em quatro tentativas.
- **Salvamentos** — itens que o modelo resolveu fora da primeira posição: o
  valor de quem cobre a falha dos outros.
- **Falhas exclusivas** — itens que outro modelo resolveu e este rejeitou.

Quando mais de um modelo já ocupou a primeira posição em uma tarefa, a ordem é
sorteada e a comparação vale. Em visão detalhada (`precisionVision`, tarefas
`channel-album` e `channel-player-image`) a ordem dos modelos é fixa: o painel
avisa, porque ali só o primeiro da lista tem amostra.

Os itens que **ninguém** conseguiu ler aparecem em lista própria, com data,
tarefa, quantos modelos tentaram e a referência da mensagem. Poucos modelos
tentados indica cascata interrompida por orçamento ou cota — isso não condena os
modelos. Muitos modelos tentados sugere imagem realmente ilegível.

### Motivo das rejeições

O label `extractionState` separa o que a contagem de "rejeitadas" junta:
`draft` = o modelo leu, mas **faltou odd ou stake** (`missingExtractionNumbers`);
`review` = problema de **conteúdo** (fixture incompleta, seleção não
reconciliada, placar ao vivo não comprovado, lista incompleta). A semântica vive
em `src/services/capture/reading/extraction-quality.ts`.

### Tempo

O tempo exibido como principal é o **tempo até uma leitura apta** — só leituras
aceitas entram. O tempo de "todas as respostas" continua ao lado, para
diagnóstico, e inclui rejeitadas e respostas inaproveitáveis. Quota, HTTP e
timeout nunca entraram na latência, porque não são 2xx.

### Zerar o histórico

`deploy/reset-llm-attempts.py` zera o card para começar uma coleta nova. Ele
**exporta as linhas afetadas antes de apagar** e grava contagem e SHA256 ao
lado; sem `--apply` apenas relata. Apaga somente `name='llm.attempt'`, que é a
fonte exclusiva do card: o SLO lê `llm.transport.*` e `llm.content.*`
(`src/services/ops/slo/slo.ts` ignora `llm.attempt` de propósito) e por isso
mantém o histórico.

## Casamento do dia

O resumo das 00:05 traz o bloco **Casamento**, só com as linhas que têm número
(sem nenhuma, o bloco some), e grava os mesmos números numa série diária em
`operational_metrics`: `kind = 'daily'`, `name = 'matching'`, uma linha por dia,
com `occurredAt` no início do dia em São Paulo e os números em `labels`. É a
linha de base para comparar semanas antes e depois de uma mudança nos aliases.
A linha é gravada antes do envio, a retentativa do resumo não a troca, e ela
fica fora do SLO e da purga de 30 dias. O código está em
`src/services/ops/digests/matching-day.ts`.

**O primeiro dia da série fica fora da comparação.** A primeira olhada do
FlashScore nasceu vazia com o deploy. A aposta que já estava em observação
guarda a leitura anterior como primeira olhada, mas é a última leitura antes do
deploy, não a primeira: o jogo em observação havia dias pode cair no dia do
deploy. E o id dos dois times só existe nas leituras novas. A consulta de 7 dias
abaixo já tira esse dia.

Cada número conta pelo instante já gravado do que mede. O que muda depois
(candidato que chega, kickoff corrigido, evidência do resultado apagada pela
correção, pelo Vincular ou pela reabertura) não desfaz a conta:

| Em `labels` | O que conta | Dia da aposta |
|---|---|---|
| `trainingQueueBets` | apostas cujo caso de treino virou ação na caixa (fila Vincular): a reconciliação de 5 min abre a ação quando o caso entra na fila (`trainingCaseDueForOwnerWhere`) e a reabre quando ele volta. O caso resolvido antes de virar ação não conta | o dia em que o caso entra na caixa (`openedAt`) e, de novo, o dia em que volta a ela (`reopenedAt`) |
| `settled.automatic` e `settled.manual` | liquidadas, por quem as tirou de pendente pela última vez: FlashScore e IA-Judge sozinho são automáticos; painel, `ops-settle` e sugestão do IA-Judge aprovada pelo dono são à mão | `settledAt`, a régua do "liquidada(s)" do resumo |
| `flashscore.looked` | apostas que o FlashScore olhou, sem as de esporte que ele não liquida (essas não gravam a primeira olhada) | um dia só: o da primeira olhada, gravada na aposta uma vez só (`bets.flashscoreFirstCheckedAt`), mesmo que tenha vindo tarde |
| `flashscore.notFoundByReason` | das olhadas, as que ele não achou, pelo desfecho da última leitura até as 00:05 (`no_candidate`, `below_threshold`, `ambiguous`, `kickoff_mismatch`, `invalid_event`) | idem |
| `flashscore.notFoundWithBothTeamIds` | das não achadas por `no_candidate` ou `below_threshold`, as em que ele conhecia o id dos dois times: aí a busca não cai para o nome (`match-identity.ts`), e o jogo que falta fica para o dono. Em `kickoff_mismatch` e `ambiguous` ele achou o par. Múltipla não entra | idem |
| `flashscore.evidenceErased` | das olhadas, as sem evidência na hora do resumo: a correção, o Vincular ou a reabertura apagou a leitura e ele ainda não olhou de novo. No texto do resumo entram em "de N" (olhadas), sem motivo | idem |
| `identityBeforeKickoff` | a linha "Jogos do dia casados antes do início" (`matched` de `total`) | o início do jogo |
| `catalog.linkedGames` | jogos da Pinnacle17 ligados pelo pareamento dos catálogos, `ok` e 1:1 (o jogo do FlashScore com dois eventos sai na leitura) | o início do jogo na Pinnacle17 |
| `catalog.teamCards` e `catalog.newTeamCards` | fichas de time existentes ao fim do dia, e as que nasceram nele | a primeira vez que a ficha foi vista (`firstSeenAt`) |

Se a leitura desses números falhar, o resumo sai sem o bloco, o dia fica sem
linha na série e o log registra `OBSERVABILITY_METRICS_WRITE_FAILED`.

A série, dia a dia, na produção (só leitura):

```bash
ssh hermes "sudo -n docker exec -i automabaca-novo-db psql -U automabaca_novo -d automabaca_novo" <<'SQL'
BEGIN READ ONLY;
SELECT labels->>'day' AS dia,
  (labels->>'trainingQueueBets')::int AS vincular,
  (labels->'settled'->>'automatic')::int AS liq_auto,
  (labels->'settled'->>'manual')::int AS liq_mao,
  (labels->'flashscore'->>'looked')::int AS fs_olhadas,
  labels->'flashscore'->'notFoundByReason' AS fs_sem_jogo,
  (labels->'flashscore'->>'notFoundWithBothTeamIds')::int AS fs_dois_ids,
  (labels->'flashscore'->>'evidenceErased')::int AS fs_sem_evidencia,
  (labels->'identityBeforeKickoff'->>'matched')::int AS casadas_antes,
  (labels->'identityBeforeKickoff'->>'total')::int AS jogos,
  (labels->'catalog'->>'linkedGames')::int AS catalogo_jogos,
  (labels->'catalog'->>'teamCards')::int AS fichas,
  (labels->'catalog'->>'newTeamCards')::int AS fichas_novas
FROM operational_metrics
WHERE kind = 'daily' AND name = 'matching'
ORDER BY "occurredAt" DESC
LIMIT 30;
ROLLBACK;
SQL
```

Os 7 dias antes e os 7 depois de uma mudança: troque `2026-10-01` pelo primeiro
dia com a mudança no ar. O primeiro dia da série (o do deploy da medição) sai
pelo filtro `occurredAt >`. As colunas `pct_*` são taxas e se comparam direto.
`vincular_por_dia` e `fs_dois_ids_por_dia` são contagens médias por dia: leia
junto do volume (`jogos`, `fs_olhadas`), que muda de uma semana para outra.

```sql
BEGIN READ ONLY;
WITH d AS (
  SELECT CASE WHEN (labels->>'day')::date < DATE '2026-10-01' THEN 'antes' ELSE 'depois' END AS periodo,
    (labels->>'trainingQueueBets')::int AS vincular,
    (labels->'settled'->>'automatic')::int AS liq_auto,
    (labels->'settled'->>'manual')::int AS liq_mao,
    (labels->'flashscore'->>'looked')::int AS fs_olhadas,
    (SELECT coalesce(sum(value::int), 0) FROM jsonb_each_text(labels->'flashscore'->'notFoundByReason')) AS fs_sem_jogo,
    (labels->'flashscore'->>'notFoundWithBothTeamIds')::int AS fs_dois_ids,
    (labels->'identityBeforeKickoff'->>'matched')::int AS casadas,
    (labels->'identityBeforeKickoff'->>'total')::int AS jogos
  FROM operational_metrics
  WHERE kind = 'daily' AND name = 'matching'
    AND (labels->>'day')::date >= DATE '2026-10-01' - 7
    AND (labels->>'day')::date < DATE '2026-10-01' + 7
    AND "occurredAt" > (SELECT min("occurredAt") FROM operational_metrics WHERE kind = 'daily' AND name = 'matching')
)
SELECT periodo, count(*) AS dias,
  round(avg(vincular), 1) AS vincular_por_dia,
  round(100.0 * sum(liq_auto) / nullif(sum(liq_auto + liq_mao), 0), 1) AS pct_liq_auto,
  round(100.0 * sum(fs_sem_jogo) / nullif(sum(fs_olhadas), 0), 1) AS pct_fs_sem_jogo,
  round(avg(fs_dois_ids), 1) AS fs_dois_ids_por_dia,
  round(100.0 * sum(casadas) / nullif(sum(jogos), 0), 1) AS pct_casadas_antes,
  sum(jogos) AS jogos, sum(fs_olhadas) AS fs_olhadas
FROM d GROUP BY periodo ORDER BY periodo;
ROLLBACK;
```

## Pareamento dos catálogos

O job `teams.catalog_pairing` (08:37, 12:37, 16:37 e 20:37 de São Paulo) liga
os jogos da Pinnacle17 aos do FlashScore e grava as fichas de time. Cada rodada
olha de agora até o fim do dia de São Paulo ou 12 h à frente, o que for mais
longe: a das 20:37 cobre a madrugada até as 08:37. A tradução dos nomes, o
aprendizado do nome do tipster e a liquidação leem o que ele grava (ver "Fichas
dos times", abaixo). O código está em `src/services/teams/catalog-*.ts`.

- **Esportes:** futebol sempre; basquete, hóquei, vôlei e handebol só com aposta
  nos últimos 30 dias. Tênis, eSports, beisebol e os individuais ficam fora.
- **Chamadas:** a Pinnacle17 dos dias UTC que a janela toca e o catálogo do
  FlashScore dos dias de São Paulo que os eventos tocam (±15 min), em série e
  pelo cache dos clientes. Antes de cada uma, o
  circuito do fornecedor e o gasto do dia: circuito aberto ou gasto acima de
  60% do teto (`provider_budgets`) param a rodada sem chamar. A primeira falha
  também para, e o que já foi pedido do esporte não é gravado. Falha de
  fornecedor não derruba o job: a rodada seguinte refaz o dia.
- **O par:** jogo do FlashScore a até 15 min, fora adiado, cancelado e base;
  soma dos lados ≥ 1,5 com um lado âncora e 0,3 de folga sobre qualquer outro
  compatível na janela.
- **O país da competição**, dos dois lados, lido como país ou macro-região
  (Europa, América do Sul, CONCACAF, Ásia, África, Oceania, Mundo; "North
  America" e "North & Central America" são a mesma): dois países da tabela
  fixa diferentes recusam (a Pinnacle17 põe a liga da Irlanda do Norte em
  "Ireland", e fica sem ligação); a mesma macro-região liga só com os dois
  lados de evidência própria ≥ 0,85; região de um lado e país do outro não
  ligam; "Undefined", "Unknown", "Not specified", "Americas" e vazio não
  ligam; no Mundo, competição de clubes (amistoso) não liga e seleção liga.
- **A ficha:** só de lado com evidência própria ≥ 0,85 (a abreviação expandida
  do FlashScore vale 0,95), fora de amistoso de clubes e de seleção da tabela
  fixa, que só serve para isso. Seleção fora da tabela ganha ficha.
- **Gravação:** o jogo do FlashScore nunca é trocado. Outro par numa rodada
  seguinte vira `status = 'conflict'` com o candidato em
  `conflictFlashscoreMatchId`; `moved` marca o horário que mudou mais de 15
  min. A ficha só nasce do lado com evidência própria ≥ 0,85, de ligação `ok` e
  1:1; uma evidência por evento.
- **Uma rodada por vez:** fila `exclusive` e `pg_try_advisory_lock` no job.

Cada rodada grava uma métrica `kind = 'action'`, `name = 'teams.catalog_pairing'`,
com os números em `labels`: `pinnacleEvents` (tentados), `paired`, `base`,
`noCandidate` (nada do FlashScore na janela), `weak`, `ambiguous`, `country`,
`withoutCatalog` (catálogo do FlashScore vazio num dia da janela), `conflicts`,
`moved`, `newCards`, `delayedTipsterNames`, `nameDivergences`, `sportsSkippedBreaker`,
`sportsSkippedBudget`, `emptyCatalogs`, `until` (fim da janela) e
`stoppedBy`/`stoppedAt` (`breaker`, `budget`, `failure` ou `locked`, e o
fornecedor). A rodada inteira tem `outcome = 'success'`; a que parou,
`expected_retry` (a seguinte refaz). `conflicts` e `moved` contam só as
ligações que viraram naquela rodada. O resumo das 00:05 traz a linha
"Catálogos" no bloco Casamento.

**Alerta:** quando o id do FlashScore de uma ficha ganha um nome da Pinnacle17
que não se parece com nenhum dos anteriores (`teamNameEvidence` < 0,5 contra
todos), a caixa de ações recebe "Ficha …: nome novo na Pinnacle" (fonte
`teams.catalog_pairing`, chave `name:<esporte>:<id>`). Só avisa: o nome fica
gravado. Confira se a Pinnacle renomeou o time ou se o jogo foi ligado errado.

As rodadas dos últimos dias, na produção (só leitura):

```sql
BEGIN READ ONLY;
SELECT "occurredAt", outcome, labels->>'stoppedBy' AS parou, labels->>'stoppedAt' AS em,
  (labels->>'pinnacleEvents')::int AS eventos, (labels->>'paired')::int AS pares,
  (labels->>'noCandidate')::int AS sem_candidato, (labels->>'weak')::int AS fracos,
  (labels->>'ambiguous')::int AS ambiguos, (labels->>'country')::int AS pais,
  (labels->>'conflicts')::int AS conflitos, (labels->>'newCards')::int AS fichas_novas
FROM operational_metrics
WHERE kind = 'action' AND name = 'teams.catalog_pairing'
ORDER BY "occurredAt" DESC
LIMIT 20;
ROLLBACK;
```

As ligações de um dia, com o dobro (dois eventos no mesmo jogo do FlashScore) e
os conflitos à vista:

```sql
BEGIN READ ONLY;
SELECT l.sport, l."pinnacleHome" || ' x ' || l."pinnacleAway" AS pinnacle,
  l."flashscoreHome" || ' x ' || l."flashscoreAway" AS flashscore,
  l.status, l."conflictFlashscoreMatchId", l.moved, l.score,
  count(*) OVER (PARTITION BY l."flashscoreMatchId") > 1 AS dobro
FROM catalog_game_links l
WHERE l."kickoffPinnacle" >= '2026-09-25 03:00+00' AND l."kickoffPinnacle" < '2026-09-26 03:00+00'
ORDER BY l."kickoffPinnacle";
ROLLBACK;
```

## Fichas dos times

As fichas (`team_cards`) traduzem o nome da aposta antes da busca em cada
fornecedor, e a ligação do jogo ajuda a liquidação (as regras estão no
`BLUEPRINT.md`, "Pareamento dos catálogos e fichas dos times"). Métricas, todas
`kind = 'action'` e `outcome = 'success'`:

- `team_alias.apply`: cada tradução para a Pinnacle; `labels.home`/`away` é a
  estratégia de cada lado (`tipster_name`, `pinnacle_name`, `flashscore_name`,
  `card_only`, `ambiguous` ou `original`) e `identities`, quantos lados acharam
  ficha.
- `team_identity.resolve`: a tradução para o FlashScore na observação;
  `labels.result` é `card`, `absence` ou `ambiguous`, e `providerIds`, quantos
  ids de time do FlashScore a busca levou.
- `team_tipster_name.learn`: um lado de cada identidade automática;
  `labels.result` diz o que houve (`pending`, `confirmed`, `same_event`,
  `same_bet`, `same_day`, `ambiguous` (o nome pendente noutra ficha do mesmo
  esporte, país e categoria), `already_confirmed`, `conflict`, `same_name`,
  `name_problem`, `other_side`, `no_card`, `category`, `pinnacle_mismatch`, ou
  `no_link` para o jogo sem ligação usável, que fica esperando em
  `team_tipster_name_waits` e aprende quando a rodada do pareamento o ligar:
  `delayedTipsterNames` na métrica da rodada).
- `flashscore.catalog_link`: a aposta sem jogo vinculado com identidade
  casada; `labels.result` é `used` (a ligação deu o jogo), `refused` (as travas
  de horário ou categoria recusaram, ou os ids dos times que o FlashScore
  devolve não são os da ligação, e a busca por nome decidiu), `orientation`
  (os nomes da aposta não dizem a orientação contra os da Pinnacle17 da
  ligação) ou `no_link`.
  O snapshot da observação guarda `identityResolution.source`
  (`result_match`, `catalog_link` ou `search`).

O nome já confirmado noutra ficha vira auditoria `team_tipster_name.conflict`
(sem ação para o dono). Os nomes de tipster de uma ficha, na produção:

```sql
BEGIN READ ONLY;
SELECT c.sport, c."flashscoreName", c.country, c.category, n.name, n.status, n."firstDay", n."confirmedAt"
FROM team_tipster_names n JOIN team_cards c ON c.id = n."cardId"
ORDER BY n."createdAt" DESC
LIMIT 50;
ROLLBACK;
```

## Consultas lentas

O PostgreSQL registra toda consulta de **500 ms ou mais**
(`log_min_duration_statement`), sem os parâmetros (`log_parameter_max_length=0`:
um `$1` pode ser nome, texto de post ou chat). A fonte da verdade é o `command:`
do serviço `db` em `deploy/compose.yaml`. Não há `pg_stat_statements`: ele
exige `shared_preload_libraries`, isto é, reiniciar o banco.

- **No journal da VPS** fica a linha inteira (`duration: 612.3 ms  execute
  <unnamed>: SELECT ...`), por 30 dias ou 512 MB:
  `sudo journalctl CONTAINER_NAME=automabaca-novo-db --since '-24h' -o cat | grep 'duration:'`.
- **No arquivo sanitizado** vira `DATABASE_SLOW_STATEMENT` com `durationMs`,
  `phase`, `command`, a primeira tabela (`relation`) e `fingerprint`, o hash do
  SQL sem literais: agrupa a mesma consulta e acha o texto no journal. Nenhum
  valor sai da VPS. Cada linha do stderr vira uma entrada do journal; o
  coletor junta ao cabeçalho as linhas seguintes de um SQL de várias linhas (o
  pg-boss escreve assim) só para calcular esses campos. Linhas sem o prefixo
  `%m [%p] %e` e as de erro (`STATEMENT:`, `DETAIL:`), que podem ter valores
  literais, não entram no arquivo.
- **Volume:** em 23/09/2026 o banco escrevia ~750 linhas por dia, quase todas
  de checkpoint. Quantas consultas passam de 500 ms não se sabia (era isso que
  faltava medir). Confira depois de um dia com o `grep -c 'duration:'` acima;
  se passar de uns 2.000 por dia, suba o limite no compose e no `ALTER SYSTEM`.

### Aplicar na VPS

Mudar o compose não muda o banco no ar: a publicação só recria web e worker, e
recriar o `db` derruba os dois por alguns segundos. A configuração entra sem
restart por `ALTER SYSTEM` + `pg_reload_conf()`; o compose passa a valer na
próxima vez que o container do banco for recriado, e a linha de comando tem
precedência sobre o `postgresql.auto.conf`.

A ordem importa: o `publicar.sh` recusa com o compose vivo diferente do
versionado, e o publicador automático não tenta de novo um commit recusado.
Logo depois do merge, **antes** de a CI da `main` terminar:

```bash
# 1. Compose vivo igual ao versionado (sob a trava do publicar.sh, que o lê).
flock -n /srv/apps/automabaca-novo/.publicar.lock sudo python3 - <<'EOF'
from pathlib import Path
p = Path('/srv/apps/automabaca-novo/deploy/compose.yaml')
s = p.read_text()
linha = "    - 'log_line_prefix=%m [%p] %e '\n"
assert s.count(linha) == 1 and 'log_min_duration_statement' not in s
p.write_text(s.replace(linha, linha + "    - -c\n    - log_min_duration_statement=500ms\n"
                                      "    - -c\n    - log_parameter_max_length=0\n"))
EOF

# 2. O mesmo valor no banco no ar, sem restart.
sudo docker exec automabaca-novo-db psql -U automabaca_novo -d automabaca_novo -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET log_parameter_max_length = 0" \
  -c "ALTER SYSTEM SET log_min_duration_statement = '500ms'" \
  -c "SELECT pg_reload_conf()"
sudo docker exec automabaca-novo-db psql -U automabaca_novo -d automabaca_novo -At \
  -c "SELECT name, setting, source FROM pg_settings WHERE name IN ('log_min_duration_statement', 'log_parameter_max_length')"
# esperado: 500 e 0, source "configuration file"
```

Se o publicador chegou antes e recusou o commit por deriva, faça os dois passos
e publique à mão (`publicar.sh --nome <assunto> --commit <sha>`). Nas duas
ordens nada quebra em produção: o pior caso é a release atrasar.

Quando o container do banco for recriado (troca da imagem do PostgreSQL, por
exemplo), a linha de comando assume (`source` = `command line`); aí apague o
estado duplicado, para o compose ser a única fonte:

```bash
sudo docker exec automabaca-novo-db psql -U automabaca_novo -d automabaca_novo -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM RESET log_min_duration_statement" -c "ALTER SYSTEM RESET log_parameter_max_length" \
  -c "SELECT pg_reload_conf()"
```

## Publicação e restauração

Mudança na aplicação sai numa release web/worker normal (`docs/RELEASE.md`). O
normalizador (com o `collect.py`, que o importa) e o mapa de rotas do Caddy
são do host e **não** vão na release: instale à mão
`infra/observability/archive_sanitize.py` e `collect.py` em
`/usr/local/lib/automabaca-novo/observability/` e o trecho alterado de
`infra/observability/automabaca.caddy` em `/etc/caddy/sites-enabled/`
(esse é o único arquivo do site do Caddy no repositório). Valide a configuração
antes do reload e não rode o instalador inteiro só para trocar esses
arquivos. Na VPS, depois que o `publicar.sh` rodou para o commit (publicado
ou recusado, ele já pôs o checkout nele; o checkout só é mexido por ele):

```bash
cd /srv/apps/automabaca-novo/source
# Sanitizador antes do coletor (o coletor novo importa função nova dele) e os
# dois antes do Caddy (o sanitizador novo aceita log com e sem os campos novos).
sudo install -o root -g root -m 644 infra/observability/archive_sanitize.py infra/observability/collect.py \
  /usr/local/lib/automabaca-novo/observability/
sudo cp /etc/caddy/sites-enabled/automabaca.caddy /etc/caddy/sites-enabled/automabaca.caddy.bak-$(date -u +%Y%m%d)
sudo install -o root -g root -m 644 infra/observability/automabaca.caddy /etc/caddy/sites-enabled/automabaca.caddy
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
# Conferir: rotas moldadas, nada de "{http.request.uri.path}".
sudo journalctl -u caddy --since '-5 min' -o cat | grep automabaca_v2 | jq -r .route | sort | uniq -c
```

Se o `validate` falhar, devolva o `.bak` antes de qualquer reload (o
`Caddyfile` importa só `sites-enabled/*.caddy`, então o `.bak-*` fica inerte).

No exercício de restauração, baixar uma cópia externa já exportada, conferir
SHA-256 contra `index.json`, descriptografar com a chave privada no local
autorizado, listar o tar, verificar o manifesto e abrir um JSONL gzip. Conferir
o intervalo esperado e localizar uma correlação conhecida. Usar diretório
temporário restrito, sem extrair sobre a aplicação. Registrar data, pacote,
hash, intervalo e resultado, nunca a chave privada nem logs brutos.

O teste Python faz coleta → exportação criptografada → restauração com chave
sintética. Isso verifica o software, não substitui o exercício da cópia real.

## Incidentes 24h (runbook rápido)

Consultas no host (web+worker). Trocar `--since` conforme a janela. Saída JSON;
não colar prompts, tokens nem PII em tickets.

### FlashScore / circuit breaker

```bash
# Trips e transições do breaker (FlashScore e demais providers)
sudo journalctl CONTAINER_NAME=automabaca-novo-web CONTAINER_NAME=automabaca-novo-worker \
  --since '2 hours ago' --no-pager -o cat |
  jq -R 'fromjson? | select(.eventCode == "PROVIDER_CIRCUIT_TRIPPED"
    or .eventCode == "PROVIDER_CIRCUIT_HALF_OPEN"
    or .eventCode == "PROVIDER_CIRCUIT_CLOSED")
    | {time,mod,eventCode,name,reason,failures,cooldownMs,correlationId,jobId,betId,msg}'

# Só FlashScore
sudo journalctl CONTAINER_NAME=automabaca-novo-worker --since '6 hours ago' --no-pager -o cat |
  jq -R 'fromjson? | select(.name == "flashscore" and (.eventCode | tostring | startswith("PROVIDER_CIRCUIT")))
    | {time,eventCode,reason,failures,correlationId,jobId}'
```

Owner do trip/half-open/close estruturado: **Ops** (`src/infra/circuit-breaker.ts`).
Warns de settlement (`flashscore-candidate` / batch adjacent-day) são **Settlement** —
fora deste quick-win; cruzar `correlationId`/`jobId` do trip com esses mods.

Semântica da série `<provider>.breaker` (desde 21/09/2026): **uma amostra por
ABERTURA do circuito** (`outcome: error`, `labels.reason` =
`consecutive_failures` | `rate_limited` | `anti_bot_challenge` | `forced_trip`).
A chamada recusada durante o cooldown **não grava amostra**: antes disso, cada
recusa virava uma linha e o fan-out (settle por grupo, enrich por aposta e por
esporte, sweep e rechecagem por alvo) produzia milhares de "erros" para poucos
timeouts reais — medido em 18–19/09/2026, 6.339 linhas contra 290 timeouts. Por
isso a série é classificada **antes** do piso de amostras do provider: um trip
isolado já é violação; zero trip é saudável. No card, ela aparece como
"Aberturas", não como "Sucesso".

Quem chama **adia** com o circuito aberto, em vez de martelar o gate: o client do
FlashScore recusa antes do `withBreaker` e os trabalhos periódicos checam uma vez
no topo (`src/providers/flashscore/breaker-gate.ts`) e voltam — a marca do log é
`PROVIDER_CIRCUIT_BLOCKED` com `scope` (`settlement`, `recheck`, `enrich`). Nada
é perdido: o ciclo seguinte repesca, e `sharp.revive` (5 min) refaz o vínculo de
identidade.

Lápides de modelo retirado (linha `OPEN` que ninguém mais consulta) se fecham
com o script versionado, em simulação e depois valendo:

```bash
docker exec -i automabaca-novo-worker node dist/ops-limpar-circuitos.mjs \
  --executor agent:<nome>:por:fabricio [--aplicar]
```

### Fila que saiu do código

O pg-boss não apaga fila sozinho: a que o código deixou de registrar continua em
`pgboss.queue`, e o painel segue listando a dead-letter dela. O replay dessa
dead-letter é recusado (nada consome a origem). Depois que a release sem a fila
estiver no ar, apague-a com o script versionado, em simulação e depois valendo:

```bash
docker exec -i automabaca-novo-worker node dist/ops-apagar-filas-aposentadas.mjs \
  --fila <fila> [--fila <outra>] --motivo "<por que as falhas guardadas podem ir junto>" \
  --executor agent:<nome>:por:fabricio [--aplicar]
```

Ele recusa fila do contrato, fila com job por rodar e fila que recebeu job nas
últimas 24 h, e apaga tudo ou nada: origem, dead-letter e jobs, fechando as
ações abertas sobre eles. A simulação lista as falhas que iriam junto: mostre ao
dono antes de aplicar.

### Tempestade LLM (`LLM_PROVIDER_EXHAUSTED`)

```bash
sudo journalctl CONTAINER_NAME=automabaca-novo-worker --since '2 hours ago' --no-pager -o cat |
  jq -R 'fromjson? | select(.eventCode == "LLM_PROVIDER_EXHAUSTED"
    or .eventCode == "LLM_CASCADE_COMPLETED")
    | {time,eventCode,mod,provider,llmCallId,correlationId,betId,msg}'
```

Tentativa esgotada ≠ cascata falha: só alarme se houver volume alto de exhausted
**sem** `LLM_CASCADE_COMPLETED` de sucesso na mesma correlação. Owner: **Captura**.

### Backup diário

```bash
# Últimas execuções do timer e o log do serviço
systemctl list-timers automabaca-novo-backup.timer
sudo journalctl -u automabaca-novo-backup.service --since '36 hours ago' --no-pager | tail -80
# Status estruturado do último run
sudo ls -lt /var/lib/automabaca-novo/backup-status/ | head
# Pacote que o PC do dono baixa
cat /srv/apps/automabaca-novo/exports/latest.json
```

Falhas trazem `error`/`detail` no JSON (correção do PR #63).

O vigia do arquivo de logs também julga o backup e grava o veredito no bloco
`backup` do próprio `status.json` (`state` `fresh`, `failed` ou `stale`, o
`createdAt` do último pacote conferido e as apostas da cópia restaurada). As
razões são `backup_failed` (a última execução falhou: só caixa de ações) e
`backup_stale` (26 h sem pacote conferido: caixa de ações e Telegram). A rota
pública `/api/health/observability` leva só a razão, nunca o bloco.

A cópia do pacote no PC do dono tem razão própria, `backup_offsite_stale`
(caixa de ações e Telegram): a tarefa do Windows devolve um comprovante depois
de conferir o SHA-256, e a razão abre quando ele falta, é inválido ou chegou há
mais de 36 h. O bloco `backup` leva `offsite` (`fresh` ou `stale`) e
`offsiteAt`, a hora em que o último comprovante válido chegou.

```bash
sudo ls -l /var/lib/automabaca-novo/observability-receipts/
sudo cat /var/lib/automabaca-novo/observability-receipts/windows-backup-receipt.json
```

No PC, o `last-attempt.json` da pasta dos backups diz o que a última execução
fez (`deploy/README.md`, "Cópias fora da VPS").

### Vigia de fora

Os avisos dos processos dependem da VPS. Para a VPS que cai inteira
(host, rede, Caddy, banco), o PC do dono roda `scripts/vigia-externo.sh` pelo
cron, a cada minuto: lê o `/api/health` público e, na terceira falha seguida
(sem resposta em 10 s, HTTP fora de 200, corpo vazio ou que não contém um único
objeto JSON, `ok`, `db` ou `worker` falso/ausente, heartbeat que não é `fresh`),
manda um aviso pelo bot de notificações dizendo o que falhou.
Enquanto durar, repete no máximo a cada 30 min; na volta, avisa uma vez, com a
duração. PC sem rede (um destino neutro também não responde) não conta, e
minutos com o PC desligado não são falhas seguidas. Com o PC desligado não há
vigia de fora.

```bash
tail -n 20 ~/.local/state/automabaca/vigia-externo.log   # uma linha por mudança
cat ~/.local/state/automabaca/vigia-externo.estado
```

O token e o chat do aviso ficam só no PC, em
`~/.config/automabaca/notificar.env` (modo 600; arquivo mais aberto é
recusado), com `TELEGRAM_NOTIFY_BOT_TOKEN` e `TELEGRAM_NOTIFY_CHAT_ID`: os
valores de `TELEGRAM_NOTIFICATION_BOT_TOKEN` e `TELEGRAM_NOTIFICATION_CHAT_ID`
da produção, nunca o `TELEGRAM_TOKEN` (o bot que lê os canais). Sem o arquivo,
o vigia e o publicador registram no log e seguem sem avisar. Instalar ou
atualizar: `bash scripts/vigia-externo-instalar.sh`.

### Health / observabilidade

```bash
curl -sS http://127.0.0.1:3101/api/health | jq .
curl -sS http://127.0.0.1:3101/api/health/observability | jq .
sudo cat /var/lib/automabaca-novo/observability/status.json | jq .
systemctl list-timers 'automabaca-log-*'
```

`ok=true` com collection/export/offsite `fresh` = arquivo saudável. Evidência
de backup ou cópia com data mais de um minuto no futuro não comprova frescor.
Lacuna de
cursor exige `acknowledge-gap.py` com timestamp e justificativa — não “ack” cego.

### Worker parado ou banco fora

O `restart: unless-stopped` do compose só reinicia processo que saiu: um
worker travado de pé fica `unhealthy` sem ninguém mexer, a web também (o
healthcheck dela é o `/api/health`), e o `publish.py` recusa publicar até a
produção ficar saudável. Duas camadas cobrem isso sem o dono:

- **O worker se reinicia sozinho** (`src/jobs/worker-self-watch.ts`). De minuto
  em minuto, numa conexão própria de timeout curto (fora do pool do Prisma), ele
  procura o último heartbeat concluído com a prova *deste* processo. Com 20 min
  sem prova (desde o boot, se nunca provou), grava `worker.self_restart` em
  `audit_events` e sai com 1 pelo shutdown normal (drenagem, lock, conexões), e o
  Docker sobe outro. Banco que não responde não conta: reiniciar não o traz. No
  máximo 3 reinícios em 3 h; esgotado o teto, não reinicia e abre a ação
  "Autocura do worker esgotada". Na primeira prova de vida, o processo novo
  avisa a volta uma vez (recibo `worker.self_restart_announced`). A sonda
  mantém uma única volta em andamento até terminar os efeitos e só marca
  o aviso como concluído depois da entrega confirmada e da gravação; recusa do
  Telegram ou falha de persistência volta a tentar no minuto seguinte,
  inclusive para a autocura esgotada.
- **A web avisa a queda** (`src/services/ops/production-outage-watch.ts`). Cada
  sonda do `/api/health` (o healthcheck do Docker chama a cada 20 s) alimenta um
  acompanhamento em memória: 20 min seguidos fora viram um aviso pelo bot de
  notificação, que a web já recebe, com a causa (banco fora, processo do worker
  fora ou worker travado). Com o banco fora, a caixa de ações não grava e o
  Telegram sai assim mesmo. A volta avisa quanto durou e fecha a ação; a web
  que sobe no meio da queda fecha a ação na primeira sonda boa. Falhas no envio
  ou no fechamento ficam pendentes e são retentadas pelas sondas após um minuto.
  Os efeitos são serializados: a volta espera o alerta em andamento gravar
  antes de fechar a ação, sem atrasar a resposta do health. Queda curta
  (troca de release, migration) não avisa.

Avisos de condições persistentes usam um recibo por ciclo da ação
(`ops.alert_once_delivered`): a ação aberta sozinha não comprova entrega. Uma
recusa deixa o aviso pendente, e uma reabertura recebe seu próprio aviso. O
recibo do ciclo ativo sobrevive à purga; ciclos encerrados seguem os 30 dias
da auditoria comum.

A VPS inteira fora depende do vigia de fora, que só roda com o PC ligado e
com rede. O worker com o event loop travado não roda a própria vigia: a web
avisa, mas ninguém o reinicia automaticamente.

```bash
sudo journalctl CONTAINER_NAME=automabaca-novo-worker CONTAINER_NAME=automabaca-novo-web --since '6 hours ago' --no-pager -o cat |
  jq -R 'fromjson? | select(.eventCode | tostring | test("WORKER_SELF_RESTART|HEALTH_OUTAGE")) | {time,eventCode,msg,staleSince,lastProofAt,cause}'
```

### SLO breach → amostras

Logs `SLO_BREACH_*` incluem `sampleCorrelationIds` (até 5). Investigar:

```bash
CID='job_EXEMPLO'
sudo journalctl CONTAINER_NAME=automabaca-novo-web CONTAINER_NAME=automabaca-novo-worker \
  --since '2 hours ago' --no-pager -o cat |
  jq -R --arg c "$CID" 'fromjson? | select(.correlationId == $c)
    | {time,level,mod,eventCode,betId,msg}'
```

Painel: `/operacoes`. Fora de escopo deste quick-win: decision logs settle/capture,
Sentry e OTel.

## Verificação de mudanças

`npm run check:ci` roda tipos, lint e unitários; testes DB exigem
`TEST_DATABASE_URL` apontando para um banco descartável. Arquivamento de logs:
`python3 -m unittest discover -s infra/observability -p test_archive.py`.
