# Arquitetura do AutomaBACA

Mapa do código e das regras que não podem quebrar. As fronteiras abaixo são
fiscalizadas por `tests/plataforma/architecture-boundaries.test.ts`.

## Processos e responsabilidades

- `app/`: Next.js App Router, páginas, rotas HTTP e Server Actions.
- `app/_design/adapters/`: consultas convertidas em dados serializáveis para UI.
- `app/_design/screens/`: componentes e estado de interação.
- `src/domain/`: regras puras, dinheiro, datas de São Paulo, mercados e estatísticas.
- `src/services/`: casos de uso, transações, consultas e autorização operacional.
- `src/infra/`: Prisma, configuração, autenticação, telemetria e clientes comuns.
- `src/providers/`: acesso a fornecedores externos, seus contratos e limites.
- `src/services/capture/`: captura de apostas: a leitura (`reading/`), a preparação para o registro (`preparation/`), o post do canal (`channel/`), a DM, o conserto pela DM e o registro único.
- `src/telegram/`: só a borda do bot (grammY, filas do Telegram, download de foto); `src/jobs/`: execução assíncrona pelo worker.
- `prisma/`: schema e migrations. PostgreSQL armazena negócio e filas do pg-boss.

Web e worker são processos distintos e compartilham domínio, serviços e contratos
de fila. A release reúne os dois runtimes e as migrations da mesma fonte.

## Como roda

- **Web:** o standalone do Next.js, na imagem `automabaca-novo-web`, atrás do
  Caddy. Serve o painel e as rotas HTTP, incluindo o webhook do Telegram.
- **Worker:** `dist/worker.mjs`, na imagem `automabaca-novo-worker`. É o único
  processo com o token principal do Telegram e as chaves de LLM; executa as filas
  do pg-boss e os jobs periódicos, com um único worker ativo garantido por
  advisory lock.
- **Banco:** PostgreSQL 17.11 Alpine. Web e worker usam a role
  `automabaca_runtime`, sem superuser; migrations e backup usam a administrativa
  (`DATABASE_URL_ADMIN`).
- As duas imagens saem da CI e sobem por digest. Como uma release chega lá:
  `docs/RELEASE.md`.

## O que o produto mede (conferido em 22/09/2026)

A aposta capturada passa por três perguntas independentes, com evidências
separadas — nenhuma delas empresta prova para a outra:

1. **Identidade**: que evento do provider é este? (`bet_sharp`: provider,
   `providerMatchId`, `priceReference`, `identityStatus`.)
2. **Preço de fechamento**: qual era a linha justa quando o jogo começou?
   (`bet_closing`.) O **CLV** é a odd cravada contra essa fair devigada —
   `percentualContraFair` em `src/domain/odds.ts`, nunca contra a odd bruta.
3. **Resultado**: quem ganhou. (`bets.status` e o serviço financeiro; o placar
   e a observação do FlashScore ficam em `bet_result`, fora do preço.)

A **abertura** (`bet_opening`) é colhida na BridgeOdds DEPOIS do kickoff, quando
a linha com certeza existe, e alimenta o movimento abertura → fechamento que a
ficha e o Analyzer mostram.

