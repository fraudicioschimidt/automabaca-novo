// @vitest-environment jsdom
/**
 * Rede de regressão de markup das telas do painel, sob demanda (fora da CI).
 * Renderiza cada tela com os mocks de `app/_design/mock` dentro do
 * `DesignScreen`, em 390/1440 e claro/escuro, com abas, overlays e estados
 * alcançados por clique, e grava um HTML por variante em `$MARKUP_OUT`.
 * Relógio, `Math.random`, `crypto.randomUUID` e ids do React são fixos: duas
 * execuções do mesmo código geram arquivos idênticos.
 *
 * Uso: `npm run test:markup [ref-base]` compara a árvore atual (HEAD e o que
 * não foi commitado) com a ref (padrão `origin/main`). Direto: `MARKUP_OUT=<dir> npx vitest run --project unit tests/painel/markup-das-telas.test.tsx`.
 */
import { act, type ComponentType, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => {
  const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
  return {
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => "/",
  };
});

import { DesignScreen } from "@/app/_design/DesignScreen";
import { AppSidebar } from "@/app/_design/AppSidebar";
import { DashboardScreen } from "@/app/_design/screens/DashboardScreen";
import { BankrollsScreen } from "@/app/_design/screens/BankrollsScreen";
import { BankrollScreen } from "@/app/_design/screens/BankrollScreen";
import { AnalyzerScreen } from "@/app/_design/screens/AnalyzerScreen";
import { ContasScreen } from "@/app/_design/screens/ContasScreen";
import { FerramentasScreen } from "@/app/_design/screens/FerramentasScreen";
import { MonitoramentoScreen } from "@/app/_design/screens/MonitoramentoScreen";
import { OperacoesScreen } from "@/app/_design/screens/OperacoesScreen";
import { ApostaScreen } from "@/app/_design/screens/ApostaScreen";
import { ConfigScreen } from "@/app/_design/screens/ConfigScreen";
import { TIP, BANKROLLS_TIP } from "@/app/_design/mock/dashboard";
import { BANKROLL_MOCK_DATA } from "@/app/_design/mock/bankroll-data";
import { ANALYZER_MOCK_DATA, ANALYZER_PORTFOLIO_MOCK_DATA } from "@/app/_design/mock/analyzer-data";
import { ACC, EMPTY_ACC } from "@/app/_design/mock/contas";
import { TOOLS } from "@/app/_design/mock/tools";
import { MONITORAMENTO_MOCK, OPERACOES_MOCK } from "@/app/_design/mock/operacoes";
import { BETS, CAPTURA, SETTLEMENT_CARDS, TRILHA } from "@/app/_design/mock/bet";
import { CFG } from "@/app/_design/mock/config";
import { parseAnalyzerQuery } from "@/src/domain/analyzer-query";
import type { loadPlayersAction } from "@/app/(painel)/config/player-actions";

type Mode = "light" | "dark";
const WIDTHS = [1440, 390] as const;
const MODES: Mode[] = ["light", "dark"];
const OUT = process.env.MARKUP_OUT;

// Callbacks: no-op; as mutações e os "load*" devolvem promessa que nunca
// resolve, para o estado capturado não depender de tempo.
const noop = () => undefined;
const never = () => new Promise<never>(() => {});

type Tela = (mode: Mode) => ReactElement;

/** A tela como a `page.tsx`/`*Client.tsx` monta: `DesignScreen` com a tela e as props próprias. */
function tela<P extends object>(Screen: ComponentType<P>, extraProps: P): Tela {
  function Moldura({ mode }: { mode: Mode }) {
    return <DesignScreen initialMode={mode}><Screen {...extraProps} /></DesignScreen>;
  }
  return (mode) => <Moldura mode={mode} />;
}

/** Ids do useId (`_r_5_`, `_R_2h_`; formatos antigos `:r0:`/`«r0»`) viram sequência por arquivo. */
function normalize(html: string): string {
  const map = new Map<string, string>();
  return html.replace(/_[rR]_[0-9a-zA-Z]+_|:[rR][0-9a-zA-Z]+:|«[rR][0-9a-zA-Z]+»/g, (m) => {
    if (!map.has(m)) map.set(m, `_id${map.size}_`);
    return map.get(m)!;
  });
}

