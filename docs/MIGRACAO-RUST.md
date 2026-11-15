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
   estimativa acima supõe: pipeline e teste do WASM, inicialização síncrona
   no cliente e o tamanho do pacote nas telas.
2. Uma ponte só, em WebAssembly, nos dois lados. Um binário a menos para
   conferir, mas a chamada fica mais cara que a N-API no worker.
3. Portar primeiro só o que roda no servidor (52 arquivos, 6,4 mil linhas) e
   deixar o resto para a fase 4, quando as telas saírem do Next. Cabe nas 3 a
   5 semanas, mas o domínio fica em duas linguagens até lá.

**Escolhido em 15/11/2026: caminho 1.** A ponte `@automabaca/dominio`
(`rust/crates/ponte`) entrega o `.node` ao servidor e o WebAssembly ao
navegador pela condição `browser` do pacote; o WASM é compilado de forma
síncrona na carga, e a CSP ganhou `'wasm-unsafe-eval'` no `script-src`, que
libera só isso. Andamento:

- ponte única, com os testes dos dois lados (#13);
- `kelly` (calculadora de Ferramentas), o primeiro módulo que roda no
  navegador: +31,6 KB com gzip só em `/ferramentas` e ~3 ms de compilação do
  WASM na carga (#14).

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
