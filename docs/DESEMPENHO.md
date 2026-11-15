# Desempenho do painel e dos fornecedores

A auditoria de 09/10/2026 mediu o build standalone local, com PostgreSQL
17 do servidor de testes, Chromium e dados sintéticos. Passou pelas nove
páginas do painel, com cenários de 500, 5 mil, 25 mil e 50 mil apostas e de
1 a 100 tipsters. As interações mais pesadas foram repetidas com CPU do
Chromium reduzida a um quarto da velocidade. Não foi feita carga em produção.

## Achados confirmados e correções

| Gargalo | Correção | Prova |
| --- | --- | --- |
| Traçados SVG cresciam com cada aposta, mesmo quando dezenas delas ocupavam o mesmo pixel | O traço conserva primeiro, último, mínimo e máximo por pixel; coordenadas de desenho usam centésimos de pixel | Teste de 25 mil pontos verifica tamanho, extremos, ordem e pontas; E2E verifica o traçado real |
| Cursor recalculava escala e geometria da série inteira | A geometria fica memorizada por dados e tamanho; o cursor continua lendo cada valor da série original | Teste de interação e medição de 24 movimentos com o gráfico visível |
| Gaveta montava todas as apostas do recorte de uma vez | Páginas locais de 50 apostas, com total e resumo completos | E2E de 25 mil apostas confere páginas, navegação mobile e acessibilidade |
| Histórico do tipster montava todas as linhas dos meses abertos | Lotes de 50 por mês ou ordenação; carregar mais mantém busca, contagens, seleção e cópia do recorte completo | Teste carrega todas as 121 apostas e conserva o lote depois de atualização do servidor |
| Visão geral calculava semanas e dias para usar somente meses | `computeMonthlyPeriods` compartilha o agrupamento mensal sem calcular o restante da aba Período | Teste verifica a Visão geral e os testes existentes conferem os números |
| Contas trazia todas as movimentações e só depois recortava as 60 de cada conta | `LATERAL` com `LIMIT 60` no PostgreSQL; totais continuam agregando o histórico inteiro | Medição de transferência do pool e testes de totais/ordem com mais de 60 movimentações |
| Cada agregado de CLV relia e revalidava no processo web todas as provas de fechamento, e um render pede dois ou três agregados | O veredito de cada prova vale pela transação da leitura: o primeiro agregado valida, os seguintes só listam os ids do próprio filtro | Teste de banco conta as validações por render do Dashboard e de Tipsters e compara os números com cada agregado lido sozinho |

O caso denso revelou também um problema de contraste: o número do KPI encolhe
no mobile, mas usava uma cor destinada a texto grande. O KPI mantém agora a
cor semântica acessível do tema, e o E2E confere esse caso com Axe.

## Medições antes e depois

| Cenário | Antes | Depois |
| --- | ---: | ---: |
| Abrir recorte de 21.429 apostas, CPU reduzida | 22,56 s | 0,44 s |
| Elementos no DOM da gaveta | 300.023 | 721 |
| 24 movimentos do cursor, CPU reduzida | 2,04 s | 0,42 s |
| Voltar à Visão geral, CPU reduzida | 1,02 s | 0,37 s |
| HTML do Analyzer, 25 mil apostas | 18,9 MB | 10,4 MB |
| Traçados SVG do Analyzer, 25 mil apostas | 8,9 MB | 0,40 MB |
| Elementos do histórico do tipster, 25 mil apostas | 43.089 | 3.714 |
| Leitura de Contas, 100 contas e 100 mil movimentações | 646 ms | 140 ms |
| Movimentações transferidas para as listas de Contas | 100 mil | 6 mil |
| Idas ao banco pela prova de CLV, Dashboard, 25 mil fechamentos | 103 | 53 |
| Idas ao banco pela prova de CLV, Tipsters, 25 mil fechamentos | 102 | 52 |
| Provas validadas por render do Dashboard ou de Tipsters, 25 mil fechamentos | 50 mil | 25 mil |