const written: string[] = [];
function save(name: string, html: string) {
  expect(html.length).toBeGreaterThan(0);
  written.push(name);
  mkdirSync(OUT!, { recursive: true });
  // Uma tag por linha: o `diff` entre duas execuções aponta o elemento que mudou.
  writeFileSync(join(OUT!, `${name}.html`), `${normalize(html).replaceAll("><", ">\n<")}\n`);
}

async function tick(ms = 4) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Espera lazy/dynamic/effects assentarem: HTML estável por vários ciclos. */
async function settle() {
  let prev = "";
  let stable = 0;
  for (let i = 0; i < 400 && stable < 6; i++) {
    await tick();
    const html = document.body.innerHTML;
    const loading = /Carregando/.test(html);
    if (html === prev && !loading) stable++;
    else if (html === prev && loading) stable += 0.25; // carregamento legítimo (promessa que nunca resolve)
    else { stable = 0; prev = html; }
  }
}

type Step = (doc: Document) => void;

function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`alvo não encontrado: ${what}`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
function byText(sel: string, text: string, root: ParentNode = document): Element | undefined {
  const all = [...root.querySelectorAll(sel)];
  return all.find((n) => n.textContent?.trim() === text) ?? all.find((n) => n.textContent?.includes(text));
}
const clickText = (sel: string, text: string): Step => () => click(byText(sel, text), `${sel} "${text}"`);
const clickSel = (sel: string): Step => (doc) => click(doc.querySelector(sel), sel);

/** O toast do DesignScreen fica fora da tela e só existe no 1º caso do arquivo. */
function capture(): string {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelector("#__toast_root")?.remove();
  return body.innerHTML;
}

async function mountAndCapture(ui: ReactElement, { storage = {}, steps = [], esperaMs = 0 }: Pick<Variant, "storage" | "steps" | "esperaMs">): Promise<string> {
  localStorage.clear();
  for (const [k, v] of Object.entries(storage)) localStorage.setItem(`automabaca:ui:${k}`, JSON.stringify(v));
  for (const node of [...document.body.childNodes]) if ((node as Element).id !== "__toast_root") node.remove();
  document.body.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  await settle();
  // Passo sem alvo (rótulo trocado, botão removido) vira marca no arquivo em
  // vez de derrubar a geração: o diff com a base mostra onde.
  let falha = "";
  for (const step of steps) {
    try {
      step(document);
    } catch (e) {
      falha = `<!-- passo não executado: ${e instanceof Error ? e.message : String(e)} -->\n`;
      break;
    }
    await settle();
  }
  if (esperaMs) {
    await tick(esperaMs);
    await settle();
  }
  const html = falha + capture();
  await act(async () => {
    root.unmount();
  });
  return html;
}

/** Largura da janela: o `DesignScreen` e as media queries leem daqui. */
let viewport = 1440;
function setViewport(w: number) {
  viewport = w;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
}
function mediaMatches(query: string): boolean {
  const max = /max-width:\s*(\d+)px/.exec(query);
  const min = /min-width:\s*(\d+)px/.exec(query);
  if (!max && !min) return false;
  return (!max || viewport <= Number(max[1])) && (!min || viewport >= Number(min[1]));
}

type Variant = {
  screen: string;
  variant: string;
  ui: Tela;
  storage?: Record<string, unknown>;
  steps?: Step[];
  /** Também grava o HTML do servidor (renderToStaticMarkup, sem effects). */
  ssr?: boolean;
  widths?: readonly number[];
  /** Espera extra depois dos passos, para carregamentos com debounce. */
  esperaMs?: number;
};

const bankrollActions = {
  onFetchClosing: never, onSettleBet: never, onDeleteBet: never, onExportCsv: never,
  onRegisterBet: never, onChangeSharpMode: never,
  onPreviewRemoval: never, onRemoveBets: never, onRestoreBets: never,
};
const contasActions = { onRefresh: noop, onMovimentar: never, onCriar: never, onEditar: never, onStatus: never, onRemover: never };
const opsActions = {
  onSettle: never, onApproveIaJudge: never, onRejectIaJudge: never, onResolveMatch: never, onIgnoreMatch: never, onRetrySharp: never,
};
const monActions = { onReplayJob: never, onAcknowledgeAction: never, onResolveAction: never, onRetryChannelTransient: never, onCaptureDiscardedPost: never };
const configActions = {
  onLoadTeamCards: never, onRemoveTipsterName: never, onLoadPlayers: never,
  onPlayerCommand: never, onCreateBanca: never, onEditBanca: never, onRemoveBanca: never, onAddAlias: never,
  onRemoveAlias: never, onUploadLogo: never, onRemoveLogo: never, onRevokeSession: never, onRevokeOtherSessions: never,
  onRequestCatalogPairing: never, onLoadCatalogPairing: never,
};

