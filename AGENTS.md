# Trabalho no AutomaBACA

Projeto de uso exclusivo do dono, desenvolvido com Claude e GPT. Responda em
português. O índice do resto da documentação está no começo do
[README.md](README.md); a arquitetura e os invariantes, no
[BLUEPRINT.md](BLUEPRINT.md).

## Onde trabalhar

O desenvolvimento é **no PC do dono, dentro do WSL2** (distro `Ubuntu-24.04`,
usuário `fabricio`), em `~/code/automabaca-novo`. Pelo Windows, o mesmo
diretório é `\\wsl.localhost\Ubuntu-24.04\home\fabricio\code\automabaca-novo`;
não use cópia em `/mnt/c` nem em pasta do Windows.

A VPS `hermes` é **só produção**: não desenvolva, não rode testes e não crie
worktree lá. `/srv/apps/automabaca-novo/source/` é a referência do deploy e do
backup diário; só o `deploy/publicar.sh` mexe nela.

Se a bancada estiver ocupada por outra sessão (árvore suja ou branch que não é
seu), trabalhe numa worktree, criada e removida pelo script:

```
cd ~/code/automabaca-novo
bash scripts/worktree.sh nova <tarefa> <tipo>/<assunto>   # ../wt-<tarefa>, a partir da origin/main
bash scripts/worktree.sh remover <tarefa>                  # depois do merge
bash scripts/worktree.sh podar                             # bancos de worktree que já não existe
```

O `nova` liga o `node_modules` da árvore principal, copia o `.env` e gera o
client do Prisma e a ponte Rust (`npm run build:ponte`, que compila
`rust/` para N-API e WebAssembly dentro de `rust/crates/ponte`). O banco de teste da worktree é o servidor compartilhado da
5433 (o `db-test` do compose), com bancos só dela (`automabaca_test_<tarefa>`,
`_template`, `_1`…`_N`): suítes de worktrees diferentes rodam juntas sem
esperar uma pela outra. Não suba container de PostgreSQL por worktree.
Todo banco `automabaca_test*` do servidor do `TEST_DATABASE_URL` é descartável.
Build e navegador (Turbopack) recusam o `node_modules` em link: antes deles,
`bash scripts/worktree.sh build <tarefa>` (ou `nova … --build`) o troca por uma
cópia com hardlinks.

O `remover` recusa enquanto houver arquivo sem commit ou commit fora do GitHub,
e mostra quais: trabalho de outra sessão vai para um commit numa branch,
enviada ao GitHub, antes de remover. Depois apaga os bancos da worktree, a
worktree e a branch local que já entrou na main.

Não use `git stash`: a pilha é do repositório e aparece em todas as worktrees, e
um agente já aplicou o stash de outro. Para comparar com o código antigo, use
`git show HEAD:<arquivo>`.

Bancos locais: `docker compose -f docker-compose.dev.yml up -d` (dev na 5432,
testes na 5433). O `.env` de dev tem só valores locais. **Nunca coloque token de
produção nele**: o bot do Telegram com o mesmo token disputaria as mensagens com
a produção.

### Terminal do Windows

Ferramenta rodando no Windows (Claude desktop, Codex) lê e edita os arquivos
pelo caminho `\\wsl.localhost\...`, mas **todo comando do projeto vai para o
Linux**, nesta forma:

```
wsl.exe -d Ubuntu-24.04 -e bash -lc 'cd ~/code/automabaca-novo && <comando>'
```

Isso vale para git, npm, npx, node, docker, gh, ssh e scripts `.sh`. Nunca rode
`npm`, `node` ou `git` do Windows nesta pasta (binários e fins de linha errados).
Mantenha o caminho dentro das aspas simples: o Git Bash reescreve argumentos que
começam com `/`. Confira uma vez por sessão que `node -v` responde `v24.20.0`.

## Do código à produção

A `main` é protegida: só entra por PR com a CI verde. O merge é *squash*, feito
pelo agente que abriu o PR depois da revisão: `gh pr merge <n> --squash --auto`
entra sozinho quando a CI ficar verde. Sem `--delete-branch`: a GitHub já apaga a
branch remota, e o `gh` apagaria junto a worktree local da branch.

