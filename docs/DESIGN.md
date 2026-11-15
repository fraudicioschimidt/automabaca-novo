# Design e experiência

A linguagem atual é **Refino**: interface sóbria, densa quando necessário e
orientada à decisão diária. Este documento define princípios e o uso do kit;
valores concretos vivem no código.

## Fontes de verdade

| Elemento | SSOT |
| --- | --- |
| cores, espaços, raios, sombras e escala tipográfica | `app/_design/theme.ts` |
| tokens CSS (movimento) e base global | `app/globals.css` |
| tema em tempo de execução | `app/_design/kit/context.tsx` (`DesignProvider`, `useDesign`) |
| primitives e padrões | `app/_design/kit/` |
| ícones | `app/_design/kit/icons.tsx` |
| aviso transitório (toast) | `app/_design/toast.ts` |
| navegação e composição | `app/_design/AppSidebar.tsx` e `app/_design/DesignScreen.tsx` |
| telas | `app/_design/screens/` |
| fluxos no navegador | `tests/browser/` |

Não copie tabelas de pixels para Markdown. Mudança de token acontece no SSOT e
nos consumidores.

## Princípios

- Hierarquia vem de espaço, contraste e tipografia, não de decoração gratuita.
- Número financeiro mostra unidade, sinal e período sem ambiguidade.
- Ausência, loading, erro, stale e zero são estados diferentes.
- Informação densa continua escaneável; detalhe abre sem trocar a base do
  agregado.
- Ação perigosa exige rótulo explícito, confirmação proporcional e foco seguro.
- Cor nunca é o único portador de significado.
- Texto de interface é curto, direto e consistente com o vocabulário do domínio.
- Desktop, tablet e mobile são produtos utilizáveis, não simples escalas.

## Tema

O `DesignScreen` embrulha cada tela no `DesignProvider`. Componente nenhum
recebe o tema por prop: lê de `useDesign()`, que devolve `T` (tokens do modo
atual), `mode`, `setMode`, `numFont` (Geist Mono tabular, para todo número) e
`ink(valor, base?)` (cor pelo sinal). Fora da árvore das telas (erro, loading,
404) use `getTheme(mode)`.

A escala tipográfica (`T.type.*`) é de **forma** (família, tamanho, peso,
espaçamento); a cor vem dos tokens de cor. Estilo novo que se repete vira
entrada da escala em `theme.ts`, não literal na tela.

## Kit

Importe cada primitive do seu módulo (não há barril):

| Módulo | Conteúdo |
| --- | --- |
| `kit/primitives` | `AppShell`, `Panel`, `Cap`, `Btn`, `Badge`, `ModalSurface`, `ProductEmptyState`, `DataGrid` |
| `kit/icons` | `ICONS` (paths 20×20) e `Icon` |
| `kit/Tooltip` | explicação curta acessível por ponteiro, toque e teclado |
| `kit/MetricaComDefinicao` | rótulo de métrica com a definição de `lib/definicoes-de-metrica` |
| `kit/ModalForm` | formulário modal com foco, Escape e estados consistentes |
| `kit/overlay-sheet` | gaveta modal (`Sheet`) |
| `kit/Skeleton` | carregamento sem inventar conteúdo (`Skeleton`, `SkeletonRegiao`) |
| `kit/SegmentNav` | navegação segmentada com contador de significado declarado |
| `kit/Tecla` | atalho anunciado a partir de `lib/atalhos` |
| `kit/TrilhoComSinal` | barra cujo sinal e direção precisam ficar explícitos |
| `kit/FrescorDosDados` | de quando é o dado exibido |

Reutilize o kit antes de criar variação local. Componente novo deve:

1. resolver um padrão recorrente (variação entra no kit só com uso recorrente);
2. aceitar estado vazio, loading, erro e disabled quando aplicáveis;
3. usar tokens, não valor solto;
4. preservar nome acessível, foco visível, Escape e retorno de foco;
5. funcionar em tema claro e escuro, e no mobile (modal e sheet bloqueiam o fundo);
6. ser definido no nível do módulo, nunca dentro de um render (remontar a cada
   render perde foco e estado);
7. possuir prova proporcional ao risco.

Tooltip complementa o rótulo; não esconde informação necessária à ação.
Componente de métrica declara unidade, sinal, janela e base quando aplicável.

## Dados de demonstração

`app/_design/mock/` tem fixtures na forma exata dos adaptadores (o tipo vem do
adaptador; o mock é que se ajusta). Só entram com `?mock=1` em desenvolvimento
ou no modo visual isolado (`allowMockQuery`), por import dinâmico na página;
nenhum módulo de produção os importa (`tests/plataforma/runtime-contracts.test.ts`).

## Validação de interface

Conforme a mudança, confira:

- desktop e mobile;
- claro e escuro;
- navegação por teclado e ordem de foco;
- contraste, nome acessível e mensagem de erro;
- conteúdo longo, lista vazia, carregamento e falha;
- build de produção e CSP.

Comandos usuais:

```bash
npm run test:ui     # smoke
npm run test:a11y
```

E revisão visual manual da mudança, nos dois temas e em desktop e mobile.

Refatoração que não deve mudar a tela: `npm run test:markup [ref-base]` (padrão
`origin/main`, fora da CI) gera o HTML de cada tela, aba e estado com os mocks,
em 390/1440 e nos dois temas, na árvore atual e na base, e resume o `diff`
(saída 0 = idêntico). Tela, aba ou overlay novo entra em `VARIANTS` de
`tests/painel/markup-das-telas.test.tsx`.


## Ações e leituras na Config

A criação de tipster só acrescenta uma linha após a confirmação: durante o
pedido, o formulário fica bloqueado; uma recusa preserva os valores digitados.
O envio de logo pode continuar após fechar o modal, mas só muda a lista daquele
tipster e o formulário que iniciou o envio. URLs de prévia são liberadas ao
terminar o envio real, ou ao desmontar o protótipo local.

A edição de aliases aguarda a confirmação, com uma mutação por mercado em
andamento. A lista usa `normalizeMercadoKey`, como o cadastro no servidor:
reenviar outra grafia do mesmo alias troca o texto existente. A recusa mantém o
texto digitado. Revogações de sessões também acontecem uma por vez, para manter
a lista e o contador coerentes.

A busca de times descarta páginas do filtro anterior. Se a primeira página do
filtro novo falhar, a lista anterior permanece com aviso e não pode paginar
usando o filtro novo. A situação do pareamento é consultada a cada 10 s, com
uma leitura por vez e prazo de cinco minutos, mesmo com uma resposta travada.
Na curadoria de jogadores, a releitura usa a busca atual e descarta respostas
superadas. Uma leitura bem-sucedida limpa a falha de leitura anterior.

As simulações ficam nos testes de `use-bancas`, `use-markets`, `use-team-cards`,
`players-card` e `security-card` em `tests/painel/`. O contrato de normalização
é conferido com PostgreSQL em `actions-config.db.test.ts`; a criação recusada,
a recuperação do formulário e a edição/remoção do alias são exercitadas no
build de produção em `tests/browser/config.spec.ts`.