const ANALYZER_TABS = ["overview", "clv", "steam", "timing", "liquidez", "segmentos", "casas", "periodo", "simulador"];
const analyzer = { slug: "main", bkId: null, data: ANALYZER_MOCK_DATA, onQueryChange: null, queryPending: false };
const carteira = { slug: null, bkId: null, data: ANALYZER_PORTFOLIO_MOCK_DATA, onQueryChange: null, queryPending: false };
// Modo servidor: `query` e, para histórico extenso, o resumo paginado.
const analyzerServidor = { ...ANALYZER_MOCK_DATA, query: parseAnalyzerQuery(), largeHistory: null };
const analyzerExtenso = {
  ...ANALYZER_MOCK_DATA,
  query: parseAnalyzerQuery({ pagina: "2" }),
  largeHistory: {
    firstDate: new Date("2025-01-02T12:00:00Z"), lastDate: new Date("2026-06-13T12:00:00Z"),
    firstDay: "2025-01-02", lastDay: "2026-06-13",
    total: 1234, resolved: 1200, pending: 34, stake: 2400, profit: 180.5, roi: 7.52,
    page: 2, pages: 25, rows: ANALYZER_MOCK_DATA.bets.slice(0, 8),
  },
};
// Carregamentos da Config: páginas sintéticas pequenas, na forma das actions.
type Players = Awaited<ReturnType<typeof loadPlayersAction>>;
const PLAYERS: Players = {
  players: [{ id: "player-1", name: "Rafael Azul", providerPlayerId: "fs-101", aliases: [
    { id: "palias-1", name: "R. Azul", provider: "LOCAL", source: "MANUAL" },
    { id: "palias-2", name: "Rafael Azul", provider: "FLASHSCORE", source: "AUTO" },
  ] }],
  pending: [{
    betId: "bet-prop-1", evento: "Azul FC vs Verde EC", selecao: "Rafael Azul Mais de 1,5 finalizações", competicao: "Liga Azul",
    bankrollId: "b1", identityId: null, evidence: { reason: "jogador_ambiguo" },
    terms: { version: 1, jogador: "Rafael Azul", time: "Azul FC", family: "shots_total", direction: "over", lineQuarters: 6, period: "FT",
      mercadoOriginal: "Finalizações do jogador", selecaoOriginal: "Mais de 1,5", substituicao: "UNKNOWN", evidencia: "Legenda do print." },
    candidates: [{ id: "player-1", name: "Rafael Azul", teamId: "fs-team-1" }],
  }],
  corrections: [{ betId: "bet-prop-2", evento: "Azul FC vs Verde EC", selecao: "Rafael Azul Menos de 0,5 cartões", status: "LOST",
    evidence: { correctionReview: true } }],
  bankrolls: [{ id: "b1", nome: "Big Data", sharpMode: "IDENTITY_ONLY", imageStakeAsUnits: true, playerPropsAutoSettlement: false,
    validatedBets: 7, validatedCompetitions: 2, unexplained: false }],
};
const config = { data: CFG, canManage: true, ...configActions };
const configCarregada = { ...config, onLoadPlayers: () => Promise.resolve(PLAYERS) };

const bankroll = { data: BANKROLL_MOCK_DATA, emptyState: false, canManage: true, ...bankrollActions };
// O relógio parado do `beforeAll`.
const FROZEN_NOW = new Date("2026-09-20T15:00:00Z");
const conta0 = ACC.accounts[0]?.id ?? null;

