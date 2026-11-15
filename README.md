# AutomaBACA

Painel web (Next.js) e worker (Node.js) que capturam apostas de canais do
Telegram, conferem preço e resultado em fornecedores de odds e mantêm a
contabilidade das bancas. Os dois processos compartilham PostgreSQL (via Prisma)
e as filas do pg-boss.

Produção: <https://v2.fraudicio.com.br>, na VPS `hermes`.

## Documentação

| Para | Leia |
|---|---|
| Qualquer IA ou pessoa que vá mexer no código | [AGENTS.md](AGENTS.md): onde trabalhar, regras e o que não fazer |
| Entender a arquitetura e os invariantes | [BLUEPRINT.md](BLUEPRINT.md) |
| Publicar em produção | [docs/RELEASE.md](docs/RELEASE.md) |
| Configuração do servidor, timers e backups | [deploy/README.md](deploy/README.md) |
| Logs, correlação, alertas e SLO | [docs/OBSERVABILIDADE.md](docs/OBSERVABILIDADE.md) |
| Subir tudo noutra máquina depois de um desastre | [docs/RECUPERACAO.md](docs/RECUPERACAO.md) |
| O que o servidor guarda e por quanto tempo | [docs/RETENCAO.md](docs/RETENCAO.md) |
| Interface e componentes | [docs/DESIGN.md](docs/DESIGN.md) |
| Desempenho do painel e guardas de escala | [docs/DESEMPENHO.md](docs/DESEMPENHO.md) |
| Medir modelos de IA na leitura de apostas (`npm run bench:leitura`) | [docs/BENCH-LEITURA.md](docs/BENCH-LEITURA.md) |
| Ligar o agente do dono (MCP) que resolve as pendências | [docs/FUNCIONARIO-IA.md](docs/FUNCIONARIO-IA.md) |
| Plano da migração para Rust, em fases | [docs/MIGRACAO-RUST.md](docs/MIGRACAO-RUST.md) |

## Onde cada coisa roda

| | Onde |
|---|---|
| Desenvolvimento | PC do dono, WSL2 (`Ubuntu-24.04`), em `~/code/automabaca-novo` |
| CI | runners hospedados do GitHub (`ubuntu-24.04`), na cota de minutos do plano; ver o topo de `.github/workflows/check.yml` |
| Imagens | `ghcr.io/fraudicioschimidt/automabaca-novo-{web,worker}:<commit>`, publicadas pela CI |
| Produção | VPS `hermes`: containers web, worker e PostgreSQL, atrás do Caddy |
| Cópias de backup e logs | PC do dono, puxadas da VPS por tarefas do Windows; ver `deploy/README.md` |

A VPS é só produção. Não se desenvolve nem se roda teste lá.

## Primeira vez numa máquina

Requisitos: Linux ou WSL2 (os scripts são Bash), Docker acessível ao usuário
normal, **Node 24.20.0 e npm 11.19.0**. A versão está fixada em `.node-version`,
`.nvmrc` e `packageManager`, e o próprio `npm install` recusa outra
(`scripts/check-toolchain.mjs`, rodado no `preinstall`).

```bash
git clone https://github.com/fraudicioschimidt/automabaca-novo.git
cd automabaca-novo
npm run dev:setup      # cria .env local, sobe os bancos, instala, migra e popula
npm run dev:local      # web + worker em http://127.0.0.1:3100
npm run dev:demo       # opcional: 8 tipsters, ~400 apostas e as filas, o motor e os incidentes de Operações e Monitoramento no banco local (re-rodável)
```

`dev:setup` sobe dois PostgreSQL pelo `docker-compose.dev.yml`: desenvolvimento
na porta 5432 e testes na 5433 (em RAM, recriado a cada suíte). Os dois usam a
mesma imagem da produção, porque a ordenação de texto do Alpine (musl) difere
da do Debian (glibc). `npm run dev:setup -- --with-browser` instala também o
Chromium do Playwright.

O `.env` gerado tem só valores locais. **Não coloque tokens de produção nele**:
um bot do Telegram com o mesmo token disputaria as mensagens com a produção.
Para testar com um bot próprio, o worker exige `TELEGRAM_WEBHOOK_URL` e
`TELEGRAM_WEBHOOK_SECRET` junto do token: não há long-polling, então é preciso
um túnel HTTPS até o `/api/telegram/webhook` local.
Variáveis e o que cada uma liga estão comentadas em `.env.example`.