**Pareamento dos catálogos e fichas dos times.** O job `teams.catalog_pairing`
(08:37, 12:37, 16:37 e 20:37 de São Paulo, cada rodada de agora até o fim do
dia ou 12 h à frente) liga os jogos da Pinnacle17 aos do FlashScore
(`catalog_game_links`) e grava a ficha de cada time bem casado: o id do
FlashScore com os nomes da Pinnacle17 (`team_cards` e `team_card_evidence`,
uma evidência por jogo). A ficha nasce de lado com evidência própria ≥ 0,85, e
a abreviação expandida do FlashScore ("I. Bratislava" = "Inter Bratislava",
0,95) conta: por isso um nome da Pinnacle só acha a ficha com 2 jogos
distintos. O código está em `src/services/teams/`, e as métricas e o alerta,
em `docs/OBSERVABILIDADE.md` ("Pareamento dos catálogos" e "Fichas dos
times"). O que lê as fichas:

- **Tradução do nome da aposta** (`teams/resolve.ts`, antes da busca em cada
  fornecedor, só com o esporte conhecido): o nome acha a ficha pelo nome de
  tipster confirmado, pelo nome da Pinnacle17 (2 jogos) ou pelo do FlashScore,
  sempre pela regra de nome genérico ("Racing", "Inter" só com país e
  competição); com mais de uma ficha depois de filtrar categoria e país, não
  traduz. A Pinnacle, a Pinnacle17 e a Bridge recebem o nome da Pinnacle17 mais
  recente da ficha (visto em 1 jogo basta, a ficha já foi achada); o
  FlashScore, o nome e o id do time, que é dica para o matcher, não filtro:
  com os dois ids e nenhum deles em partida nenhuma da janela, os nomes
  decidem com o piso do pareamento (0,85 por lado, 0,3 de folga).
- **Nome do tipster** (`teams/tipster-names.ts`, `team_tipster_names`): a
  identidade automática ensina pela ligação do jogo casado (o lado da
  Pinnacle17 leva ao id do FlashScore); sem ligação ainda, a ocasião espera a
  rodada do pareamento que ligar o jogo (`team_tipster_name_waits`). Pendente
  na primeira vez, confirmado noutro evento, noutra aposta e noutro dia de São
  Paulo; uma ficha por nome confirmado no mesmo esporte, país e categoria, e
  o nome pendente em duas fichas desse contexto não confirma. O Vincular (dono
  ou agente dele) ensina já confirmado, na mesma transação que vincula: a
  ficha vem da ligação do jogo escolhido ou, sem ela, do nome da Pinnacle do
  candidato (um jogo basta, uma ficha só), com as mesmas travas de nome, sem
  tomar o nome confirmado de outra ficha.
- **Liquidação:** a aposta sem jogo vinculado e com identidade casada usa o
  jogo que a ligação dá ao evento (`ok` e 1:1) como id conhecido, pelas mesmas
  travas do vínculo por id (3 h do horário da aposta, categoria). O mando vem
  dos ids dos times que o FlashScore devolve agora contra os da ligação
  (invertidos, inverte; outros, recusa), e a aposta precisa estar claramente
  numa orientação dos nomes da Pinnacle17 da ligação; recusado, a busca por
  nome decide. No jogo já vinculado sem ligação, o mando vem dos ids das fichas
  ou dos nomes dos dois lados, com folga; sem mando claro, a busca decide de
  novo. A perna de múltipla casa na janela da busca, sem a trava de 3 h: o
  horário do bilhete não é o de cada jogo.

Não existe EV de entrada desde 22/09/2026 (ver AGENTS.md): o preço no instante
da tip não existia para os canais que o dono segue. Ausência de número é sempre
EXPLICADA por um motivo do vocabulário fechado (`src/domain/no-odds-reason.ts`),
e o motivo decide se a aposta entra no denominador da cobertura.

## Invariantes

1. Server Actions validam sessão e entrada antes dos serviços. TypeScript não
   substitui validação no servidor.
2. Saldo e movimentos são atualizados pelo serviço financeiro na mesma transação.
   Liquidação, reabertura e remoção preservam a conciliação. O valor da unidade
   gravado na aposta é histórico, independente do valor atual da banca.
   Com placar de entrada ao vivo, a identidade troca os nomes pelos da Pinnacle
   preservando a ordem dos times da captura: o placar imutável continua ligado
   ao mesmo time. O Vincular confere o hash da opção exibida/aprovada dentro
   da transação; a gravação do diagnóstico também trava e relê a aposta,
   para que uma busca antiga não reabra um caso já decidido ou editado.
   A leitura do FlashScore carrega a revisão da aposta desde antes da consulta.
   Remover/restaurar, editar/desfazer ou reabrir exige uma leitura nova, mesmo quando
   os termos voltam aos mesmos valores. Limpar evidência de aposta já pendente
   avança a revisão e preserva a prova anterior em `EVIDENCE_CLEARED`. A observação
   pode acompanhar uma única liquidação daquele ciclo, sem atravessar reabertura.
   Cancelamentos pós-commit travam e releem a aposta e atingem somente jobs criados
   até a decisão; uma cadeia retomada ou uma recuperação histórica posterior fica.
   Remoções guardam a revisão na trilha para desempatar horários iguais. Empate sem
   revisão íntegra bloqueia a restauração, em vez de escolher um estado financeiro.
   A estatística lê a linha sem o numeral do tempo e recusa combinados sem prova
   de todas as condições. Em cartões de ambas as equipes, a direção vale para cada
   lado; devolução ou meia vitória exige conferência da odd da casa. A prop preserva
   qualificadores de mercado e seleção, inclusive em contratos já gravados; linha
   inválida não recebe um padrão nominal. Pré-jogo de prop exige horário confiável
   e ausência de evidência de entrada ao vivo. Os parciais de futebol conferem o id
   e o placar listado da partida; sem prova, a observação tenta de novo na graça.
   Fora do futebol encerrado no tempo normal o feed não publica parciais: a
   recusa sai na hora, sem consulta nem espera.
   Múltipla incompleta na leitura não vira simples na primeira seleção. Pernas
   reconstruídas preservam unidade e mecânica do mercado; período global completa
   só as pernas sem período próprio, e a normalização conserva a prorrogação.
   Placar ao vivo da raiz não se distribui entre jogos diferentes. Cancelamento
   parcial exige conferir a regra e a odd da casa, mesmo com outra perna perdida;
   a conferência de liquidação já feita também respeita essa limitação.
   Corrigir uma liquidação sem conta para resultado final de lucro zero fecha a
   pendência financeira; voltar a Pendente ainda aguarda a reparação do vínculo.
3. Captura usa identidade externa e idempotência. Um post pode gerar várias
   apostas; o funil conta posts por canal/mensagem e apresenta apostas geradas,
   mantidas e removidas separadamente. Post (texto ou foto) que não vira
   aposta por filtro, pausa do canal ou leitura sem aposta fica guardado e
   pode voltar à captura; edição de post já capturado não muda a aposta, e o
   post do tipster não liquida (ver as decisões de produto no AGENTS.md).
   Origem absorvida por deduplicação também fica consumida (`absorbed_bet_sources`),
   mesmo após editar/remover a aposta. O recibo não transfere as reações do post
   repetido. Excluir o tipster aposenta as origens diretas e absorvidas; origens
   antigas ainda provadas só pela auditoria seguem protegidas sem reescrita.
   O Telegram entra só por webhook, e todo update roda na fila `telegram.updates`,
   em ordem por post: a edição espera o post, e a falha passageira volta como
   cabeça da fila do post. A ordem vale até a dead-letter definitiva: ela solta
   a fila do post, e o que chegou depois dele passa a rodar.
   O cadastro manual de aposta grava a chave do formulário como origem externa,
   para que a reentrega não recrie uma aposta editada ou removida.
   A criação manual de conta e tipster usa uma chave por formulário, mantida
   nas novas tentativas. O recibo (`creation_receipts`) commita com o recurso,
   o depósito inicial e a auditoria; dados diferentes recusam a mesma chave,
   e excluir o recurso não libera um pedido antigo para recriá-lo.
   A DM e o conserto pela DM gravam a intenção de resolver esporte/buscar preço
   na mesma transação da aposta (`capture.followup`). O envio imediato e a
   `outbox.dispatch` retomam a intenção com id estável, relendo o estado atual
   e os jobs já tentados, sem reiniciar uma cadeia concluída. A confirmação
   também fecha a ação de fila ausente; intenções pendentes não expiram.
   Restaurar uma aposta pendente grava a mesma intenção, por restauração:
   uma volta nova encerra a intenção da volta anterior, e jobs cancelados
   antes da restauração não impedem a cadeia nova. A restauração pendente
   reinicia a observação de resultado e a estabilidade de props, preservando a
   evidência anterior na trilha; resultado já liquidado mantém sua prova.
4. Recusa de negócio, indisponibilidade e ausência de dados são estados distintos.
   Falha de consulta não pode virar saldo zero na interface. Resposta externa
   inteiramente descartada, mesmo pequena, não prova ausência de jogos ou preços.
   Pinnacle17 e Bridge descartam partidas de outra modalidade antes da identidade.
   A Bridge só considera a paginação completa quando comprova o fim; teto sem
   total publicado continua truncado. Geração de IA interrompida não é evidência
   aceita, e corpos HTTP externos têm teto de leitura e descarte do stream.
5. Analyzer consulta o recorte da URL. O eixo de data é um só, o dia do jogo
   (kickoff, calendário de São Paulo): vale para o recorte, para a janela
   anterior e para todo agrupamento por período (curva, dia, semana, mês), no
   detalhe e no resumo. A data da liquidação não move aposta de balde. O fim do
   recorte com prazo vale para o que já tem resultado: a pendente de jogo futuro
   entra no recorte atual. Comparativos incluem a janela anterior do
   mesmo tamanho, com fronteiras de São Paulo. Acima de 25 mil linhas de detalhe,
   o servidor fornece resumo completo e páginas de 50 apostas; gráficos detalhados
   exigem um recorte menor.
   O Analyzer da carteira (`/analyzer`, todos os tipsters) soma dinheiro em reais,
   pelo `valorUnidade` gravado em cada aposta; o CLV, percentual, não muda.
   Os consolidados de lucro, stake, ROI e curva do Dashboard e de Tipsters
   usam a mesma conversão histórica em reais, com seis casas por aposta; as
   métricas individuais continuam em unidades. "Hoje" e "desde a última visita"
   arredondam cada resultado em reais para centavos, como no extrato.
   Dashboard, Tipsters e a ficha de cada tipster leem os indicadores, as curvas
   e suas bases no mesmo snapshot PostgreSQL (RepeatableRead), para uma captura,
   liquidação ou remoção concorrente não misturar estados na tela. Saúde do motor
   e filas operacionais são leituras independentes. No Dashboard, data, saudação,
   resumo de hoje e frescor do motor usam a mesma referência de horário; o dia
   tem início inclusivo e fim exclusivo em São Paulo. Canceladas e anuladas
   contam como encerradas em "Hoje" e "desde a última visita", sem lucro.
   A dimensão Canal distingue todas as bancas, inclusive nomes que coincidam
   com o rótulo de um homônimo; as meias decisões conservam peso de metade
   também no acerto consolidado. O cartão de compartilhar lê o acerto esportivo
   do resumo completo: cash-out não é acerto, e a janela das 300 apostas não
   altera sua base. As abas Positivas e Negativas filtram lucro líquido, inclusive
   cash-out; ROI divide lucro líquido pela stake finalizada. A pendência dos
   períodos conta só PENDING; anuladas e canceladas encerradas ficam fora da
   base financeira, sem fazer o período parecer em aberto. A comparação com
   CLV é referência de lucro, sem afirmar retorno bruto ou atribuir o desvio à sorte;
   a diferença de ROI usa pontos percentuais. O resumo diário do Telegram usa ROI monetário
   pelo snapshot de cada aposta e sinaliza ganho/perda pelo lucro em reais.
   O boletim de pendências agrupa pelo id da banca e identifica o slug, sem
   juntar tipsters homônimos nem compartilhar o limite de linhas entre eles.
   Fora do Analyzer, toda medida de desempenho por período segue o mesmo eixo:
   a curva de lucro do tipster, as curvas e a média por dia do Dashboard e o
   Δ 30d da decisão do canal em Tipsters (últimos 30 dias de jogo contra os 30
   anteriores, no painel e no boletim semanal) e o lucro do mês do resumo
   diário do Telegram. Pendente não entra em curva de
   lucro, e a curva do tipster não tem ponto depois de hoje. Ficam pela data em que o fato aconteceu as contagens de evento e o
   dinheiro: "hoje" e "desde a sua última visita" do Dashboard, o extrato e os
   saldos de Contas, o "no dia" do resumo diário e os boletins do Telegram, a trilha da
   aposta e as colunas de liquidação da exportação CSV.
6. Segredos são injetados no runtime e ficam fora do Git e das releases. Testes E2E
   usam credenciais sintéticas, banco descartável e fornecedores neutralizados.

A normalização conserva a unidade explícita do mercado e da seleção, inclusive
cor de cartão e chute no alvo. Unidades contraditórias não são escolhidas em
silêncio. Gols, pontos e corridas só liquidam por placar nos esportes que usam
aquela unidade. O contrato de preços aplica a mesma natureza: o livro de
Bookings não precifica só amarelos ou vermelhos, nem o de gols uma estatística
que foi declarada apenas na seleção.

## Verificação

O workflow `check` executa estáticos e unitários, integração PostgreSQL, build,
fluxos críticos e o smoke das telas (desktop) no navegador; `release verificada` exige todos aprovados (na
`main`, os do PR valem quando ele testou a mesma árvore).
`tests/plataforma/architecture-boundaries.test.ts` fiscaliza as fronteiras entre camadas.
Comandos no [README](README.md).

O bootstrap unitário/PostgreSQL, o build e o servidor E2E neutralizam chaves
herdadas de LLM, fornecedores e bots. Variáveis vazias ou sintéticas impedem
que uma leitura posterior do `.env` reative essas integrações; os testes de
provider configuram suas próprias credenciais fictícias e respostas simuladas.
O check incremental inclui a simulação do ambiente shell quando ele muda.

### Reconstrução dos indicadores

O CSV completo do tipster conserva as seis casas das odds justas, o id da
aposta, a unidade histórica, os valores em reais e os instantes ISO com
milissegundos. A prova de preço leva provider, referência tipada, observação e
o snapshot mínimo versionado do book; com ele se refaz raw/fair e CLV sem
cache nem nova consulta ao fornecedor. Preço sem prova válida fica vazio.
O copiar visíveis pode não ter a prova completa; campos ausentes ficam vazios,
sem inventar unidade, horário ou procedência. Stake/lucro são unidades; as
colunas em reais usam a unidade da aposta e seis casas, como a carteira do
Analyzer. O extrato financeiro arredonda cada movimentação para centavos.

Entrada e fechamento precisam representar o mesmo período, unidade e regra de
prorrogação. A normalização conserva essas condições no mercado ou na seleção,
inclusive ao converter DNB/dupla chance em handicap asiático. O leitor de odds
mantém o contrato original ao procurar a linha equivalente; preço de outro
escopo não vira abertura nem CLV confiável. DNB/dupla chance em tênis e tênis de
mesa não usam a equivalência AH: a unidade ou a regra de retirada pode diferir.

Na captura da Pinnacle17, o recebimento da resposta fixa o instante do preço:
cache e arquivo conservam esse mesmo horário, mesmo se a gravação terminar
após o kickoff. Cotação anterior ao registro da aposta ou à última troca do
modo de medição não entra no fechamento. A recuperação local aplica uma
resposta pré-jogo mais recente mesmo quando o preço congelado já era
confiável; preserva decisões manuais e o instante original do congelamento.

Os agregados SQL de CLV validam a mesma prova matemática da ficha, em lotes de
500, dentro do snapshot da consulta e uma vez por transação: além de reproduzir raw/fair, o CLV deve
conferir com a odd atual da aposta, respeitando apenas as escalas persistidas
(fair com seis casas, CLV com quatro). Um preço válido não torna confiável um
CLV divergente. Corrigir a odd recalcula pelo book original, sem acumular o
arredondamento da fair; sem prova válida, não fabrica CLV.
A cobertura inclui fechamentos congelados sem CLV utilizável mesmo enquanto a
liquidação está pendente. O avaliador de segmentos aplica a mesma prova e
aceita identidades automáticas e vinculadas pelo dono; erros de prova ou de
cálculo, por si sós, não contam como sucesso nem como ausência do fornecedor.
Liquidez é o limite cotado pelo fornecedor, com moeda comprovada, usado como
referência de capacidade; não é volume negociado nem profundidade de ordens.
O snapshot de preço conserva o limite exato, inclusive frações; a leitura usa
a coluna inteira apenas quando o snapshot ainda não traz esse valor. Linha
sintética prova preço, não limite: seus componentes não dão liquidez à linha.
Cobertura de liquidez exige limite USD; CLV disponível sozinho não a cobre.
A linha de quarto sintética exige justas coerentes com resultados aninhados:
a linha mais difícil não pode pagar menos, pois implicaria probabilidade
negativa no resultado intermediário. Essa comparação usa as justas; as odds
brutas podem ter margens diferentes por linha. CLV é diferença relativa de
preço, não lucro esperado exato: devoluções e meias decisões mudam os pesos
dos pagamentos. Nesses mercados, 1/fair não é probabilidade simples de vitória.
A curva e o simulador ordenam por kickoff e id, para reconstruir a mesma sequência quando várias apostas têm o mesmo
horário. Reembolso interrompe sequências, mas não entra na stake do ROI.

O boletim semanal usa um snapshot para as duas réguas e corta ambas no horário
anunciado do disparo, inclusive em execução atrasada. A régua anterior continua
sendo uma reconstrução conservadora com o estado atual: aposta removida depois
e prova sobrescrita não são inventadas como se fossem um snapshot do passado.
A série diária de casamento conserva a primeira gravação mesmo entre workers
concorrentes; ela registra versão do cálculo, janela, instante e release. Os
dados anteriores sem essa procedência não são preenchidos retroativamente.

A disponibilidade histórica de CLV considera a última escrita do fechamento,
além da tentativa de congelá-lo: a busca pós-jogo pode ter chegado depois. Essa
mesma data sustenta o resumo desde a visita, o corte histórico da régua e os
eventos do simulador, que não podem consultar um CLV ainda desconhecido no post.
O transporte compacto do Analyzer conserva stake/lucro originais em unidades;
reverter uma conversão já arredondada em reais não reconstrói microunidades.

## Bônus e termos promocionais

O lançamento `BONUS` em Contas representa crédito já disponível em dinheiro:
entra no saldo e no lucro líquido, sem virar depósito nem resultado de aposta.
Freebets e créditos sujeitos a rollover não são dinheiro disponível nesse saldo.
Apostas com stake gratuita/em bônus, reembolso condicional ou pagamento antecipado
precisam de contrato financeiro próprio; a captura, o registro e a edição recusam esses
termos, com motivo e evidência para conferência. Uma releitura que omite a
promoção não apaga a prova de outro leitor. Oferta futura não é stake; odd
turbinada efetivada continua sendo a odd apostada, respeitando a política da origem.


### Cash-out e operações de proteção

O cash-out total é um encerramento manual pelo lucro líquido em unidades
(valor devolvido menos a stake original), dentro dos limites financeiros do
bilhete. Pode acontecer antes do jogo ou de confirmar o esporte/horário;
nenhum placar automático pode produzir um cash-out ou substituir um já gravado.
Avisos de cash-out realizado não são novas entradas, e valores oferecidos pelo
botão de cash-out não são stake.

O contrato de `Bet` representa aposta a favor com stake em dinheiro. Lay,
responsabilidade de exchange, comissão cobrada e cash-out parcial realizado
não têm cálculo próprio de exposição residual: ficam recusados para conferência,
com evidência preservada na leitura, antes da normalização de mercado, no
registro e na edição. Uma aposta a favor usada como cobertura, com stake e odd
próprias, permanece um bilhete independente; não há compensação automática
entre bilhetes. Uma instrução futura de gestão não prova encerramento parcial.


### Limites da inferência estatística

A decisão de CLV mantém o piso de 30 fechamentos confiáveis e o teste t
bicaudal individual a 95%. Contagem, média e desvio precisam ser válidos;
valores não finitos não aumentam a amostra. A tolerância para dispersão
numérica é relativa à média, preservando o resultado ao mudar a escala.
CLVs constantes usam o sinal, sem teste t calculável. A interface distingue
essa regra do teste: apostas do mesmo jogo podem ser correlacionadas e os
critérios individuais não têm ajuste para múltiplas comparações. Δ 30d é uma
variação descritiva, sem teste de mudança. Referências: [teste da média](https://www.itl.nist.gov/div898/handbook/eda/section3/eda352.htm)
e [confiança simultânea](https://www.itl.nist.gov/div898/handbook/prc/section4/prc473.htm).

A comparação dos leitores reúne as tentativas de cada cascata antes de
selecionar o período, pela origem gravada em `llmCallStartedAtMs`. Sem ela,
usa a primeira tentativa observada na retenção de 30 dias. Só declara sorteio
quando todas as atribuições têm `llmEvaluationRandomized = true`; alternar o
primeiro modelo não comprova aleatorização. Cotas e disponibilidade podem
mudar a população atendida. O intervalo de Wilson mede aceite de leitura
completa, sem provar acerto da extração ou superioridade entre modelos.