const VARIANTS: Variant[] = [
  { screen: "sidebar", variant: "dashboard", ui: tela(() => <AppSidebar active="Dashboard" />, {}), ssr: true, widths: [1440] },
  { screen: "sidebar", variant: "drawer", ui: tela(() => <AppSidebar active="Operações" />, {}), widths: [390],
    steps: [clickSel('button[aria-label="Abrir menu"]')] },
  { screen: "sidebar", variant: "menu-do-usuario", ui: tela(() => <AppSidebar active="Dashboard" />, {}), widths: [1440],
    steps: [clickSel("[data-user-trigger]")] },
  { screen: "sidebar", variant: "drawer-dashboard", ui: tela(DashboardScreen, { data: TIP }), widths: [390],
    steps: [clickSel('button[aria-label="Abrir menu"]')] },

  // Dashboard e bancas
  { screen: "dashboard", variant: "mock", ui: tela(DashboardScreen, { data: TIP }), ssr: true },
  { screen: "dashboard", variant: "alertas", ui: tela(DashboardScreen, { data: TIP }), steps: [clickSel('button[aria-label="Alertas"]')] },
  { screen: "bankrolls", variant: "mock", ui: tela(BankrollsScreen, { data: BANKROLLS_TIP }), ssr: true },

  // Banca
  { screen: "bankroll", variant: "mock", ui: tela(BankrollScreen, bankroll), ssr: true },
  { screen: "bankroll", variant: "semacoes", ui: tela(BankrollScreen, { data: BANKROLL_MOCK_DATA, emptyState: false }) },
  { screen: "bankroll", variant: "vazia", ui: tela(BankrollScreen, { ...bankroll, emptyState: true }) },
  ...(["estatisticas", "calendario", "compartilhar", "adicionar"] as const).map((ov): Variant => ({
    screen: "bankroll", variant: `overlay-${ov}`, ui: tela(BankrollScreen, bankroll),
    steps: [clickText("button", { estatisticas: "Estatísticas", calendario: "Calendário", compartilhar: "Compartilhar", adicionar: "Adicionar aposta" }[ov])],
  })),
  { screen: "bankroll", variant: "filtros", ui: tela(BankrollScreen, bankroll), steps: [clickText("button", "Filtros")] },
  { screen: "bankroll", variant: "selecionar", ui: tela(BankrollScreen, bankroll), steps: [clickText("button", "Selecionar")] },
  { screen: "bankroll", variant: "trocar-banca", ui: tela(BankrollScreen, bankroll), steps: [clickSel("[data-bk-pop] > button")] },
  { screen: "bankroll", variant: "modo-sharp", ui: tela(BankrollScreen, bankroll), steps: [clickSel("[data-sharp-pop] > button")] },
  { screen: "bankroll", variant: "aposta-aberta", ui: tela(BankrollScreen, bankroll),
    steps: [clickSel('button[aria-label^="Expandir detalhes"]'), clickText("button", "de onde veio?")] },
  { screen: "bankroll", variant: "menu-resultado", ui: tela(BankrollScreen, bankroll), steps: [clickSel('button[aria-label^="Alterar resultado"]')] },
  { screen: "bankroll", variant: "liquidacao-recusada",
    ui: tela(BankrollScreen, { ...bankroll, onSettleBet: () => Promise.reject(new Error("Falha sintética ao liquidar.")) }),
    steps: [clickSel('button[aria-label^="Alterar resultado"]'), clickSel('[role="dialog"][aria-label="Alterar resultado"] button')] },
  ...["pendentes", "ganhas", "perdidas", "removidas"].map((tab): Variant => ({
    screen: "bankroll", variant: `historico-${tab}`, ui: tela(BankrollScreen, bankroll), storage: { "refino:tab": tab },
  })),

  // Analyzer
  ...ANALYZER_TABS.map((tab): Variant => ({
    screen: "analyzer", variant: `tab-${tab}`, ui: tela(AnalyzerScreen, analyzer),
    storage: { "analyzer:tab": tab }, ssr: tab === "overview",
  })),
  ...["mercado", "competicao", "pais"].map((seg): Variant => ({
    screen: "analyzer", variant: `segmentos-${seg}`, ui: tela(AnalyzerScreen, analyzer),
    storage: { "analyzer:tab": "segmentos", "analyzer:seg": seg },
  })),
  ...["90d", "30d", "7d", "hoje"].map((range): Variant => ({
    screen: "analyzer", variant: `overview-${range}`, ui: tela(AnalyzerScreen, analyzer),
    storage: { "analyzer:tab": "overview", "analyzer:range": range },
  })),
  { screen: "analyzer", variant: "gaveta", ui: tela(AnalyzerScreen, analyzer),
    storage: { "analyzer:tab": "segmentos" }, steps: [clickSel('[aria-label="Tabela de dados"] button')] },
  { screen: "analyzer", variant: "sem-dados", ui: tela(AnalyzerScreen, { slug: null, bkId: null, data: null }) },
  { screen: "analyzer", variant: "servidor", ui: tela(AnalyzerScreen, { ...analyzer, data: analyzerServidor, onQueryChange: noop }), ssr: true },
  { screen: "analyzer", variant: "historico-extenso", ui: tela(AnalyzerScreen, { ...analyzer, data: analyzerExtenso, onQueryChange: noop }), ssr: true },
  // Carteira: todas as bancas, dinheiro em reais, dimensão Canal com matriz e cortes.
  { screen: "carteira", variant: "tab-overview", ui: tela(AnalyzerScreen, carteira), storage: { "analyzer:tab": "overview" }, ssr: true },
  { screen: "carteira", variant: "segmentos-canal", ui: tela(AnalyzerScreen, carteira), storage: { "analyzer:tab": "segmentos" } },
  { screen: "carteira", variant: "simulador", ui: tela(AnalyzerScreen, carteira), storage: { "analyzer:tab": "simulador" } },
  { screen: "carteira", variant: "gaveta-do-corte", ui: tela(AnalyzerScreen, carteira), storage: { "analyzer:tab": "segmentos" },
    steps: [clickSel('[aria-label="Matriz canal × mercado"] button[aria-label*="corte sugerido"]')] },

  // Contas
  { screen: "contas", variant: "lista", ui: tela(ContasScreen, { data: ACC, accId: null, canManage: true, ...contasActions }), ssr: true },
  { screen: "contas", variant: "lista-mock", ui: tela(ContasScreen, { data: ACC, accId: null }) },
  { screen: "contas", variant: "detalhe", ui: tela(ContasScreen, { data: ACC, accId: conta0, canManage: true, ...contasActions }), ssr: true },
  { screen: "contas", variant: "saldo-negativo", ssr: true, ui: tela(ContasScreen, {
    data: { ...ACC, accounts: ACC.accounts.map((a, i) => i === 0 ? { ...a, balance: -123.45 } : a), summary: { ...ACC.summary, saldo: -123.45 } },
    accId: null, canManage: true, ...contasActions }) },
  { screen: "contas", variant: "vazio", ui: tela(ContasScreen, { data: EMPTY_ACC, accId: null, canManage: true, ...contasActions }) },
  { screen: "contas", variant: "agrupar", ui: tela(ContasScreen, { data: ACC, accId: null, canManage: true, ...contasActions }),
    steps: [clickSel('button[aria-pressed="false"]')] },
  { screen: "contas", variant: "nova-conta", ui: tela(ContasScreen, { data: ACC, accId: null, canManage: true, ...contasActions }),
    steps: [clickText("button", "Nova conta")] },
  ...["Depósito", "Saque", "Bônus", "Ajuste", "Editar", "Excluir"].map((acao): Variant => ({
    screen: "contas", variant: `detalhe-${acao.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()}`,
    ui: tela(ContasScreen, { data: ACC, accId: conta0, canManage: true, ...contasActions }),
    steps: [clickText("button", acao)],
  })),
  ...ACC.accounts.slice(1).map((a, i): Variant => ({
    screen: "contas", variant: `detalhe-${i + 2}`, ui: tela(ContasScreen, { data: ACC, accId: a.id, canManage: true, ...contasActions }),
  })),

  // Ferramentas, monitoramento, operações
  { screen: "ferramentas", variant: "mock", ui: tela(FerramentasScreen, { data: TOOLS }), ssr: true },
  { screen: "monitoramento", variant: "mock", ui: tela(MonitoramentoScreen, { data: MONITORAMENTO_MOCK, ...monActions }), ssr: true },
  ...["incidentes", "desempenho", "ocr", "providers", "canais", "manutencao"].map((secao): Variant => ({
    screen: "monitoramento", variant: `secao-${secao}`, ui: tela(MonitoramentoScreen, { data: MONITORAMENTO_MOCK, ...monActions }),
    steps: [clickSel(`#segmento-tab-${secao}`)],
  })),
  { screen: "monitoramento", variant: "incidentes-acao-aberta", ui: tela(MonitoramentoScreen, { data: MONITORAMENTO_MOCK, ...monActions }),
    steps: [clickSel("#segmento-tab-incidentes"), clickSel("article > button[aria-expanded]")] },
  { screen: "monitoramento", variant: "ocr-sem-capturas", ui: tela(MonitoramentoScreen, {
    data: { ...MONITORAMENTO_MOCK, ocrModels: MONITORAMENTO_MOCK.ocrModels && { ...MONITORAMENTO_MOCK.ocrModels, readers: [] } }, ...monActions,
  }), steps: [clickSel("#segmento-tab-ocr")] },
  { screen: "monitoramento", variant: "canais-descartados", ui: tela(MonitoramentoScreen, { data: MONITORAMENTO_MOCK, ...monActions }),
    steps: [clickSel("#segmento-tab-canais"), clickSel("summary")] },
  { screen: "operacoes", variant: "mock", ui: tela(OperacoesScreen, { data: OPERACOES_MOCK, canManage: true, ...opsActions }), ssr: true },
  { screen: "operacoes", variant: "semacoes", ui: tela(OperacoesScreen, { data: OPERACOES_MOCK }) },
  { screen: "operacoes", variant: "indisponivel", ssr: true, ui: tela(OperacoesScreen, { data: {
    ...OPERACOES_MOCK, available: false, matchingTotal: 0, sharpSemMatchTotal: 0, matchingSharpSobrepostos: 0,
    iaJudgeSuggestionTotal: 0, iaJudgeSuggestions: [], settlement: [], matching: [], sharp: [],
  } }) },
  ...["liquidar", "vincular", "homologar", "sharp"].map((fila): Variant => ({
    screen: "operacoes", variant: `fila-${fila}`, ui: tela(OperacoesScreen, { data: OPERACOES_MOCK, canManage: true, ...opsActions }),
    steps: [clickSel(`#segmento-tab-${fila}`)],
  })),

  { screen: "operacoes", variant: "vincular-proximo", ui: tela(OperacoesScreen, { data: OPERACOES_MOCK, canManage: true, ...opsActions }),
    steps: [clickSel("#segmento-tab-vincular"), clickText("button", "próximo")] },
  { screen: "operacoes", variant: "vincular-zerada", ui: tela(OperacoesScreen, {
    data: { ...OPERACOES_MOCK, matching: [], matchingTotal: 0, matchingSharpSobrepostos: 0 }, canManage: true, ...opsActions,
  }), steps: [clickSel("#segmento-tab-vincular")] },
  { screen: "operacoes", variant: "liquidar-uma", ui: tela(OperacoesScreen, { data: OPERACOES_MOCK, canManage: true, ...opsActions }),
    steps: [clickSel("#segmento-tab-liquidar"), clickText("button", "Ganhou")] },
  { screen: "operacoes", variant: "homologar-aprovar", ui: tela(OperacoesScreen, { data: OPERACOES_MOCK, canManage: true, ...opsActions }),
    steps: [clickSel("#segmento-tab-homologar"), clickText("button", "Aprovar como")] },

  // Aposta
  { screen: "aposta", variant: "mock", ui: tela(ApostaScreen, { bet: BETS[0]!, trilha: TRILHA, onEditBet: never, onDeleteBet: never }), ssr: true },
  ...BETS.slice(1).map((bet, i): Variant => ({
    screen: "aposta", variant: `bet-${i + 2}`, ui: tela(ApostaScreen, { bet, trilha: null, onEditBet: never, onDeleteBet: never }),
  })),
  { screen: "aposta", variant: "semacoes", ui: tela(ApostaScreen, { bet: BETS[0]!, trilha: TRILHA, onEditBet: null, onDeleteBet: null }) },
  { screen: "aposta", variant: "removida", ui: tela(ApostaScreen, { bet: BETS[0]!, trilha: TRILHA, onEditBet: never, onDeleteBet: never, onRestoreBets: never,
    removal: { at: "13/06 21:40", origin: "reacao", restorable: true, previous: { status: "won", profit: 0.93 } } }), ssr: true },
  { screen: "aposta", variant: "captura", ui: tela(ApostaScreen, { bet: BETS[0]!, trilha: TRILHA, captura: CAPTURA, onEditBet: never, onDeleteBet: never }), ssr: true },
  { screen: "aposta", variant: "liquidacao", ui: tela(ApostaScreen, { bet: BETS[10]!, trilha: TRILHA, settlement: SETTLEMENT_CARDS.b11, onEditBet: never, onDeleteBet: never }), ssr: true },
  { screen: "aposta", variant: "origem", ui: tela(ApostaScreen, { bet: BETS[0]!, trilha: TRILHA, onEditBet: never, onDeleteBet: never }),
    steps: [clickSel(".app-main button[aria-expanded]")] },
  ...["Editar", "Excluir"].map((acao): Variant => ({
    screen: "aposta", variant: acao.toLowerCase(), ui: tela(ApostaScreen, { bet: BETS[0]!, trilha: TRILHA, onEditBet: never, onDeleteBet: never }),
    steps: [clickText("button", acao)],
  })),

  // Config
  { screen: "config", variant: "mock", ui: tela(ConfigScreen, config), ssr: true },
  { screen: "config", variant: "semacoes", ui: tela(ConfigScreen, { data: CFG }) },
  ...["bancas", "mercados", "times", "jogadores", "seguranca"].map((secao): Variant => ({
    screen: "config", variant: `secao-${secao}`, ui: tela(ConfigScreen, config),
    steps: [clickSel(`#segmento-tab-${secao}`)],
  })),
  ...([
    ["nova-banca", "bancas", clickText("button", "Novo tipster")],
    ["editar-banca", "bancas", clickSel('button[aria-label^="Editar "]')],
    ["editar-banca-pausada", "bancas", clickSel('button[aria-label="Editar Cestinha"]')],
    ["excluir-banca", "bancas", clickSel('button[aria-label$=" permanentemente"]')],
    ["mercado-aberto", "mercados", clickSel(".app-main button[aria-expanded]")],
    ["mercado-novo-alias", "mercados", (doc: Document) => {
      clickSel(".app-main button[aria-expanded]")(doc);
      clickText("button", "alias")(doc);
    }],
    ["remover-nome-de-tipster", "times", clickSel('button[aria-label^="Remover o nome de tipster "]')],
    ["jogadores-carregados", "jogadores", () => undefined],
    ["revogar-outras-sessoes", "seguranca", clickText("button", "Revogar outras")],
  ] as const).map(([variant, secao, step]): Variant => ({
    screen: "config", variant, ui: tela(ConfigScreen, configCarregada), steps: [clickSel(`#segmento-tab-${secao}`), step],
    esperaMs: secao === "jogadores" ? 300 : 0,
  })),
];