Durante o trabalho e antes do PR, `npm run check:fast` roda só o que a mudança
afeta, inclusive os `.db.test` ligados a ela. A suíte inteira roda uma vez, na CI
do PR: localmente, `npm run check:ci` e `npm run test:db` só para investigar uma
falha da CI. A suíte de banco precisa do `.env` com `TEST_DATABASE_URL` na
worktree (`git clean -xfd` o apaga; copie de outra worktree).

**A máquina de desenvolvimento é uma só.** Agentes dividem o WSL, e o WSL
divide a RAM com o Windows: suítes demais ao mesmo tempo travaram o PC duas
vezes em 23/09. Os scripts pesados (`check*`, `test*`, `typecheck`, `build`) passam por
`scripts/vez.sh`, que espera vaga e memória livre. Rode suíte e build pelos
scripts do npm, não por `npx vitest run`/`npx tsc` direto; um arquivo de teste
avulso pode rodar direto.

A CI roda nos runners hospedados do GitHub (`ubuntu-24.04`, uma máquina nova
por job). O repositório é privado: cada minuto de cada job sai da cota mensal
do plano (2.000 no Free), e o excedente é cobrado. Por isso poucos jobs, e
grandes: um PR são dois em paralelo, `verificações` (estáticas, unitários e
PostgreSQL) e `build e navegador`, e depois `release verificada`; a `main`
reaproveita as verificações do PR quando a árvore é a mesma. Os jobs trocam
registros e o runtime do build por artefato (`ci-*`) e guardam node_modules,
tsc e Next no cache do Actions; cada job com banco sobe o próprio PostgreSQL
em RAM. Não crie workflow agendado nem job novo sem pesar os minutos.

**PR do Dependabot não roda a CI sozinho**: ela instalaria e executaria
dependência que ninguém leu, e o que entra na `main` vai sozinho para a
produção (sem contar os minutos gastos em cada bump). Leia o diff do lockfile e as
notas de versão de cada pacote; só então ponha o rótulo
(`gh pr edit <n> --add-label dependencias-revisadas`), e é esse evento que
roda a CI. Push novo do Dependabot (rebase) não herda a revisão: leia de novo,
tire o rótulo e ponha outra vez. Sem isso a `release verificada` fica
vermelha e o PR não entra.

PR com a CI verde entra direto, sem esperar a vez: a `main` não exige o PR
atualizado. Se o PR testou exatamente a árvore que entrou, a main só faz build,
release e imagens; se a main andou no meio, ela roda todas as verificações de
novo, e o publicador só leva à produção um commit da main com a CI verde. Main
vermelha depois de um merge (dois PRs verdes que quebram juntos) se corrige na
hora, com PR de conserto ou revert. Conflito de texto com a main continua sendo
resolvido no PR (rebase).

### Publicação

**A publicação é automática.** Na VPS, o crontab do `deploy` roda
`scripts/publicador-automatico.sh` a cada minuto: ele chama o `publicar.sh`
abaixo para o commit mais novo da `main` com a CI verde (com as imagens), mesmo
que a CI do topo ainda esteja rodando; a CI da `main` não cancela a execução em
andamento, então os merges seguidos não seguram a produção.
Merge que só toca documentação (`*.md`, `docs/`) não é publicado: o próximo
deploy de código leva junto. O que foi feito com cada commit fica em
`~/.local/state/automabaca/publicador.log` do `deploy` na VPS; depois do merge, confira que o
commit no ar (`/api/health`) contém o seu (`git merge-base --is-ancestor <seu>
<no ar>`) e relate o que saiu: o commit do merge pode sair junto com um mais
novo, sem linha própria no log. Instalar ou atualizar, na VPS como `deploy`:
`bash /srv/apps/automabaca-novo/source/scripts/publicador-automatico-instalar.sh`.

