/**
 * O mapa de teclas do painel, escrito uma vez: o handler compara contra a
 * constante, o texto da tela e a folha do `?` derivam dela. Atalho fora da
 * folha o operador conclui que não existe; folha fora do handler ensina o gesto
 * errado. Sem segunda cópia, não há como divergir.
 */

/** Teclas globais, tratadas em `app/(painel)/CommandPalette.tsx`. */
export const TECLA_PALETA = {
  /** Com Ctrl/⌘: abre ou fecha a busca. */
  abrir: "k",
  /** Sozinha: abre a busca. */
  busca: "/",
  /** Sozinha: abre esta folha. */
  folha: "?",
  /**
   * Primeira tecla da sequência de navegação ("G depois D" → Dashboard). Todo
   * `shortcut` do `NAV` abaixo começa por esta letra
   * (`tests/painel/atalhos.test.tsx`), senão a tela ensina um gesto que o handler
   * não escuta.
   */
  navegar: "g",
} as const;

/**
 * Janela da sequência "G depois letra": a paleta a zera depois disso, e as filas
 * de Operações deixam passar a segunda tecla dentro dela.
 */
export const NAV_SEQUENCE_MS = 700;

/** Navegação das filas em foco de Operações, em `screens/operacoes/focus-queue.tsx`. */
export const FOCUS_QUEUE_KEY = {
  /** `KeyboardEvent.key` das setas; o texto da tela é o de `FOCUS_QUEUE_ARROW`. */
  previous: "ArrowLeft",
  next: "ArrowRight",
} as const;

export const FOCUS_QUEUE_ARROW = { previous: "←", next: "→" } as const;

/**
 * Tempo mínimo com o caso em foco antes de aceitar uma ação: o toque duplo que
 * decidiu o caso anterior não decide o seguinte sem ele ter sido lido.
 */
export const FOCUS_QUEUE_ACTION_DELAY_MS = 700;

/** Teclas da fila Vincular, em `screens/operacoes/matching-card.tsx`. */
export const TECLA_MATCHING = {
  ignorar: "i",
  candidatoDe: 1,
  candidatoAte: 9,
} as const;

/** Teclas da fila Homologar (sugestões do IA-Judge), em `screens/operacoes/ia-judge-card.tsx`. */
export const IA_JUDGE_KEY = {
  /** Pede a confirmação antes de liquidar. */
  approve: "a",
  reject: "r",
} as const;

/** Tecla da fila Sharp sem par, em `screens/operacoes/sharp-card.tsx`. */
export const SHARP_KEY = { retry: "r" } as const;

/** "1–9" — travessão, não hífen: é intervalo, e o texto sai daqui e do handler. */
export const FAIXA_DE_CANDIDATOS = `${TECLA_MATCHING.candidatoDe}–${TECLA_MATCHING.candidatoAte}`;

export type Atalho = { teclas: readonly string[]; descricao: string };
export type EscopoDeAtalho = { escopo: string; entradas: readonly Atalho[] };

export const ATALHOS_GERAIS: readonly Atalho[] = [
  { teclas: [`⌘${TECLA_PALETA.abrir.toUpperCase()}`, `Ctrl+${TECLA_PALETA.abrir.toUpperCase()}`], descricao: "Abrir ou fechar a busca" },
  { teclas: [TECLA_PALETA.busca], descricao: "Abrir a busca" },
  { teclas: [TECLA_PALETA.folha], descricao: "Ver esta lista" },
  { teclas: ["↑", "↓"], descricao: "Percorrer os resultados" },
  { teclas: ["Enter"], descricao: "Abrir o resultado em foco" },
  { teclas: ["Esc"], descricao: "Fechar" },
] as const;

/**
 * Atalhos que valem só numa tela. O escopo vai no RÓTULO da seção: a folha é
 * global e lista tudo (é assim que se descobre que a tecla existe), mas dizer
 * onde ela vale evita anunciar um gesto que não funciona onde você está.
 */
export const ATALHOS_POR_TELA: readonly EscopoDeAtalho[] = [
  {
    escopo: "Operações · todas as filas",
    entradas: [
      { teclas: [FOCUS_QUEUE_ARROW.previous, FOCUS_QUEUE_ARROW.next], descricao: "Caso anterior ou próximo" },
    ],
  },
  {
    escopo: "Operações · Vincular",
    entradas: [
      { teclas: [FAIXA_DE_CANDIDATOS], descricao: "Vincular o caso em foco ao candidato" },
      { teclas: [TECLA_MATCHING.ignorar.toUpperCase()], descricao: "Tentar mais tarde" },
    ],
  },
  {
    escopo: "Operações · Homologar",
    entradas: [
      { teclas: [IA_JUDGE_KEY.approve.toUpperCase()], descricao: "Aprovar a sugestão (pede confirmação)" },
      { teclas: [IA_JUDGE_KEY.reject.toUpperCase()], descricao: "Rejeitar a sugestão" },
    ],
  },
  {
    escopo: "Operações · Sharp sem par",
    entradas: [
      { teclas: [SHARP_KEY.retry.toUpperCase()], descricao: "Reprocessar o caso em foco" },
    ],
  },
] as const;

/**
 * Destinos com atalho `G` + letra. Mora aqui junto das outras teclas: é o mesmo
 * conceito ("o mapa de teclas do painel"), e é o array que o `keydown` da paleta
 * consulta — o rótulo `shortcut` NÃO pode ser redigitado em outro lugar.
 */
export const NAV = [
  { id: "nav-dashboard", kind: "Ir", title: "Dashboard", detail: "Resumo geral", href: "/", shortcut: "G D" },
  { id: "nav-bankrolls", kind: "Ir", title: "Tipsters", detail: "Apostas por tipster", href: "/tipsters", shortcut: "G T" },
  { id: "nav-analyzer", kind: "Ir", title: "Analyzer da carteira", detail: "Todos os tipsters, em reais", href: "/analyzer", shortcut: "G A" },
  { id: "nav-contas", kind: "Ir", title: "Contas", detail: "Saldos e movimentações", href: "/contas", shortcut: "G C" },
  { id: "nav-ferramentas", kind: "Ir", title: "Ferramentas", detail: "Utilitários", href: "/ferramentas", shortcut: "G F" },
  { id: "nav-operacoes", kind: "Ir", title: "Operações", detail: "Decisões e exceções", href: "/operacoes", shortcut: "G O" },
  { id: "nav-monitoramento", kind: "Ir", title: "Monitoramento", detail: "Saúde do motor e providers", href: "/monitoramento", shortcut: "G M" },
  { id: "nav-config", kind: "Ir", title: "Configurações", detail: "Identidade, segurança e integrações", href: "/config", shortcut: "G S" },
] as const;