describe.skipIf(!OUT)("markup das telas do painel", () => {
  const originals = { random: Math.random, matchMedia: window.matchMedia, scrollIntoView: Element.prototype.scrollIntoView };
  // Sequências reiniciadas a cada caso: uma chamada a mais numa tela não
  // desloca o conteúdo das variantes seguintes.
  let seed = 0;
  let uuid = 0;

  beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // Só o relógio de parede congela: os timers reais deixam effects/lazy assentarem.
    vi.useFakeTimers({ now: FROZEN_NOW, toFake: ["Date"] });
    Math.random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`);
    window.matchMedia = ((query: string) => ({
      matches: mediaMatches(query), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    Element.prototype.scrollIntoView = function scrollIntoView() {};
    // Aquece o cache de módulos dos lazy/dynamic para o import() resolver logo.
    const mods = import.meta.glob(["../../app/_design/screens/**/*.{ts,tsx}", "../../app/_design/kit/*.{ts,tsx}"]);
    await Promise.all(Object.values(mods).map((load) => load()));
  }, 120_000);

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Math.random = originals.random;
    window.matchMedia = originals.matchMedia;
    Element.prototype.scrollIntoView = originals.scrollIntoView;
  });

  for (const v of VARIANTS) {
    for (const w of v.widths ?? WIDTHS) {
      for (const mode of MODES) {
        const base = `${v.screen}-${v.variant}-${w}-${mode}`;
        it(base, async () => {
          seed = 0;
          uuid = 0;
          setViewport(w);
          const ui = v.ui(mode);
          if (v.ssr) {
            // 1ª passada dispara os lazy/dynamic; a 2ª (já resolvidos) é a que
            // vale, para o HTML não depender da ordem dos casos.
            renderToStaticMarkup(ui);
            for (let i = 0; i < 5; i++) await tick();
            save(`${v.screen}-${v.variant}-ssr-${w}-${mode}`, renderToStaticMarkup(ui));
          }
          save(base, await mountAndCapture(ui, v));
        }, 60_000);
      }
    }
  }

  it("gerou um arquivo por variante", () => {
    expect(new Set(written).size).toBe(written.length);
    expect(written.length).toBeGreaterThan(300);
  });
});
