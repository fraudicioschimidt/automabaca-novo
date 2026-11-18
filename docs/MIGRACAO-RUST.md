# Migração para Rust

Plano aprovado pelo dono em 15/11/2026: o AutomaBACA vai inteiro para Rust,
em fases, sem tirar a produção do ar. Este documento é o mapa. Cada fase vira
PRs pequenos, com a CI verde e o publicador automático de sempre.

## Onde estamos (15/11/2026)

| Parte | Tamanho | Observação |
|---|---|---|
| `src/domain/` | 133 arquivos, ~21 mil linhas | puro: nenhum import de banco, rede, disco ou Prisma; 142 arquivos de teste o exercitam |
| `src/services/` | 214 arquivos, ~47 mil linhas | orquestração, banco e regras com efeito (ops, sharp, liquidação, captura, apostas, painel) |
| `src/providers/` | 45 arquivos, ~6,8 mil linhas | clientes de FlashScore, BridgeOdds, Pinnacle17 e afins |
| `src/infra/`, `src/jobs/`, `src/telegram/` | ~7,8 mil linhas | fila (pg-boss, 29 filas), logs, auth, LLMs, bot |
| `app/` | 12 páginas, 8 grupos de rota em `app/api`, ~15 mil linhas TSX | Next.js 16 standalone, design em `app/_design` |
| Banco | 52 modelos, 118 migrations | as migrations já são SQL (`prisma/migrations/*/migration.sql`) |
| Testes | 508 unitários, 172 de banco, 12 specs de navegador | os de navegador testam por fora e valem para qualquer linguagem |

## Princípios

1. **O mesmo PostgreSQL, o mesmo esquema.** Rust e Node convivem no mesmo banco
   até o fim. As migrations continuam em `prisma/migrations/` (SQL puro) e pela
   régua do `deploy/migrar.py` até a fase 5.
2. **Uma parte de cada vez em produção, sempre reversível.** Toda virada tem um
   interruptor (variável de ambiente ou rota do Caddy) que volta para a versão
   em TypeScript sem deploy de código.
3. **Paridade provada antes da virada.** Lógica pura: os testes existentes em
   TypeScript passam contra a implementação em Rust. Trabalho com efeito (fila,
   banco, Telegram, dinheiro): modo sombra, em que o Rust calcula, grava só a
   comparação e o Node continua decidindo, até as duas versões concordarem.
4. **Liquidação por último, em cada fase.** É o que mexe com dinheiro e erra em
   silêncio. Ela só vira depois de semanas de sombra sem divergência.
5. **A suíte de navegador é o aceite final.** Os 12 specs do Playwright rodam
   contra a versão nova de cada tela antes de ela substituir a antiga.
6. **Rust estável, versão fixada.** `rust-toolchain.toml`, `cargo fmt`,
   `cargo clippy -D warnings` e `cargo test` na CI, como o lint e os tipos hoje.
7. **Limpar sem misturar com a migração** (decisão do dono de 18/11/2026). O
   PR que porta um módulo continua com paridade estrita. Antes dele, um PR em
   TypeScript tira o que não serve (código morto, export sem uso, duplicação
   que não muda resultado), provado pelos testes e pelo código atual, para não
   portar o que vai sair. O que mudaria o resultado de alguma aposta (unificar
   vocabulário que diverge, fechar caso que liquida pelo motivo errado) não
   entra em PR nenhum sem o sim do dono: fica na lista abaixo, com o efeito
   descrito, e vira um PR pequeno por item depois de aprovado.

### Limpezas que mudam comportamento (esperando o dono)

Cada item diz o que muda e onde foi visto. Nenhum está aplicado.

- **Vocabulário de estatística em três lugares.** As palavras de cartão,
  escanteio e gol aparecem no `NON_SCORE_STAT_TERMS`
  (`mercados/stat-qualifier`), no `TEAM_TOTAL_NAMED_UNIT_RE`
  (`mercados/classify`) e na lista própria de `settlement/over-under-subject`,
  e as listas não são iguais (o `classify` só reconhece escanteio e cartão
  como unidade nomeada do total do time; chutes e faltas, não). Pode ser de
  propósito. Antes de propor, levanto quais rótulos caem numa lista e não na
  outra e o efeito em apostas reais.