São observações locais dos mesmos cenários, não percentis nem promessas de
latência em outros aparelhos. MB acima mede o corpo HTML decodificado e inclui
o transporte RSC; não é o tamanho comprimido na rede. O tempo de navegação
registrado pelo medidor inclui a espera por rede ociosa, por isso ele não foi
apresentado como LCP ou INP. Contagens de DOM e transferência de linhas são
verificações estruturais, independentes da velocidade da máquina. As idas ao
banco da prova de CLV são contagem pelo código (um lote a cada 500 provas, mais
a lista de ids de cada agregado), não medição de tempo.

O histórico detalhado continua levando os dados completos exigidos pelos
filtros, calendário, simulador e gavetas. A redução do traço não altera lucro,
CLV, drawdown ou os valores do cursor. Acima de 25 mil linhas, permanece o
resumo completo com páginas do servidor, conforme o BLUEPRINT.

## Guardas para alterações futuras

- O traçado pode reduzir pontos de desenho; a base de cálculo e a leitura do
  cursor continuam completas. Nunca usar a amostra gráfica para calcular métrica.
- A gaveta e o histórico informam o total, mantêm acesso às demais apostas e
  não limitam exportação ou seleção financeira ao lote desenhado.
- A atualização da aposta não fecha os lotes já carregados. Um filtro que
  ainda não teve lote carregado começa pelo primeiro lote.
- O extrato recente é limitado no SQL. Saldo, depósitos, saques e resultado
  continuam usando todos os movimentos, sem cache que esconda escrita nova.
- O veredito da prova de CLV vive só dentro da transação que o calculou, nunca
  entre requisições. O filtro de cada chamador limita a leitura, não a regra.
- Regressões ficam nos testes dos módulos em `tests/painel/`,
  `tests/dinheiro/contas-page.db.test.ts` e `tests/browser/analyzer-server.spec.ts`.

## Catálogos e consumo de cota

As simulações de concorrência usam 100 consumidores no mesmo processo, com
cache em memória vazio e persistência controlada. Os catálogos de FlashScore
e BridgeOdds têm 300 jogos sintéticos. A contagem abaixo mede chamadas à
camada de persistência; não é um teste de carga do PostgreSQL ou da produção.

| Cenário | Leituras antes | Leituras depois |
| --- | ---: | ---: |
| FlashScore, cache persistente válido ou ausente | 100 | 1 |
| BridgeOdds, cache persistente válido | 100 | 1 |
| BridgeOdds, cache persistente ausente | 101 | 1 |
| Pinnacle17, cache persistente válido | 100 | 1 |
| Pinnacle17, cache persistente ausente | 101 | 2 |

Leitura, validação e preparação dos catálogos FlashScore e BridgeOdds são
compartilhadas entre consumidores simultâneos. Na Pinnacle17, só a leitura em
voo é compartilhada: a segunda consulta depois da cadência permanece, porque
outro processo pode preencher o cache durante a espera. O instante original
da observação acompanha o dado reutilizado; a reutilização não renova o preço.

Um 401 atrasado da BridgeOdds só invalida o token que aquela consulta usou.
Se outra consulta já renovou a credencial, ela é reaproveitada, evitando outro
login e sua cobrança de cota e espera na cadência global.

Falhar ao gravar um cache rederivável gera aviso e preserva a resposta obtida,
sem transformá-la em falha do fornecedor. FlashScore e BridgeOdds conservam
seu L1 com os limites e TTL existentes. A Pinnacle17 não ganha cache de preço
em memória: continua consultando a persistência, com suas reservas e prazos.
As travas de orçamento, cadência, transporte e contrato permanecem ativas.
O arquivamento de evidências mantém seu tratamento próprio de falhas.

Os testes dos módulos cobrem concorrência com e sem cache persistido, falha
de gravação, nova tentativa após erro de leitura, vencimento, horários de
observação e renovação concorrente de token. São simulações locais sem chamadas
pagas; não estimam economia mensal em reais.