Commit que o publicador marca "recusado" ou "FALHOU" vira um aviso no Telegram
do dono, uma vez, pelo bot de notificações, com o token em
`~/.config/automabaca/notificar.env` do usuário que roda o cron, fora do
repositório e do `.env`. O `scripts/vigia-externo.sh` lê o `/api/health` de
FORA da VPS a cada minuto e avisa quando a produção cai e quando volta
([docs/OBSERVABILIDADE.md](docs/OBSERVABILIDADE.md), "Vigia de fora"); ele
precisa de uma máquina que não seja a VPS, com o mesmo arquivo de aviso.

O publicador passa `--com-migration`: a migration que o `deploy/migrar.py`
aprova (aditiva) sai sozinha, com o backup conferido antes. Release que uma
guarda recusou fica marcada como recusada e sai à mão, com o mesmo comando:

```
ssh hermes 'bash /srv/apps/automabaca-novo/source/deploy/publicar.sh --nome <assunto> --preflight'
ssh hermes 'bash /srv/apps/automabaca-novo/source/deploy/publicar.sh --nome <assunto> --commit <sha>'
```

- Saída 2 é uma guarda recusando (CI vermelha, deriva, migration): **não
  contorne**, leve ao dono. Saída 4 é causa passageira (produção não saudável
  antes de publicar, rede no download ou no pull): nada foi trocado, e o
  publicador tenta de novo sozinho. Outra falha na publicação: pare e relate.
- PR com migration: depois do merge, confira no `publicador.log` o plano que saiu
  e ponha o SQL no relato. As que o `migrar.py` recusa (apagar, renomear,
  reescrever dados) saem em duas releases e só com o sim do dono para aquele SQL,
  por `--migration-manual <nome>` ([docs/RELEASE.md](docs/RELEASE.md)).
- Mudou `deploy/backup-diario.py` ou `deploy/restore-check.sql`? O deploy não os
  atualiza: reinstale como diz `deploy/README.md`.
- Mudou `scripts/publicador-automatico.sh`? O cron
  roda cópias: rode de novo `bash scripts/publicador-automatico-instalar.sh`.
  Para `scripts/vigia-externo.sh`, `bash scripts/vigia-externo-instalar.sh`;
  mudou `scripts/lib/notificar-telegram.sh`, rode os dois.
- Mudou `infra/observability/` (o `watchdog.py`, por exemplo)? O deploy não
  atualiza o host: `sudo bash infra/observability/install-host.sh` na VPS. Razão
  nova no `watchdog.py` só depois de publicada a release que a conhece: antes
  disso a aplicação lê o estado inteiro como indisponível.
- O backup conferido antes da troca só roda em release com migration; para uma
  release de código arriscada para os dados, publique à mão com `--com-backup`.
- Não improvise os passos à mão nem copie o script de uma release anterior.

## Escritas no banco de produção

Vale para qualquer agente ou script, inclusive quando o dono pediu a tarefa.

- Antes de qualquer escrita, mostre ao dono o pedido, o escopo e o que vai
  mudar; depois, confira o efeito no banco e relate.
- **Exceção, o funcionário de IA** (decisão do dono de 25/09/2026): o agente
  do dono ligado ao servidor MCP (`scripts/mcp-funcionario.ts`, que chama o
  `dist/ops-funcionario.mjs` do worker) vincula, adia caso, confirma esporte e
  liquida sem pedir antes, com evidência em cada escrita e dentro do teto do
  dono (50 em 24 h, 10 por minuto, somando os agentes dele). Só por essas
  ferramentas: fora do MCP
  não há teto nem trilha, e vale a regra acima
  ([docs/FUNCIONARIO-IA.md](docs/FUNCIONARIO-IA.md)).
- **Liquidar apostas a pedido do dono:** `dist/ops-settle.mjs` dentro do worker.
  `plan` não grava e mostra o lucro previsto; `apply <planHash>` aplica só aquele
  plano, com recibo. Cada item exige evidência (o que foi conferido e onde). Não
  liquide chamando serviços direto, e não reverta nem reliquide: isso é do dono,
  pelo painel.
- Toda escrita de agente usa o ator `agent:<nome>:por:<dono>` (aparece em
  `/operacoes`, no resumo `consistency.escritas-fora-do-fluxo`; as decisões
  com evidência do funcionário de IA, dentro do teto, são rotina e não abrem
  item: ficam na trilha e no `resumo_do_dia`). Nunca grave com
  a identidade do dono fora do `ops-settle`, nem invente atores genéricos.