## Dia a dia

```bash
npm run check:fast                 # só o que a mudança afeta: lint, tipos, testes relacionados
npm run check:ci                   # a metade estática do job `verificações` da CI: lint, tipos, código morto, segredos, unitários
npm run test:unit      # unitários
npm run test:db        # testes com PostgreSQL (banco da porta 5433)
npm run check                      # check:ci + testes com PostgreSQL
npm run test:browser:local         # Playwright contra uma instância E2E isolada
npm run test:coverage              # relatório de cobertura (não é gate)
```

Os testes de banco e de navegador **recusam** rodar sem `TEST_DATABASE_URL`, para
nunca caírem no banco de desenvolvimento ou de produção.

Os testes ficam em `tests/<área>/`, pela área do código: `dinheiro`, `liquidacao`,
`captura`, `apostas`, `identidade`, `providers`, `operacao`, `painel`,
`seguranca` e `plataforma`. `*.db.test.ts` vai para o projeto `db`; o resto,
para o `unit`. Compartilhados ficam em `tests/helpers/` e `tests/fixtures/`, e o
Playwright em `tests/browser/`.

Interface: `npm run test:ui` (smoke) e `npm run test:a11y`. O Playwright
(1.61.1) está fixado junto da imagem Docker em
`scripts/run-playwright-canonical.sh`: atualize os dois juntos.

## CI

O workflow `check` roda em todo PR e em todo push na `main`: checagens
estáticas e unitários, testes de banco, build, fluxos críticos e o smoke
das telas (desktop) no navegador e, na `main`, a publicação das imagens no
ghcr.io. O job *release verificada* só passa com todos os outros verdes. A `main` é protegida: só entra
por PR com a CI verde.

## Build e artefatos

`npm ci` instala exatamente o `package-lock.json` e gera o client Prisma; não
precisa de banco nem de `.env`. `npm run build` compila web e worker com
configuração temporária (sem segredos nem migrations) e verifica o standalone. Saem:

- `.next/standalone/`: a web, com os próprios assets e dependências;
- `dist/worker.mjs`;
- `dist/worker-runtime/` (depois de `npm run package:worker`): o worker só com
  as dependências que usa, conferidas contra o lockfile. É o contexto da
  imagem do worker.

O seed (`npm run prisma:seed`) é só do banco de desenvolvimento e recusa rodar
em produção; lá, o catálogo de mercados chega pelo `ops-sincronizar-mercados`,
que simula antes e audita.

A imagem do worker não traz o CLI de migrations. Migrations rodam do checkout
completo (`npm run prisma:deploy`), com `DATABASE_URL_ADMIN`: em produção,
web e worker usam uma role sem superuser em `DATABASE_URL`.

Nenhum `.env` acompanha o build. O runtime recebe as variáveis por injeção e
falha no boot se faltar alguma obrigatória (validação em `src/infra/env.ts`).

Instale e compile no mesmo sistema e arquitetura do runtime. Não use `--force`,
`--legacy-peer-deps` nem `--omit=optional`, e não copie `node_modules` de outro
sistema: Sharp, SWC e esbuild dependem dos pacotes opcionais nativos.

## Dependências

- O Dependabot abre um PR por semana com todas as atualizações minor e patch
  do npm (grupo `npm-minor-patch`) e outro com as das actions; major vem à
  parte. Toda mudança de dependência vem com o lockfile. A CI de um PR do
  Dependabot só roda depois do rótulo `dependencias-revisadas` (AGENTS.md).
- `npm run security:audit` (no gate) reprova vulnerabilidade alta ou crítica em
  dependência de produção.
- `overrides` e `allowScripts` ficam no `package.json`. Os scripts de instalação
  aprovados são os de versões exatas de Prisma/engines, esbuild e unrs-resolver.
  Ao atualizar um deles, revise o script do pacote e aprove com
  `npm install-scripts approve <pacote>`; não use aprovação global.
- TypeScript fica na linha 6 enquanto o parser do ESLint não aceitar a 7.

## Publicar

Todo merge com código na `main` é publicado, sem consulta ao dono (ver AGENTS.md):

```bash
ssh hermes 'bash /srv/apps/automabaca-novo/source/deploy/publicar.sh --nome <assunto> --commit <sha>'
```

O passo a passo, as guardas e o que fazer quando uma delas recusa estão em
[docs/RELEASE.md](docs/RELEASE.md).