## Fases

### Fase 0: fundação (~1 semana)

- Workspace Cargo em `rust/`, com os crates `dominio` (lógica pura),
  `dominio-node` (ponte N-API, via napi-rs), `banco` (sqlx), `worker` e `web`,
  nascendo vazios.
- Job `rust` no `check.yml`: fmt, clippy e testes, com cache do Cargo. O
  manifesto de release passa a conferir também o binário nativo.
- A ponte `dominio-node` gera um `.node` para linux-x64-gnu (as imagens são
  Debian bookworm). O `package:worker` e o standalone do Next passam a levá-lo
  (`serverExternalPackages`).
- **Saída:** uma função pequena do domínio (por exemplo, `kelly.ts` ou
  `money.ts`) responde em produção pelo Rust, com os testes em TypeScript dela
  passando contra a ponte.

**Concluída em 15/11/2026** (#9, #10, #11; no ar desde a release
`dcb5dfd1a767`): workspace e job `rust`, ponte `@automabaca/dominio-node` no
standalone e no worker, conferida no manifesto e carregada nas imagens
bookworm, e o `cron-cadence` respondendo pelo Rust no worker de produção
(agendamento de cada job na subida e no laço do agendador). A função não foi
`kelly` nem `money` porque as duas rodam no navegador, onde o `.node` não
carrega (ver a fase 1). Paridade do `cron-cadence`: os testes em TypeScript
sem mudança e 200 mil entradas aleatórias com o mesmo resultado e a mesma
mensagem de erro do TS antigo.

### Fase 1: domínio puro (~6 a 9 semanas; era 3 a 5, revista em 15/11/2026)

**Decisão antes de começar.** 81 dos 133 arquivos de `src/domain/` (14,9 mil
das 21,2 mil linhas, inclusive `money`, `lucro`, `formato-de-resultado`,
`dates`, `odds` e `decimal-input`) são alcançados por componentes de cliente,
e a ponte N-API não carrega no navegador (a fronteira em
`tests/plataforma/architecture-boundaries.test.ts` recusa). Os caminhos:

1. Compilar o `dominio` também para WebAssembly (`wasm-bindgen`), com a casca
   usando a ponte N-API no servidor e o WASM no navegador. É o que a
   estimativa acima supõe: pipeline e teste do WASM, inicialização no
   cliente antes da hidratação e o tamanho do pacote nas telas.
2. Uma ponte só, em WebAssembly, nos dois lados. Um binário a menos para
   conferir, mas a chamada fica mais cara que a N-API no worker.
3. Portar primeiro só o que roda no servidor (52 arquivos, 6,4 mil linhas) e
   deixar o resto para a fase 4, quando as telas saírem do Next. Cabe nas 3 a
   5 semanas, mas o domínio fica em duas linguagens até lá.

**Escolhido em 15/11/2026: caminho 1.** A ponte `@automabaca/dominio`
(`rust/crates/ponte`) entrega o `.node` ao servidor e o WebAssembly ao
navegador pela condição `browser` do pacote, e a CSP ganhou
`'wasm-unsafe-eval'` no `script-src`, que libera só a compilação de
WebAssembly. Os navegadores mínimos (Chrome e Edge 117, Firefox 113, Safari
16.4, decisão do dono de 18/11/2026, pelo CSS das telas) aceitam essa
diretiva. Andamento:

- ponte única, com os testes dos dois lados (#13);
- `kelly` (calculadora de Ferramentas), o primeiro módulo que roda no
  navegador: +31,6 KB com gzip só em `/ferramentas` e ~3 ms de compilação do
  WASM na carga (#14).
- `decimal-input` (números digitados nas telas e na captura) e `odds` (devig e
  CLV), com paridade bit a bit contra o TS antigo nos dois lados (#15). O WASM
  passou a 86 KB (compilado para tamanho), e o chunk que o leva, a ~55 KB com
  gzip, em 7 telas. O tamanho é medido a cada módulo: quando incomodar, o
  próximo passo é o `wasm-opt`.
- o WASM passa a arquivo estático (`.next/static/media`, gzip e cache
  imutável), carregado com `await` no topo do lado do navegador antes da
  hidratação, em vez de base64 dentro de um chunk JS: 42 KB transferidos
  contra 56,5 KB, e compilação em streaming (#16). Era o formato que não
  escalava: o `regress`, o motor de regex com a semântica do ECMAScript que a
  leitura de apostas e a liquidação vão usar, pesa sozinho 490 KB de WASM
  (137 KB com gzip), e 40 dos 58 módulos com regex chegam ao navegador.
- `dates` e a parte sem regex do `dates-parsing` (formatos no relógio de São
  Paulo, chave de dia e de semana, campos de data e hora do painel) (#17). O
  módulo `js` do crate reproduz o `Date` do ECMAScript (`Date.UTC` com ano de
  dois dígitos e rollover, getters, `toISOString`), o `toFixed` (empate para o
  maior) e o `String(número)`; o fuzz contra o TS antigo achou e fez corrigir
  duas quinas dele (o dia da semana do ano 0-99 e os campos NaN na borda da
  faixa).
- `money` (somas, arredondamento e produtos em inteiro escalado, o invariante
  de integridade financeira) (#18). O caminho quente é `i128`, e o
  `num-bigint` fica para a conta que estoura, como o BigInt do TS. Com 5 mil
  valores, a soma ficou 3,8× mais rápida que o TS no servidor e 2,8× no
  navegador, e o produto, 1,1× e empatado. O WASM foi a 189 KB (84,5 KB com
  gzip), já sem a seção de nomes de função, que ia junto desde o começo; o
  `num-bigint` é ~44 KB dele, e o `wasm-opt` continua o próximo passo. O fuzz
  achou uma quina do `String(número)` do Rust: no empate de 17 dígitos
  (1000000000000000.2 vale …0.25) o `{:e}` não escolhe o par, como o
  ECMAScript manda; o módulo `js` corrige, conferido contra o V8 em 5 milhões
  de números (nas datas só passam inteiros, sem empate: não houve efeito em
  produção).
- o build da ponte sai sem caminho da máquina (`--remap-path-prefix` para a
  pasta do cargo e do repositório; o `num-bigint` gravava o caminho nas
  mensagens de pânico): o mesmo commit dá o mesmo `.wasm` em qualquer máquina
  e na CI, e o build recusa o binário que ainda guarde um caminho.
- regex pelo crate `js-regex` e a leitura de data e hora do post
  (`parseBrKickoffDetailed`, em `kickoff.rs`), o primeiro módulo com regex
  (#21). Paridade com o TS antigo em 200 mil textos com cara de post, nos
  dois lados. A leitura ficou mais lenta (14 µs por post no servidor e 8 µs no
  navegador, contra 3 µs), irrelevante no volume de posts; o WASM foi a
  93 KB com gzip.

- `text-normalization` (o caminho quente do pareamento: `normalizeStr`,
  `canonicalizeTeamName`, `teamNameVariants` e o vocabulário de nome de time)
  em Rust direto, sem motor de regex: depois da limpeza o nome só tem
  `[a-z0-9]` e espaços, e os 7 padrões do TS viram regras sobre os tokens.
  O crate `js-text` faz o `normalize("NFD")` + `\p{Diacritic}` + `toLowerCase`
  numa chamada: no navegador, pelo host; no servidor, pelo
  `unicode-normalization` e pela std (Unicode 17, como o Node 24) e por uma
  tabela de `\p{Diacritic}` tirada do V8, conferidos em cada ponto de código
  por `tests/plataforma/js-text.test.ts`. Por nome, `canonicalizeTeamName`
  ficou 1,8× mais rápido que o TS no servidor (já contando a travessia da
  ponte) e empatou no navegador. A memória do `teamNameVariants` fica na
  casca TS enquanto o `text.ts`, que o chama em laço, não vem para o Rust.
  O WASM foi a 114 KB com gzip (o código e o vocabulário dos nomes, sem
  tabela do Unicode).

- `team-category` e `text` (similaridade de nomes de time, separação "A vs
  B", slug, o casamento dos dois lados do confronto e o refinamento de
  candidatos por categoria), juntos porque o Rust não chama TypeScript de
  volta. Paridade com o TS antigo em 1,9 milhão de comparações, nos dois
  lados. O laço do pareamento (uma aposta contra o catálogo do dia) ficou
  2,2× mais rápido no servidor (15 µs contra 34 µs por par, já contando a
  travessia) e 1,5× no navegador; a memória do `teamNameVariants` saiu da
  casca. O `refineCategoryCandidates` recebe uma função por candidato: a
  casca a aplica e a ponte recebe os dados em colunas. O
  `markSoccerReserveTeams` montava um regex com os nomes de cada aposta, o
  que encheria o catálogo sem limite: virou código Rust.

- a base de `mercados/` sem catálogo: `accents`, `match-scope`,
  `trailing-side` e `total-direction`. Paridade com o TS antigo em 1,4
  milhão de comparações, nos dois lados. O `accentuate` do TS lia o mapa
  num objeto comum, e `accentuate("constructor")` devolvia o texto da função
  `Object` do protótipo; o Rust devolve a palavra, e só listas fixas chegam ali.
- o catálogo de mercados (`catalog`, os 40 finais com os 291 aliases, os
  21 intermediários e as 165 traduções) e o vocabulário de Draw No Bet e
  Dupla Chance (`draw-vocabulary`: as listas, os padrões, a limpeza da
  seleção e os termos do SQL do lote de liquidação). Os finais estão em
  `src/domain/mercados/catalog-data.json`, que o TS importa (o tipo
  `MercadoFinal` sai das chaves) e o `build.rs` do `dominio` lê na
  compilação. Paridade com o TS antigo em 916 mil comparações, nos dois
  lados. A Dupla Chance procura o sufixo no texto sem acento e corta o
  original naquele índice UTF-16, como o TS: o `js-text` ganhou o NFD sem
  as marcas U+0300–U+036F, conferido em cada ponto de código.
- o registro de esportes e a detecção pelo texto (`sports/registry` e
  `sports/detect`): o lookup do nome canônico, os sinais de emoji, texto e
  competição, a liga compartilhada que cede à leitura do item e a decisão a
  partir da IA. Os dados estão em `src/domain/sports/registry-data.json`,
  com o nome canônico como chave (o TS tira dele o tipo `CanonicalSport`); o
  `build.rs` confere a unidade do placar contra o enum fechado do Rust, com o
  `match` exaustivo do que o placar faz com cada uma, e unidade nova não
  compila, como no TS. Paridade com o TS antigo em 540 mil comparações, nos
  dois lados, com a confiança da IA em NaN, ±Infinity e fora de 0 a 1. A
  ponte devolve a decisão em colunas (cabeçalho e evidências), sem JSON.
- o padrão de competições do futebol tinha `[\s\S]*` num lookbehind antes
  do nome da liga, avaliado em cada posição do texto: no `regress`, 34 ms por
  post de 3 KB, quadrático. O lookbehind passou para depois do nome, que tem
  tamanho fixo: diz o mesmo (300 mil textos com os mesmos termos no V8) e só
  é avaliado onde o nome casou, 0,4 ms. Com isso a detecção custa 3,1 ms
  por post de 3 KB no servidor (o TS levava 0,3 ms) e 1,1 ms no navegador;
  roda uma vez por post capturado, não em laço contra o catálogo. Se aparecer
  no perfil do worker, os sinais de palavra viram código Rust.
- seleções, países e competições (`countries` e `national-teams`): as
  tabelas em Rust (a casca remonta as seleções e os países, que o TS ainda
  lê; as competições ficam só no Rust), a tradução do país e da competição e
  a troca do nome do time na seleção. Paridade com o TS antigo em 1,8 milhão
  de comparações, nos dois lados, com as tabelas e a ordem do `Set`
  conferidas. O TS montava um regex com o nome do país (`/i`) e com o nome
  dos dois times (`/iu`) de cada aposta; virou código, com as duas regras de
  caixa separadas: o prefixo do país pela `Canonicalize` sem `u` (o
  `toUpperCase` de cada unidade UTF-16) e o nome do time pela dobra simples
  do `/iu`. A dobra é o `toLowerCase` de um caractere mais 25 exceções
  (`js-text`, `simple_case_fold`), tiradas do V8 sem supor que os pares se
  ligam por maiúscula ou minúscula (ﬅ e ﬆ, ΐ e ΐ não se ligam) e conferidas
  em cada par e em cada ponto de código por `tests/plataforma/js-text.test.ts`.
  No servidor, a troca na seleção ficou 11× mais rápida que o TS (8 µs contra
  94 µs) e 5× no navegador; o país e a competição, 1,5× no servidor e
  empatados ou 2× mais lentos no navegador (3 a 5 µs). O WASM foi a 177 KB
  com gzip (+12 KB). Os mapas do TS eram objetos comuns: "constructor" e
  "__proto__" davam o protótipo (uma função ou um objeto no lugar do texto);
  o Rust devolve o nome, como no `accentuate`.
- qualificador de estatística (`mercados/stat-qualifier`): o vocabulário
  das estatísticas que não são o placar, a unidade do placar por esporte
  (`SCORE_UNIT_RULES`, que a casca remonta para o espelho SQL e o
  `classify`) e os termos do espelho SQL. As regexes montadas das listas são
  fixas (o vocabulário e o registro de esportes), compiladas uma vez e
  conferidas com o V8 no catálogo; o TS montava a de qualificador conhecido
  a cada chamada. Paridade com o TS antigo em 1,6 milhão de comparações, nos
  dois lados, com as listas e os termos SQL iguais e na mesma ordem, e
  geradores dirigidos ao qualificador desconhecido e aos quatro rótulos de
  "ambas recebem cartões", e nas 174 mil chamadas reais do teste de
  coerção sobre os aliases de produção. A alternância de ~200 termos era
  lenta no `regress` (9 µs contra 1 µs do TS por mercado), e o teste da
  coerção sobre os aliases (174 mil chamadas) passou dos 15 s na CI: é
  caminho quente. Três mudanças, todas exatas: as alternativas agrupadas pela
  primeira letra (só para `is_match`, em que a ordem não muda se alguma
  casa), e pré-filtros de texto que as regexes exigem (um dígito ou palavra
  de direção na linha da seleção; "both teams", "ambas" ou "ambos" nos
  rótulos de cartões dos dois times). No servidor ficou 3,4 µs contra 1 µs
  do TS em `hasNonScoreStatQualifier` e empatado nas outras (0,6 a 5 µs);
  nas chamadas reais do teste, 198 ms contra 122 ms do TS, nos três
  esportes. Num texto de 3 KB, 1,4 a 2× o TS (até 0,8 ms), sem crescer além
  do linear; no navegador, de empatado a 2× o TS. O WASM foi a 185 KB com
  gzip (+8,2 KB).
- tamanho do WASM, medido com o binário de 139 KB (gzip) do #23: o `wasm-opt
  -Oz` tira 1,3% e não entra; o `opt-level = "z"` tira 10,6%, mas deixa o
  casamento de confrontos 35% mais lento no navegador (mais que o TS antigo)
  e a soma de dinheiro 17%; fica o `"s"`. O `.wasm` é baixado uma vez por
  release e fica em cache.

Três regras de método saíram desses módulos:

- **Funções de `Math` que o IEEE não fixa** (`pow`, trigonometria) passam pelo
  crate `js-math`: no servidor, o `pow` da glibc, que bateu com o `Math.pow` do
  V8 em 1 milhão de amostras; no navegador, o próprio `Math.pow`, importado
  pelo WebAssembly. O crate `libm`, puro Rust, divergia em 10% das amostras e
  ficou de fora. `sqrt`, `floor`, `abs`, `min` e `max` são exatos e ficam com o
  `f64` do Rust; o `Math.round` do JS (empate para +∞) tem equivalente próprio.
- **Regex com a semântica do `RegExp`** (decisão de 17/11/2026, medida em
  posts e nomes de time reais). No navegador, o próprio `RegExp` do host,
  chamado do WebAssembly: o mesmo motor que o TS usava ali, ~3,5 KB no
  binário e 24% mais lento que o JS puro em 629 regexes do domínio; o
  `regress` no navegador custaria 130 KB com gzip e seria 9× mais lento. No
  servidor, o `regress` (o V8 não está lá; e é o que um worker em Rust sem
  Node usaria), 5 a 6× mais lento que o V8. Por isso o caminho quente
  (normalização e comparação de nomes de time no pareamento) vira Rust
  direto, 3× mais rápido que o V8; o `fancy-regex` empatou com o V8 ali, com a
  semântica Unicode do `\s`, `\w` e `\b`, e ficou de fora. O `/i` sem `u` do
  `regress` diverge do V8 (varrendo todo caractere do BMP que muda de caixa:
  60 sozinhos, como ı, ſ e o grego com iota subscrito, e mais 8 dentro de
  intervalo de classe, como o K de Kelvin e o Ω de Ohm). Por isso o padrão
  vai ao `regress` sem o `i`, com cada letra virando a classe exata do que o
  V8 iguala a ela (a regra `Canonicalize`). Cada backend só executa uma busca; a busca global, a troca com `$`,
  o `split` e o mapa de índices são escritos uma vez, em Rust, pela
  especificação. `tests/plataforma/js-regex.test.ts` compara servidor e
  navegador com o V8 em cada padrão do catálogo do domínio. Onde o JS deixaria
  meia unidade UTF-16 solta (troca sem `u` que parte um emoji), o Rust põe
  U+FFFD, como o `toWellFormed()`: cada chamada assim é lida ao portar.
- **Dado compartilhado com o TypeScript mora no Rust** (17/11/2026), e a
  casca o lê pela ponte uma vez (vocabulário de nomes, `MATCH_SCOPE_NOUNS`,
  `OVER_WORDS`), para não haver duas cópias. O catálogo de mercados, de que o
  TS tira um tipo literal (`MercadoCatalogName`) e que o seed grava, vai para
  um JSON ao lado do módulo, que o TS importa e o Rust lê na compilação.
- **Borda do JavaScript fica na casca.** O que é conversão de valor JS, e não
  regra, continua em TypeScript: `toNumber` (Decimal do Prisma, strings),
  `canonical-json` (protótipos, buracos de array, `Date`, `BigInt`) e os
  seletores de `sumMoneyBy`. A ponte recebe listas inteiras, não um item por
  chamada.

Também pesa na estimativa: funções que recebem callback por item (por
exemplo, `sumMoneyBy(itens, seletor)`) pedem assinatura nova na ponte, com
arrays em vez de uma chamada por item, para a travessia não custar mais que
a conta.

Cada módulo de `src/domain/` é portado para o crate `dominio`, ganha testes em
Rust e passa a delegar pela ponte. O arquivo `.ts` vira uma casca fina com os
mesmos tipos, e os 142 testes continuam passando sem mudar. Funções com muitos
casos ganham arquivos de exemplo em JSON, gerados pelos próprios testes em
TypeScript, que o `cargo test` lê.

Ordem: utilitários (`money`, `decimal-input`, `odds`, `dates`, `text`,
`canonical-json`) → leitura de apostas (`parse-bet-post`, `mercados/`,
`analyzer/`, `bet-legs`) → políticas (captura, stake, frescor, cadências) →
liquidação (`formato-de-resultado`, `manual-settlement`,
`delegated-settlement`, `lucro`) por último.

**Saída:** `src/domain/` é só a ponte; a regra vive em Rust e já roda em
produção dentro dos processos Node.

### Fase 2: worker (~6 a 10 semanas)

- Binário `automabaca-worker` (tokio, sqlx, reqwest, teloxide) num container
  novo no mesmo compose, ao lado do worker Node.
- Ele consome as mesmas filas do pg-boss pelas tabelas dele (`SKIP LOCKED`),
  com a versão do pg-boss fixada enquanto os dois conviverem. A lista de filas
  de cada worker vem do ambiente: virar uma fila é tirá-la de um e pôr no
  outro, e voltar é o inverso.
- Cada fila passa por implementar → sombra (quando tem efeito) → virada.
- Ordem: saúde e manutenção (`health.*`, purgas, `training.close_stale_cases`)
  → integrações de leitura (`closing.*`, `sharp.*`, arquivo de preços) →
  resumos (`pending.digest`, `executive.briefing`, `channels.weekly_digest`) →
  captura (`telegram.*`, `capture.sport_resolve`, OCR e LLMs) → consistência
  (`consistency.*`, `policy.evaluate`) → liquidação (`settlement.*`) por
  último, com pelo menos duas semanas de sombra sem divergência.
- **Saída:** o worker Node é desligado.

### Fase 3: API (~2 a 4 semanas)

- Serviço `automabaca-web` (axum) atrás do Caddy. As rotas de `app/api`
  (`auth`, `bankrolls`, `health`, `logos`, `telegram`, `telemetry`) e as
  leituras do painel (`src/services/painel`) passam uma a uma, por caminho no
  Caddy.
- Sessão compatível: o mesmo cookie HMAC e o mesmo formato `scrypt$salt$hash`,
  para ninguém ser deslogado na virada.
- **Saída:** o Next não acessa mais o banco; só desenha telas com dados da API
  em Rust.

### Fase 4: telas (~4 a 8 semanas)

- **Ponto de decisão no começo:** um protótipo de uma tela em Leptos (SSR com
  hidratação), com o CSS e os tokens de `app/_design`, medindo carregamento e
  esforço contra a versão Next. O dono decide com os números na mão.
- Se seguir, as 12 páginas passam uma a uma pelo Caddy, cada uma aprovada
  pelos specs do Playwright.
- **Saída:** o Next é desligado.

### Fase 5: desligar o Node (~1 a 2 semanas)

- As migrations passam do Prisma para o `sqlx migrate`, com os mesmos arquivos
  SQL e o mesmo hash que o `deploy/migrar.py` e o banco de produção já conferem.
- As imagens deixam de ter Node; o `check.yml`, o `deploy/` e os scripts deixam
  de chamar o npm. O código TypeScript sai do repositório (fica no histórico).

Total estimado: de 4 a 7 meses, revisto para 4,5 a 7,5 no fim da fase 0
(a fase 0 levou um dia, e a fase 1 cresce com o navegador). A estimativa é
refeita no fim de cada fase.

## Riscos e como cada um é contido

| Risco | Contenção |
|---|---|
| Regra de liquidação diferente em Rust | os testes atuais passam contra o Rust (fase 1); sombra de semanas no worker (fase 2) |
| Dois workers pegando o mesmo job | uma fila só tem um dono por vez, pela lista no ambiente; o `SKIP LOCKED` evita dupla execução |
| pg-boss mudar o esquema | versão fixada enquanto Rust e Node convivem |
| Ponte N-API quebrar o build ou o deploy | o binário entra no manifesto e no `verify-release`; a CI gera e testa o mesmo `.node` que vai para a imagem |
| Binário pedir glibc mais nova que a das imagens | o `build:ponte` recusa acima da 2.36 (bookworm), e a CI carrega a ponte dentro da imagem do worker e da base do web |
| Import nomeado da ponte chegar `undefined` no worker | o ESM do Node só vê o default de um CommonJS com `require` dinâmico; a fronteira exige `import dominio from "@automabaca/dominio"` |
| O `.node` chegar ao navegador | a ponte só entra pelo nome do pacote, cuja condição `browser` entrega o WebAssembly (fronteira em `tests/plataforma/architecture-boundaries.test.ts`) |
| Os dois lados da ponte divergirem | mesmos nomes que o `index.d.ts` e mesmos valores (`tests/plataforma/ponte.test.ts`); os testes de quem importa a ponte rodam também contra o WebAssembly (`npm run test:ponte-wasm`, na CI) |
| Projeto parado no meio | cada fase termina com tudo funcionando; parar depois de qualquer uma não deixa nada quebrado |

## Onde o trabalho acontece

A VPS é só produção (ver `AGENTS.md`): compilar Rust nela disputaria CPU e
memória com a produção. O desenvolvimento acontece fora dela, num ambiente que
clona este repositório. A CI roda nos runners do GitHub, que são gratuitos e
sem limite de minutos porque o repositório é público.