- Só roda em produção código que está na release publicada. Correção de dados
  vira script versionado, com teste, simulação por padrão e aplicação explícita
  (modelo: `scripts/ops-limpar-circuitos.ts`).
- Não grave nome de time à mão (ficha, nome de tipster, SQL ou script): o nome
  só se aprende pela identidade automática e pelo Vincular (o do painel ou o
  do funcionário de IA, um caso por vez; decisões de produto abaixo). Se
  achar nomes errados, leve a lista ao dono, e ele decide o que fazer com eles.

## Decisões de produto

Escolhas já feitas. Registre riscos novos que surgirem, mas não as trate como
defeito nem proponha desfazê-las sem o dono pedir.

- **Não existe EV de entrada** (removido em 22/09/2026). Os tipsters postam antes
  de a Pinnacle listar a linha, então o preço no instante da tip quase nunca
  existia. O produto mede identidade, CLV contra o fechamento e o movimento da
  linha (abertura → fechamento). `sharpMode` é `CLV_ONLY`, `IDENTITY_ONLY` ou
  `OFF`.
- **Não há stake de Kelly nas apostas** (24/09/2026): nem na aposta, no aviso 📥
  do Telegram ou no simulador do Analyzer. O dono segue a gestão do tipster, e
  a stake gravada é a do post ou da banca. A calculadora de Kelly de
  Ferramentas continua, como ferramenta manual.
- **Identidade só com candidato real** (24/09/2026). Não há IA que renomeie o
  evento da aposta: a IA de identidade (Gemini com busca na web) saiu porque não
  tinha o catálogo da Pinnacle e adivinhava nome e competição. O evento casa pelo
  enrich (Pinnacle17 → BridgeOdds), e o juiz de LLM só escolhe entre candidatos
  que os providers devolveram; sem candidato, o caso fica em Operações ›
  Vincular para o dono.
- **Nome de time só se aprende com prova** (24/09/2026; fichas em 25/09/2026).
  A prova é a ficha do time (`team_cards`): o pareamento dos catálogos liga o
  jogo da Pinnacle17 ao do FlashScore e grava o id do time com os nomes da
  Pinnacle. O nome que o tipster usou entra na ficha quando a identidade
  automática casa a aposta com um jogo ligado (`ok` e 1:1, com o lado bem
  casado nele), como pendente, ou pelo Vincular, já confirmado (a decisão "O
  Vincular ensina", abaixo). O pendente vira confirmado quando volta, na mesma ficha,
  noutro jogo, noutra aposta e noutro dia de São Paulo, e só se nenhuma outra
  ficha do mesmo esporte, país e categoria tem o mesmo nome (uma ficha por
  nome confirmado). A tradução do nome da aposta lê só as fichas (nome de
  tipster confirmado, nome da Pinnacle em 2 jogos, nome do FlashScore), com a
  regra de nome genérico em todas, e é pista: nome com mais de uma ficha não
  traduz. O juiz de IA automático decide só aquela aposta: grava nela o jogo,
  com os nomes, o país e o campeonato da Pinnacle, mas não ensina nome. O 👎
  também não ensina nem desensina nome de time.
- **O Vincular ensina** (25/09/2026), feito pelo dono no painel ou pelo agente
  dele (um caso por vez, escolhendo só entre os candidatos que os fornecedores
  devolveram): a escolha vale como a do dono. Além de gravar o jogo na aposta,
  os nomes do tipster daquela aposta entram JÁ CONFIRMADOS nas fichas dos
  times do jogo escolhido (`team_tipster_names`, `decidedBy` = quem vinculou:
  o usuário do painel ou o `agent:<nome>:por:<dono>`), pelas travas de nome do
  aprendizado automático (nome genérico, categoria, parecer mais com o
  adversário). A ficha é a do lado bem casado naquele jogo, pela ligação;
  sem ligação, só a única ficha com o nome da Pinnacle já vista na mesma liga. O nome confirmado de outra ficha no mesmo esporte, país e
  categoria não é tomado: o conflito fica auditado e volta no resultado.
  Continua sem ensinar o juiz de IA automático do sistema. Nome errado se
  remove na tela Times (×).
- **O agente do dono liquida** (25/09/2026): homologa as sugestões do IA-Judge
  (qualquer mercado: parte do jogo, estatística, props, múltipla) e liquida
  pendentes sem sugestão quando prova o resultado, sempre por plano →
  aplicação (o do `ops-settle`) e com a evidência de cada item (o que viu e
  onde). A sugestão aberta com o mesmo resultado é homologada como no painel
  (fica aprovada, com o agente); o resto vai com recibo, e sem sugestão só
  com o jogo começado há 3 h. Múltipla de mais de um jogo só pela sugestão
  aberta do mesmo resultado: as pernas não têm horário. Continua só do dono: desfazer ou reliquidar,
  apagar/restaurar aposta, mexer em odd, stake, conta e configuração. O
  funcionário de IA (servidor MCP no PC do dono,
  [docs/FUNCIONARIO-IA.md](docs/FUNCIONARIO-IA.md)) tem teto de escritas por
  dono, somando todos os agentes dele: 50 em 24 h e 10 por minuto.
- **Na aposta, os nomes são os da Pinnacle** (evento, país e campeonato): a
  Pinnacle não muda nomes, e o FlashScore põe patrocinador no campeonato
  ("Serie A Betano") e muda todo ano. Do FlashScore vale só o id; a categoria
  (reserva, feminino) aparece pelo campeonato, sem enfeitar o nome.
- **Liquidação automática:** são dois caminhos, com regras diferentes.
  O **FlashScore** liquida sozinho o que o feed dele prova, com o jogo
  encerrado: o placar do jogo inteiro; o do 1º e do 2º tempo, quando o feed
  traz os parciais e eles fecham com o total (no basquete, só total e handicap
  do 1º tempo, em aposta simples pré-jogo); a estatística de time (escanteios,
  cartões, chutes e as outras do bloco da partida, do jogo ou do tempo); o
  artilheiro (a qualquer momento, por tempo, primeiro ou último), com o nome
  casado sem ambiguidade; a múltipla, quando o placar decide o bilhete e
  nenhuma perna sai anulada ou pela metade; e a prop de jogador sem termos
  gravados (futebol, jogo inteiro, um só jogador com aquele nome, estatística
  publicada e participação provada). Em mercado de placar, entrada ao vivo com
  placar diferente de 0-0 só liquida no handicap; quarto, período, set, mapa,
  inning e janela de minutos, nunca.
  A **prop de jogador com termos gravados** (`bet_player_props`, que o
  registro grava para toda prop fora de múltipla) só liquida sozinha com a
  evidência estável por 10 min (regra da casa comprovada, entrada antes do
  jogo, jogador identificado) e com a chave do tipster ligada em Config ›
  Jogadores ("Liquidar automaticamente os casos comprovados"). A chave nasce
  desligada e só liga depois de 20 apostas conferidas em 3 competições, sem
  divergência pendente. Desligada, a prop comprovada fica para o dono em
  Config › Jogadores ("Conferir resultado da casa"); a revisão de 24 h só
  confere, e o IA-Judge não olha aposta com termos gravados.
  O **IA-Judge** liquida sozinho (confiança ≥ 0,95 e fonte confiável) só o
  que o placar final do jogo inteiro responde (vencedor, total, handicap,
  ambas marcam, dupla chance, empate anula e total do time), inclusive com
  prorrogação quando o mercado a declara (24/09/2026), e só quando a conta do
  motor com o placar citado dá o mesmo resultado que o modelo. Nele, aposta
  pega ao vivo, parte do jogo (tempo, quarto, período, set, mapa, inning,
  janela de minutos), estatística (escanteios, cartões, chutes, props,
  artilheiro) e múltipla viram sempre sugestão para o dono (ou o agente dele,
  abaixo) homologar, qualquer que seja a confiança.
  A resolução automática de esporte confirma a partir de 90,
  sem outro esporte a partir de 70, sem modo shadow; esportes com status
  inferido (handebol, futsal, futebol de praia, hóquei de grama, rugby)
  liquidam pelo placar listado, mesmo com risco de prorrogação em mata-mata,
  porque o Flashscore não informa prorrogação.
- **Navegadores mínimos** (17/11/2026): Chrome e Edge 97, Firefox 102, Safari
  e iOS 16.4, no `browserslist` do `package.json`. São os primeiros com
  `'wasm-unsafe-eval'` na CSP (a ponte WebAssembly) e, no Safari, com
  lookbehind em regex, que o domínio usa. O build recusa JavaScript de
  navegador além de ES2022 (`scripts/verify-standalone.mjs`).
- **Painel só com senha**, sem segundo fator (sessão de até 30 dias, bloqueio de
  tentativas, aviso de dispositivo novo).
- **Migrations antigas ficam.** O repositório nasceu em 09/09/2026 importando o
  AutomaBACA antigo; as migrations dele são o histórico que o banco de produção
  registra, e apagá-las quebra o `prisma migrate`.
- **👍 no post é "peguei"; em post que não virou aposta, pede a captura**
  (24/09/2026). O 👍 do dono (reação anônima do canal ou identificada) em post
  com aposta marca como pegas as apostas não removidas do post (o lote
  inteiro), com a hora da reação, que a ficha e a trilha da aposta mostram.
  Tirar o 👍 desmarca. A marca não muda stake, odd, lucro, conta nem
  liquidação, e não avisa no Telegram. O 👎 vence o 👍: pô-lo, junto ou no
  lugar do 👍, remove a aposta e tira a marca; tirar o 👎 com o 👍 no post
  restaura a aposta já pega. O 👍 que chega antes da aposta fica guardado,
  como o 👎, e a aposta nasce pega, inclusive a que o próprio 👍 pediu. Em
  post sem aposta o 👍 pede a captura de post descartado ou recusado, exceto
  recapitulação e jogo encerrado. Post que nem foi lido (filtro, canal
  pausado) vai à captura uma vez, ainda sujeito à regra de jogo encerrado;
  rascunho sem stake ou odd também, e a captura pergunta o número na DM;
  recusa que o dono conserta vira a pergunta na DM; post que a IA já leu sem
  ver aposta não é relido. Só o "Capturar mesmo assim" do painel pula todas
  as regras.
- **Não há tela de Entradas** (24/09/2026): as apostas pendentes ficam em
  Tipsters, na página de cada tipster. O endereço antigo `/entradas` leva a
  `/tipsters`.
- **Conserto pela DM passa dos 30 min.** Quando a captura recusa por um dado
  que o dono sabe (unidade do total, lado do handicap, odd, stake), o bot
  principal pergunta na DM do dono. A resposta grava pelo mesmo guard e
  registro, só antes do jogo (sem kickoff confiável, até a janela de um jogo
  desde o post ou o fim daquele dia), mesmo depois dos 30 min do rascunho.
  Na entrada ao vivo (o próprio post, não uma edição, saiu depois do kickoff
  lido), o dado que era do post (placar da entrada, unidade, lado) vale até o
  fim da janela do jogo; odd e stake, não.
  A entrada é a do post quando o dado estava nele (unidade, lado) e a da
  correção quando faltava (odd, stake).
- **Esportes e pausa do canal são do dono.** Em Config › Tipsters ele marca os
  esportes do canal ("vários/não sei" é o padrão, e a banca criada sozinha
  nasce assim) e pode pausar a captura: post novo de canal pausado vai para os
  descartados sem leitura nem LLM. Pausar é o caminho para parar um canal sem
  apagar o histórico de CLV, que a exclusão da banca apaga.
- **A operação é para valer.** O ensaio foi zerado em 23/09/2026: toda aposta
  no banco foi gravada pela versão atual do motor, e o código não tem caminho
  para dado de versões antigas. As origens das apostas apagadas ficam em
  `retired_bet_sources`, para que editar um post antigo não recrie a aposta.
- **O resultado escrito pelo tipster não liquida** (23/09/2026). GREEN, RED,
  VOID, ✅ ou a lista de resultados na legenda não mudam nada; a liquidação é do
  Flashscore, do IA-Judge e do painel/`ops-settle`.
- **O que foi capturado vale.** O dono pega a aposta na hora do post: edição
  de post que já virou aposta é ignorada (odd, stake, seleção, resultado). O
  rascunho que ainda não virou aposta se completa só se a edição chegar até 30
  min depois do post e antes do kickoff lido, e a entrada passa a ser a edição.
- **Todo 👎 no canal é do dono** (o primeiro id pessoal de
  `TELEGRAM_ALLOWED_CHATS`). Só ele e os bots estão nos canais, e a reação chega
  anônima: 👎 remove (o lote inteiro do post) com estorno, tirar o 👎 restaura.
  O 👎 que chega antes da aposta fica guardado e vale no registro. Exceção: em
  aposta liquidada há mais de 7 dias o 👎 não remove; vira revisão no painel.
  A reação só age quando o 👎 ou o 👍 entra ou sai (outro emoji não mexe), e
  tirar o 👎 só restaura o que o 👎 removeu: o que o painel removeu (em lote ou
  pela ficha) só o painel restaura, na aba Removidas da banca ou na ficha.
- **O deploy não espera jogo** (23/09/2026). A publicação troca o worker mesmo
  com jogo começando: um jogo que comece no minuto da troca pode perder as
  cotações de fechamento dos últimos segundos, e o CLV dele fica menos confiável.
- **Canal novo ganha banca sozinho** no primeiro post, se o dono (um usuário de
  `TELEGRAM_ALLOWED_CHATS`) é dono ou admin do canal e não tirou esse canal de
  uma banca antes. Configuração padrão: stake só a do post, CLV, unidade 100.
  Canal que o dono não administra fica só com o registro do canal (sem o texto
  do post), e a conferência no Telegram se repete a cada 6 h.

## Como trabalhar

- O código atual, os testes e o que o dono diz são a fonte da verdade.
  Comentário antigo e relato de outra IA são pistas a conferir. Número de log ou
  métrica também: confirme que ele reflete uma falha real antes de tratá-lo como
  achado.
- Antes de editar, veja o `git status --short` e preserve alterações que já
  estavam lá.
- Mudança grande de comportamento: mostre o plano antes de mexer; aprovado,
  execute até o fim (branch → PR verde → merge → publicação).
- Relate o escopo real do que foi testado; não transforme hipótese em fato.
- Não registre segredos, dados pessoais, dumps ou logs brutos.

## Qualidade de código

- Organize por coesão, não por tamanho: não há teto de linhas por arquivo. Função
  que faz coisas demais se divide por responsabilidade; arquivo coeso pode ser
  longo. Não crie arquivo de poucas linhas, barril de reexportação nem abstração
  com um uso só.
- Antes de escrever um helper, procure se ele já existe (datas de São Paulo,
  dinheiro, formatação, normalização de texto, HTTP de provider).
- Comentário explica o porquê atual, em poucas linhas. A história da mudança
  (datas, incidentes, o que foi removido) vai no commit e no PR.
- Nomes: identificadores novos em inglês; termos do negócio já gravados no banco
  (`mercado`, `selecao`, `lucro`, `conta`, `movimentacao`) ficam em português;
  texto de interface em português. Não misture os dois idiomas num identificador.
- Na interface (painel, mensagens do bot, exportação) a entidade `Bankroll` é o
  **tipster**, masculino ("o tipster", "Novo tipster"), nas rotas `/tipsters`.
  No código e no banco ela continua `Bankroll`/banca, sem renomear
  identificador. "Banca" na interface só no sentido de dinheiro (capital, banca
  atual, a banca da calculadora de Kelly).
- Teste testa comportamento. Não escreva teste que lê o código-fonte para
  policiar texto; o que precisa valer para a árvore inteira vira regra de lint ou
  fronteira em `tests/plataforma/architecture-boundaries.test.ts`. O arquivo de
  teste leva o nome do módulo, não de uma auditoria ou data, e fica na pasta da
  área (`tests/<área>/`, lista no README); caso de um módulo que já tem teste
  entra no arquivo dele.
