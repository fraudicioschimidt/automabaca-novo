import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  getSaudeMotor: vi.fn(),
  countSharpPendentes: vi.fn(),
  countCasosAbertos: vi.fn(),
  getSharpPendentes: vi.fn(),
  getCasosAbertos: vi.fn(),
  getMatchingOverlap: vi.fn(),
  getSettlementManual: vi.fn(),
  getPendingIaJudgeSuggestionsPage: vi.fn(),
  dismissOrphanedIaJudgeSuggestions: vi.fn(),
  getJobFailures: vi.fn(),
  getProviderBudgets: vi.fn(),
  getCanaisMonitorados: vi.fn(),
  getSemOddsPorMotivo: vi.fn(),
  getSegmentPolicies: vi.fn(),
  getOperationalSlos: vi.fn(),
  getPainelOperationalActions: vi.fn(),
  getResumoDeReliquidacao: vi.fn(),
  getOcrModelsReport: vi.fn(),
  getRecentReleases: vi.fn(),
  readLogArchiveHealth: vi.fn(),
}));

vi.mock("@/src/services/painel/operacoes/saude", () => ({
  getSaudeMotor: services.getSaudeMotor,
  workerVivo: (saude: { ultimoHeartbeat: Date | null }) => saude.ultimoHeartbeat != null,
}));
vi.mock("@/src/services/painel/operacoes/filas", () => ({
  countSharpPendentes: services.countSharpPendentes,
  countCasosAbertos: services.countCasosAbertos,
  getSharpPendentes: services.getSharpPendentes,
  getCasosAbertos: services.getCasosAbertos,
  getMatchingOverlap: services.getMatchingOverlap,
}));
vi.mock("@/src/services/painel/operacoes/settlement-manual", () => ({
  getSettlementManual: services.getSettlementManual,
}));
vi.mock("@/src/services/settlement/ia-judge/suggestions", () => ({
  getPendingIaJudgeSuggestionsPage: services.getPendingIaJudgeSuggestionsPage,
  dismissOrphanedIaJudgeSuggestions: services.dismissOrphanedIaJudgeSuggestions,
}));
vi.mock("@/src/services/painel/operacoes/falhas", () => ({ getJobFailures: services.getJobFailures }));
vi.mock("@/src/services/painel/operacoes/budgets", () => ({ getProviderBudgets: services.getProviderBudgets }));
vi.mock("@/src/services/painel/operacoes/channels", () => ({ getCanaisMonitorados: services.getCanaisMonitorados }));
vi.mock("@/src/services/painel/operacoes/cobertura", () => ({
  getSemOddsPorMotivo: services.getSemOddsPorMotivo,
  getSegmentPolicies: services.getSegmentPolicies,
}));
vi.mock("@/src/services/ops/slo/slo", () => ({ getOperationalSlos: services.getOperationalSlos }));
vi.mock("@/src/services/painel/operacoes/actions", () => ({
  getPainelOperationalActions: services.getPainelOperationalActions,
}));
vi.mock("@/src/services/painel/aposta/reliquidacao", () => ({
  getResumoDeReliquidacao: services.getResumoDeReliquidacao,
}));
vi.mock("@/src/services/painel/ocr-models", () => ({ getOcrModelsReport: services.getOcrModelsReport }));
vi.mock("@/src/services/ops/release-verdict", () => ({ getRecentReleases: services.getRecentReleases }));
vi.mock("@/src/infra/observability-status", () => ({ readLogArchiveHealth: services.readLogArchiveHealth }));

const { getMonitoramentoData, getOperacoesData, incidentHref } = await import("@/app/_design/adapters/operacoes");

const MONITORING_SECTIONS = [
  services.getJobFailures, services.getProviderBudgets, services.getCanaisMonitorados,
  services.getSemOddsPorMotivo, services.getSegmentPolicies, services.getOperationalSlos,
  services.getPainelOperationalActions, services.getResumoDeReliquidacao, services.getRecentReleases,
];
const OPERATIONS_SECTIONS = [
  services.getSharpPendentes, services.getCasosAbertos, services.getMatchingOverlap,
  services.countCasosAbertos, services.getSettlementManual, services.getPendingIaJudgeSuggestionsPage,
];

const now = new Date("2026-07-13T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  services.getPendingIaJudgeSuggestionsPage.mockResolvedValue({ total: 47, items: [{
    id: "ia-1",
    betId: "bet-ia",
    bet: {
      evento: "Brasil vs Argentina",
      pais: "América do Sul",
      competicao: "Copa",
      esporte: "Futebol",
      mercado: "Moneyline",
      selecao: "Brasil",
      odds: 2,
      stake: 1,
      data: now,
    },
    suggestedStatus: "WON",
    valueFound: 1,
    confidence: 0.94,
    reason: "placar confirmado",
    sourceUrl: "https://example.test/result",
    provider: "test",
    createdAt: now,
  }] });
  services.getSettlementManual.mockResolvedValue([
    {
      betId: "settlement-stat",
      evento: "A vs B",
      pais: "Brasil",
      competicao: "Liga",
      esporte: "Futebol",
      mercado: "Total de cartões",
      selecao: "Over 4.25",
      odds: 1.9,
      stake: 1,
      data: now,
      tipster: "Canal",
      bankrollNome: "Principal",
      cause: { kind: "flashscore_refused", settlementOutcome: "manual_missing_stats" },
    },
    {
      betId: "settlement-team",
      evento: "C vs D",
      pais: null,
      competicao: null,
      esporte: "Futebol",
      mercado: "Ambas marcam",
      selecao: "Sim",
      odds: 1.8,
      stake: 2,
      data: now,
      tipster: "",
      bankrollNome: "Principal",
      cause: { kind: "stalled", flashscoreOutcome: "no_candidate", settlementOutcome: null },
    },
    ...([
      ["settlement-inferido", "Moneyline", { kind: "inferred_kickoff" }],
      ["settlement-esporte", "Moneyline", { kind: "unconfirmed_sport" }],
      ["settlement-mma", "Moneyline", { kind: "stalled", flashscoreOutcome: "unsupported_sport", settlementOutcome: null }],
      ["settlement-sem-olhar", "Moneyline", { kind: "stalled", flashscoreOutcome: null, settlementOutcome: null }],
      ["settlement-outright", "Vencedor do Campeonato", { kind: "stalled", flashscoreOutcome: "invalid_event", settlementOutcome: null }],
      ["settlement-sem-fim", "Moneyline", { kind: "stalled", flashscoreOutcome: "matched", settlementOutcome: "not_attempted" }],
      ["settlement-sem-placar", "Moneyline", { kind: "stalled", flashscoreOutcome: "matched", settlementOutcome: "score_pending" }],
      ["settlement-adiado", "Moneyline", { kind: "stalled", flashscoreOutcome: "matched", settlementOutcome: "postponed_waiting" }],
      ["settlement-casado", "Moneyline", { kind: "stalled", flashscoreOutcome: "matched", settlementOutcome: null }],
    ] as const).map(([betId, mercado, cause]) => ({
      betId, evento: "E vs F", pais: "Brasil", competicao: "Liga", esporte: "Futebol", mercado, selecao: "E",
      odds: 2, stake: 1, data: now, tipster: "Canal", bankrollNome: "Principal", cause,
    })),
  ]);
  // `ultimoHeartbeat` é do relógio real, não do `now` fixo: o `since` sai de
  // `frescorDaFonte`, que mede contra o presente. O `ultimoClosing` fica no
  // `now` de julho de propósito, para provar que um ciclo velho não passa por
  // saudável.
  services.getSaudeMotor.mockResolvedValue({ ultimoHeartbeat: new Date(), dbOk: true, ultimoClosing: now });
  services.getOcrModelsReport.mockResolvedValue({ available: false });
  services.readLogArchiveHealth.mockResolvedValue({
    ok: false, collection: "unavailable", export: "unavailable", offsite: "unavailable", reasons: ["watchdog_unavailable"], backup: null,
  });
  // Totais PROPOSITALMENTE diferentes do tamanho das listas: as listas são
  // páginas (take 30/20) e o painel precisa mostrar o backlog, não a página.
  services.countSharpPendentes.mockResolvedValue(412);
  services.countCasosAbertos.mockResolvedValue(57);
  services.getMatchingOverlap.mockResolvedValue({ semMatchTotal: 5, sobrepostos: 4 });
  services.getCasosAbertos.mockResolvedValue([
    {
      id: "case-1",
      evento: "Home vs Away",
      esporte: "Futebol",
      competicao: "Liga",
      bet: { data: now },
      llmVerdictJson: { reason: "ambíguo" },
      candidatesJson: [
        { matchId: 10, home: "Home", away: "Away", league: "Liga", score: 88, matchDate: now.toISOString(), swapped: false },
        { league: "Alternativa", score: 0.4, matchDate: new Date(now.getTime() + 7 * 86_400_000).toISOString(), swapped: true },
        { score: null },
      ],
    },
    {
      id: "case-2",
      evento: "Sem vs Horário",
      esporte: "Tênis",
      competicao: "",
      bet: null,
      llmVerdictJson: { source: "matching", reason: "no_candidates" },
      candidatesJson: [],
    },
  ]);
  services.getSharpPendentes.mockResolvedValue([
    { betId: "sharp-1", bet: { evento: "A vs B", esporte: "Futebol", data: now, trainingCases: [] }, updatedAt: now, identityStatus: "PENDING" },
    { betId: "sharp-2", bet: { evento: "C vs D", esporte: "Tênis", data: now, trainingCases: [{ id: "case-9" }] }, updatedAt: now, identityStatus: "UNMATCHED" },
  ]);
  services.getPainelOperationalActions.mockResolvedValue({
    totais: { abertas: 43, assumidas: 7, encerradas: 556, acionaveis: 50 },
    acoes: [
      {
        id: "inc-1", area: "incidentes", actionType: "incident.review",
        fingerprint: "bet_lucro_drift:abc", title: "Lucro divergente", description: "detalhe",
        priority: 95, risk: "CRITICAL", status: "OPEN", resource: "bet", resourceId: "bet-1",
        owner: "ops", evidence: {}, occurrenceCount: 2, lastSeenAt: now, openedAt: now, reopenCount: 3,
        resolvedAt: now, resolutionNote: "corrigido",
      },
      {
        id: "inc-2", area: "incidentes", actionType: "incident.review",
        fingerprint: "other:def", title: "Outro", description: "detalhe",
        priority: 70, risk: "MEDIUM", status: "OPEN", resource: null, resourceId: "x",
        owner: null, evidence: null, occurrenceCount: 1, lastSeenAt: now, openedAt: now, reopenCount: 0,
        resolvedAt: null, resolutionNote: null,
      },
      {
        id: "action-1", area: "infra", actionType: "REVIEW", fingerprint: "training:ghi",
        title: "Revisar", description: "detalhe", priority: 80, risk: "LOW", status: "OPEN",
        owner: "operator", resource: "worker", resourceId: "w1", evidence: null,
        occurrenceCount: 1, lastSeenAt: now, openedAt: now, reopenCount: 0, resolvedAt: null, resolutionNote: null,
      },
    ],
  });
  // A grade de 24h conserva a violação; a janela de 1h, que decide o veredito, já normalizou.
  services.getOperationalSlos.mockImplementation(async (hours: number) => hours === 24
    ? [{
        kind: "queue", name: "closing", samples: 10, errors: 0, successPct: 100, p95DurationMs: 50,
        p95QueueLagMs: 10, status: "breach", reasons: ["violação já normalizada"], lastSeenAt: now,
      }]
    : []);
  services.getResumoDeReliquidacao.mockResolvedValue({ apostas: 0, eventos: 0, recentes: [] });
  services.getRecentReleases.mockResolvedValue({ releases: [], flaggedLast24h: 0 });
  // Já AGRUPADO: o serviço devolve incidentes, não ocorrências.
  services.getJobFailures.mockResolvedValue({
    disponivel: true,
    total: 20,
    retidas: 2,
    grupos: [
      {
        id: "sharp.enrich.dlq::circuito_aberto", fila: "sharp.enrich.dlq",
        causa: "circuito_aberto", rotulo: "circuito aberto — nós cortamos o provider",
        proximaEtapa: "Espere o circuito fechar; replay agora falha na hora.",
        membros: [
          { id: "job-1", betId: "bet-a", quando: now, tentativas: 0 },
          { id: "job-2", betId: null, quando: now, tentativas: 1 },
        ],
        // Primeira e última em DIAS diferentes de propósito: é o caso em que
        // encurtar o fim para só a hora vira mentira.
        n: 2, primeira: new Date(now.getTime() - 26 * 3_600_000), ultima: now,
        replayable: true, replayHabilitado: false,
        motivoBloqueio: "Espere o circuito fechar; replay agora falha na hora.",
      },
      {
        id: "closing::desconhecida", fila: "closing", causa: "desconhecida",
        rotulo: "falha sem classificação",
        proximaEtapa: "Abra o erro bruto: nenhuma causa conhecida casou.",
        membros: [{ id: "job-3", betId: null, quando: now, tentativas: 0 }],
        n: 1, primeira: now, ultima: now,
        replayable: false, replayHabilitado: false, motivoBloqueio: null,
      },
    ],
  });
  services.getSemOddsPorMotivo.mockResolvedValue([
    { lado: "identidade", reason: "sem_linha_atual", n: 3, segmentos: 2, topoSegmento: "Brasil · Série A", topoN: 2 },
    { lado: "fechamento", reason: "provider_custom", n: 1, segmentos: 1, topoSegmento: null, topoN: 1 },
    { lado: "fechamento", reason: "aposta_ao_vivo", n: 5, segmentos: 3, topoSegmento: "Brasil · Série B", topoN: 3 },
  ]);
  services.getProviderBudgets.mockResolvedValue([{
    name: "gemini", period: "2026-07", janelaDoCusto: "month", used: 5, cap: 10, label: "Gemini",
    rendimento: { identidade: 8 },
  }]);
  services.getSegmentPolicies.mockResolvedValue([
    { esporte: "Futebol", mercado: "Moneyline", phase: "ACTIVE", source: "AUTO", betsAvaliadas: 120, clvReliablePct: 60, evaluatedAt: now },
    { esporte: "Tênis", mercado: "Total", phase: "PROBATION", source: "AUTO", betsAvaliadas: 10, clvReliablePct: null, evaluatedAt: null },
  ]);
  services.getCanaisMonitorados.mockResolvedValue({
    canais: [
      {
        channelId: "1", bankrollNome: "Canal vazio", parse: { taxaOk: null, posts: 0, ok: 0, descartadas: 0, tentativas: 0, falhas: 0, perdas: [] },
        capturas: 0, ultimaCaptura: null, identity: { taxaOk: null, resolved: 0, pending: 0, failed: 0 },
        odds: { faltas: [] },
        resolution: { p50Min: null, p95Min: 0.5, samples: 0 }, preKickoffFailures: 0, transientFailures: 0, transientBatchLimit: 100,
        discarded: { total: 0, recent: [] },
        activity: { lastUpdateAt: new Date(Date.now() - 9 * 3_600_000), silence: { state: "mudo", lastPostAt: new Date(Date.now() - 9 * 3_600_000), limitHours: 6, silentHours: 9 } },
        latency: { samples: 0, p50Min: null, p95Min: null },
      },
      {
        channelId: "2", bankrollNome: "Canal ativo", parse: { taxaOk: 99.6, posts: 12, ok: 10, descartadas: 1, tentativas: 11, falhas: 1,
          perdas: [{ motivo: "odd_legenda_ausente", rotulo: "legenda sem a odd", classe: "legenda_incompleta", proximaEtapa: "a odd decide o lucro", n: 1 }] },
        capturas: 11, ultimaCaptura: now, identity: { taxaOk: 80.4, resolved: 8, pending: 1, failed: 1 },
        odds: { faltas: [{ reason: "sem_linha_atual", n: 3 }] },
        resolution: { p50Min: 5.4, p95Min: 120, samples: 10 }, preKickoffFailures: 1, transientFailures: 2, transientBatchLimit: 100,
        discarded: { total: 3, recent: [
          { messageId: 7, text: "x".repeat(10), textTruncated: true, reason: "nao_parece_aposta", postedAt: new Date(), captureRequestedAt: null },
          { messageId: 6, text: "Bom dia", textTruncated: false, reason: "resultado_ou_balanco", postedAt: new Date(Date.now() - 4 * 3_600_000), captureRequestedAt: now },
        ] },
        activity: { lastUpdateAt: now, silence: { state: "ok", lastPostAt: now, limitHours: 6, silentHours: 0 } },
        latency: { samples: 9, p50Min: 1.5, p95Min: 12 },
      },
      {
        channelId: "3", bankrollNome: "Canal lento", parse: { taxaOk: 100, posts: 1, ok: 1, descartadas: 0, tentativas: 1, falhas: 0, perdas: [] },
        capturas: 1, ultimaCaptura: now, identity: { taxaOk: 100, resolved: 1, pending: 0, failed: 0 },
        odds: { faltas: [] },
        resolution: { p50Min: 600, p95Min: 601, samples: 1 }, preKickoffFailures: 0, transientFailures: 0, transientBatchLimit: 100,
        discarded: { total: 0, recent: [] },
        activity: { lastUpdateAt: null, silence: { state: "aprendendo", lastPostAt: null } }, latency: { samples: 0, p50Min: null, p95Min: null },
      },
      {
        channelId: "4", bankrollNome: "Canal pausado", capturePaused: true, parse: { taxaOk: 100, posts: 1, ok: 1, descartadas: 0, tentativas: 1, falhas: 0, perdas: [] },
        capturas: 1, ultimaCaptura: now, identity: { taxaOk: 100, resolved: 1, pending: 0, failed: 0 },
        odds: { faltas: [] },
        resolution: { p50Min: 5, p95Min: 6, samples: 1 }, preKickoffFailures: 0, transientFailures: 0, transientBatchLimit: 100,
        discarded: { total: 0, recent: [] },
        activity: { lastUpdateAt: new Date(Date.now() - 30 * 3_600_000), silence: { state: "mudo", lastPostAt: new Date(Date.now() - 30 * 3_600_000), limitHours: 6, silentHours: 30 } },
        latency: { samples: 0, p50Min: null, p95Min: null },
      },
    ],
    orfaos: [{ channelId: "999", postsPreservados: 2, ultimaVez: now }],
    orfaosTotal: 24,
  });
});

describe("incidentHref — o incidente abre o recurso", () => {
  it("aposta abre a ficha por query ?id= (não path /aposta/:id)", () => {
    expect(incidentHref("bet", "abc-123")).toBe("/aposta?id=abc-123");
  });

  it("divergência de saldo abre a conta, não a lista", () => {
    expect(incidentHref("conta", "c1")).toBe("/contas?acc=c1");
  });

  it("sem resourceId, ou recurso sem página, não há link", () => {
    expect(incidentHref("bet", null)).toBeNull();
    expect(incidentHref("worker", "w1")).toBeNull();
  });
});

describe("getOperacoesData e getMonitoramentoData", () => {
  it("o veredito conta só o SLO que alerta: o transporte de IA fica na grade", async () => {
    const serie = { samples: 40, errors: 8, successPct: 80, p95DurationMs: 500, p95QueueLagMs: null, status: "breach", reasons: ["sucesso 80.0% < 95%"], lastSeenAt: now };
    services.getOperationalSlos.mockResolvedValue([
      { ...serie, kind: "provider", name: "llm.transport.gemini.generate", alerting: false },
      { ...serie, kind: "provider", name: "llm.cascade", alerting: true },
    ]);
    const monitoring = await getMonitoramentoData();
    expect(monitoring.summary.sloBreachTotal).toBe(1);
    expect(monitoring.slo).toHaveLength(2);
  });

  it("o cartão Sem odds lê os últimos 30 dias, o mesmo corte da reliquidação", async () => {
    await getMonitoramentoData();
    const [desde] = services.getResumoDeReliquidacao.mock.calls[0] as [Date];
    expect(desde).toBeInstanceOf(Date);
    expect(services.getSemOddsPorMotivo).toHaveBeenCalledWith(desde);
  });

  it("a release sai com o horário do veredito, o commit e as mudanças desde a anterior", async () => {
    const sha = "6711865aa2b3c4d5e6f708192a3b4c5d6e7f8091";
    const previousSha = "5595c532bb2b3c4d5e6f708192a3b4c5d6e7f809";
    const firstAt = new Date("2026-07-13T11:06:00.000Z");
    services.getRecentReleases.mockResolvedValue({ flaggedLast24h: 1, releases: [
      {
        releaseId: "auto-6711865-20260713-6711865", sha, previousSha,
        readyAt: new Date("2026-07-13T11:02:00.000Z"), observationEnd: new Date("2026-07-13T11:47:00.000Z"),
        state: "erro_novo", knownErrors: 2, notice: "sent",
        findings: [{ queue: "sharp.enrich", text: "TypeError: x is not a function", occurrences: 7, jobs: 2, firstAt }],
        belowThreshold: [{ queue: "closing.sync", text: "RangeError: Invalid time value", occurrences: 1, jobs: 1, firstAt }],
      },
      {
        releaseId: "manual-20260713-5595c53", sha: previousSha, previousSha: null,
        readyAt: new Date("2026-07-13T10:00:00.000Z"), observationEnd: new Date("2026-07-13T10:45:00.000Z"),
        state: "sem_erro_novo", knownErrors: 0, notice: null, findings: [], belowThreshold: [],
      },
    ] });
    const monitoring = await getMonitoramentoData();
    expect(services.getRecentReleases).toHaveBeenCalledWith(10, expect.any(Date));
    expect(monitoring.releases[0]).toMatchObject({
      id: "auto-6711865-20260713-6711865",
      sha: "6711865",
      at: "13/07 08:02",
      state: "erro_novo",
      verdictFrom: "08:47",
      notice: "sent",
      commitUrl: `https://github.com/fraudicioschimidt/automabaca-novo/commit/${sha}`,
      compareUrl: `https://github.com/fraudicioschimidt/automabaca-novo/compare/${previousSha}...${sha}`,
      findings: [{ queue: "sharp.enrich", text: "TypeError: x is not a function", occurrences: 7, jobs: 2, firstAt: "08:06" }],
      belowThreshold: [{ queue: "closing.sync", text: "RangeError: Invalid time value", occurrences: 1, jobs: 1, firstAt: "08:06" }],
    });
    // Sem release anterior conhecida não há o que comparar.
    expect(monitoring.releases[1]!.compareUrl).toBeNull();
    // O número de Desempenho é o das apontadas nas últimas 24 h, que o serviço conta.
    expect(monitoring.releasesFlagged24h).toBe(1);
  });

  it("o veredito dos jobs segue as dead-letters retidas, não o histórico de 7 dias", async () => {
    // Falha já reprocessada fica no histórico do cartão, mas não pede atenção.
    services.getJobFailures.mockResolvedValue({ ...(await services.getJobFailures()), retidas: 0 });
    const tratadas = await getMonitoramentoData();
    expect(tratadas.jobsTotal).toBe(20);
    expect(tratadas.summary.jobsState).toBe("healthy");

    services.getJobFailures.mockResolvedValue({ ...(await services.getJobFailures()), retidas: 1 });
    expect((await getMonitoramentoData()).summary.jobsState).toBe("degraded");
  });

  it("canal pausado sem leitura em 30 dias não deixa o veredito em 'canais sem leitura'", async () => {
    const { canais } = await services.getCanaisMonitorados();
    const pausado = canais.find((canal: { capturePaused?: boolean }) => canal.capturePaused);
    services.getCanaisMonitorados.mockResolvedValue({
      canais: [{ ...pausado, parse: { ...pausado.parse, taxaOk: null, tentativas: 0 }, identity: { taxaOk: null, resolved: 0, pending: 0, failed: 0 } }],
      orfaos: [], orfaosTotal: 0,
    });
    const monitoring = await getMonitoramentoData();
    expect(monitoring.channels[0]).toMatchObject({ state: "healthy", silence: { kind: "pausado" } });
    expect(monitoring.summary.channelsState).toBe("healthy");
  });

  it("a descrição da ação mantém as linhas do alerta e tira o emoji de cada uma", async () => {
    const { acoes: [primeira] } = await services.getPainelOperationalActions();
    services.getPainelOperationalActions.mockResolvedValue({
      totais: { abertas: 1, assumidas: 0, encerradas: 0, acionaveis: 1 },
      acoes: [{ ...primeira, description: "🛑 Tarefa parada · sharp.enrich\nA tarefa   falhou.\n👉 Reprocesse pelo painel." }],
    });
    const monitoring = await getMonitoramentoData();
    expect(monitoring.actions[0]!.description).toBe("Tarefa parada · sharp.enrich\nA tarefa falhou.\nReprocesse pelo painel.");
  });

  it("banco indisponível: nenhuma seção é consultada e a tela sabe que vazio não é zero", async () => {
    services.getSaudeMotor.mockResolvedValue({ ultimoHeartbeat: null, dbOk: false, ultimoClosing: null });

    const result = await getOperacoesData();
    expect(result.available).toBe(false);
    expect(result.engine.banco.ok).toBe(false);
    const monitoring = await getMonitoramentoData();
    expect(monitoring.available).toBe(false);
    expect(monitoring.jobsAvailable).toBe(false);
    expect(monitoring.summary.available).toBe(false);
    for (const section of [...OPERATIONS_SECTIONS, ...MONITORING_SECTIONS, services.countSharpPendentes]) {
      expect(section).not.toHaveBeenCalled();
    }
  });

  it("o backup mostra o veredito do vigia do host, também com o banco fora", async () => {
    const host = { ok: true, collection: "fresh", export: "fresh", offsite: "fresh", reasons: [] };
    const createdAt = "2026-09-24T04:21:00Z";
    expect((await getMonitoramentoData()).backup).toEqual({
      status: "Sem leitura", note: "o vigia do servidor não publicou o estado do backup", ok: null,
    });
    services.readLogArchiveHealth.mockResolvedValue({ ...host, backup: { state: "fresh", createdAt, failedAt: null, bets: 1284 } });
    expect((await getMonitoramentoData()).backup).toEqual({ status: "Em dia", note: "conferido 24/09 01:21 · 1.284 apostas no backup", ok: true });
    services.readLogArchiveHealth.mockResolvedValue({ ...host, backup: { state: "fresh", createdAt, failedAt: null, bets: 1 } });
    expect((await getMonitoramentoData()).backup.note).toBe("conferido 24/09 01:21 · 1 aposta no backup");

    services.getSaudeMotor.mockResolvedValue({ ultimoHeartbeat: null, dbOk: false, ultimoClosing: null });
    services.readLogArchiveHealth.mockResolvedValue({ ...host, ok: false, reasons: ["backup_failed"],
      backup: { state: "failed", createdAt, failedAt: "2026-09-25T04:19:00Z", bets: null } });
    expect((await getMonitoramentoData()).backup).toEqual({
      status: "Falhou", note: "última tentativa falhou 25/09 01:19 · último conferido 24/09 01:21", ok: false,
    });
    services.readLogArchiveHealth.mockResolvedValue({ ...host, ok: false, reasons: ["backup_stale"],
      backup: { state: "stale", createdAt: null, failedAt: null, bets: null } });
    expect((await getMonitoramentoData()).backup).toEqual({ status: "Atrasado", note: "nenhum backup conferido", ok: false });
  });

  it("cada tela consulta só as próprias seções", async () => {
    const operations = await getOperacoesData();
    for (const section of MONITORING_SECTIONS) expect(section).not.toHaveBeenCalled();
    expect(operations).not.toHaveProperty("actions");
    expect(operations).not.toHaveProperty("budgets");

    vi.clearAllMocks();
    const monitoring = await getMonitoramentoData();
    for (const section of OPERATIONS_SECTIONS) expect(section).not.toHaveBeenCalled();
    expect(monitoring).not.toHaveProperty("sharp");
    expect(monitoring).not.toHaveProperty("matching");
  });

  it("adapta todos os blocos operacionais e seus estados-limite", async () => {
    const result = await getOperacoesData();
    const monitoring = await getMonitoramentoData();

    // `since` vem de `domain/frescor`, a mesma idade das outras telas.
    expect(result.engine.worker).toMatchObject({ status: "Ativo", since: "agora", ok: true });
    // A legenda do ciclo sai da cadência declarada, não de um literal na prosa.
    expect(result.engine.closing.note).toBe("ciclo a cada 5 min");
    // E o cartão do ciclo só fica verde se ele rodou dentro da própria
    // tolerância: com `ultimoClosing` de julho, "existe um closing" não basta.
    expect(result.engine.closing.ok).toBe(false);
    expect(result.iaJudgeSuggestions[0]).toMatchObject({ home: "Brasil", away: "Argentina", odds: 2 });
    expect(result.iaJudgeSuggestionTotal).toBe(47);
    // O painel de Operações existe para DETECTAR backlog: exibir o tamanho da
    // página (2) como se fosse o total (412) mostrava saúde falsa tanto para 31
    // quanto para 31.000 pendentes.
    expect(result.engine.pending.n).toBe(412);
    expect(result.engine.pending.n).not.toBe(result.sharp.length);
    expect(result.matchingTotal).toBe(57);
    expect(result.matchingTotal).not.toBe(result.matching.length);
    expect(result).toMatchObject({ sharpSemMatchTotal: 5, matchingSharpSobrepostos: 4 });
    expect(result).not.toHaveProperty("actionableActionTotal");
    expect(result).not.toHaveProperty("actions");
    // O motivo é o que o automático fez com a aposta: o FlashScore liquida
    // estatística e gols por time, então o mercado sozinho não explica a fila.
    expect(result.settlement.map((item) => item.reason)).toEqual([
      "o FlashScore não publicou a estatística",
      "o FlashScore não achou o jogo",
      "horário inferido — nenhum liquidador automático pega",
      "esporte não confirmado — o automático não liquida",
      "o FlashScore não cobre este esporte",
      "o FlashScore ainda não observou o jogo",
      "outright — não se resolve por uma partida",
      "o FlashScore achou o jogo, mas ainda não o viu terminar",
      "o FlashScore viu o fim do jogo, mas sem placar",
      "adiado e sem remarcação depois de 48 h",
      "o FlashScore achou o jogo, mas não tem o resultado",
    ]);
    // O cartão diz quando o jogo COMEÇOU: o kickoff não é o fim do jogo. Sem
    // horário, `data` é só o dia do jogo, e "começou há" seria inventado.
    expect(result.settlement[0]!.when).toMatch(/^começou /);
    expect(result.settlement[0]).not.toHaveProperty("ended");
    expect(result.settlement.find((item) => item.id === "settlement-inferido")!.when).toBe("jogo de 13/07");
    // Só a linha asiática fracionária admite meio resultado; a tela esconde o ½ nas outras.
    expect(result.settlement.slice(0, 2).map((item) => item.allowsHalfResult)).toEqual([true, false]);
    // A sugestão desatualizada sai antes da leitura: a fila Liquidar esconde a
    // aposta que tem sugestão pendente, e uma velha a esconderia das duas filas.
    expect(services.dismissOrphanedIaJudgeSuggestions.mock.invocationCallOrder[0])
      .toBeLessThan(services.getSettlementManual.mock.invocationCallOrder[0]!);
    expect(result.matching[0]!.candidates).toEqual([
      expect.objectContaining({ id: "10", score: 0.88, dayShift: null, swapped: false }),
      expect.objectContaining({ id: "c1", label: "Alternativa", score: 0.4, dayShift: "7 dias depois do kickoff", swapped: true }),
      expect.objectContaining({ id: "c2", label: "candidato", score: 0, kickoff: null, dayShift: null, swapped: false }),
    ]);
    // O horário do candidato sai no fuso de São Paulo, como o kickoff da aposta ao lado.
    expect(result.matching[0]!.candidates[0]!.kickoff).toBe(result.matching[0]!.kickoff);
    expect(result.matching[0]).toMatchObject({ llmReason: "ambíguo", matchingReason: null });
    expect(result.matching[1]).toMatchObject({ kickoff: "—", llmReason: null });
    expect(result.matching[1]!.matchingReason).toEqual(expect.any(String));
    expect(result.sharp.map((item) => item.state)).toEqual(["aguardando", "sem par"]);
    // A sem par com caso de treino aberto se resolve em Vincular, não na aba Sharp.
    expect(result.sharp.map((item) => item.inLinkQueue)).toEqual([false, true]);
    expect(monitoring.actions.map((item) => item.href)).toEqual(["/aposta?id=bet-1", null, null]);
    // A linha é por INCIDENTE: causa, próxima etapa e o `n` do grupo, não
    // "failed"/"completed" repetido por ocorrência.
    expect(monitoring.jobs.map((item) => [item.name, item.causa, item.n])).toEqual([
      ["sharp.enrich.dlq", "circuito aberto — nós cortamos o provider", 2],
      ["closing", "falha sem classificação", 1],
    ]);
    // Incidente repetido mostra a JANELA; o pontual mostra um instante só.
    // A janela que atravessa dias repete a DATA no fim: "06/08 12:56 – 19:21"
    // se lê como quatro horas quando na verdade foram quatro dias.
    expect(monitoring.jobs[0]!.at).toBe("12/07 07:00 – 13/07 09:00");
    expect(monitoring.jobs[1]!.at).not.toContain("–");
    // Botão existe (é DLQ) mas está bloqueado, com o motivo no lugar da etapa.
    expect(monitoring.jobs[0]).toMatchObject({ replay: true, replayHabilitado: false });
    expect(monitoring.jobs[0]!.replayJobIds).toEqual(["job-1", "job-2"]);
    expect(monitoring.jobs[0]!.motivoBloqueio).toContain("circuito fechar");
    // Proveniência: só os membros que tinham betId no payload.
    expect(monitoring.jobs[0]!.bets).toEqual(["bet-a"]);
    // `closing` não é dead-letter: o replay não a alcança, então nem botão há.
    expect(monitoring.jobs[1]!.replay).toBe(false);
    expect(monitoring.actions.map((item) => item.owner)).toEqual(["ops", null, "operador"]);
    // Três bases separadas: `aposta_ao_vivo` sai do grupo que decide
    // cobertura, o motivo desconhecido é conserto nosso, e a fração de cada
    // linha é da PRÓPRIA base.
    expect(monitoring.noOdds.total).toBe(9);
    expect(monitoring.noOdds.fornecedor.total).toBe(3);
    expect(monitoring.noOdds.fornecedor.linhas.map((l) => l.rotulo)).toEqual(["Pinnacle sem linha atual"]);
    expect(monitoring.noOdds.fornecedor.linhas[0]!.pct).toBeCloseTo(100, 6);
    expect(monitoring.noOdds.sistema.linhas.map((l) => l.rotulo)).toEqual(["provider_custom"]);
    expect(monitoring.noOdds.naoSeAplica.total).toBe(5);
    expect(monitoring.probation.map((item) => item.evaluatedAt)).toEqual([expect.any(String), null]);
    expect(monitoring.channels.map((item) => item.resolutionP50)).toEqual(["—", "5 min", "10 h", "5 min"]);
    expect(monitoring.channels.map((item) => item.resolutionP95)).toEqual(["<1 min", "2.0 h", "10 h", "6 min"]);
    expect(monitoring.channels.map((item) => item.parse)).toEqual([null, 100, 100, 100]);
    // Canal calado além do ritmo pesa no estado mesmo sem nenhum parse para medir.
    expect(monitoring.channels.map((item) => item.state)).toEqual(["degraded", "degraded", "healthy", "healthy"]);
    expect(monitoring.channels[1]).toMatchObject({
      parseFailureTotal: 1,
      // A base do percentual é TENTATIVA (post que era aposta), não post lido:
      // o descarte correto de `Canal ativo` fica fora do denominador.
      total: 11,
      parseDescartadas: 1,
      transientBatchLimit: 100,
    });
    expect(monitoring.channels[1]!.noOdds).toEqual([
      { reason: "sem_linha_atual", label: "Pinnacle sem linha atual", n: 3 },
    ]);
    // Texto cortado pela retenção ganha reticências; o pedido de captura vira data de São Paulo.
    expect(monitoring.channels[1]).toMatchObject({ discardedTotal: 3, silence: null, latencyP50: "2 min", latencyP95: "12 min", latencySamples: 9 });
    expect(monitoring.channels[0]).toMatchObject({ lastUpdate: "há 9 h", silence: { kind: "mudo", detail: "calado há 9.0 h; o normal é até 6.0 h" }, latencyP50: "—" });
    expect(monitoring.channels[2]).toMatchObject({ lastUpdate: null, silence: { kind: "aprendendo" } });
    // Canal pausado pelo dono: o silêncio é esperado, não degrada o canal.
    expect(monitoring.channels[3]).toMatchObject({ silence: { kind: "pausado" }, state: "healthy" });
    expect(monitoring.channels[1]!.discarded.map((post) => [post.messageId, post.text, post.reason, post.stale, post.captureRequestedAt !== null]))
      .toEqual([[7, `${"x".repeat(10)}…`, "não parecia aposta", false, false], [6, "Bom dia", "resultado ou balanço", true, true]]);
    expect(monitoring.orphanChannels[0]).toMatchObject({ orphan: true, captures: 2 });
    expect(monitoring.orphanChannelsTotal).toBe(24);
    expect(monitoring.actionTotals).toEqual({ OPEN: 43, ACKED: 7, RESOLVED: 556 });
    expect(monitoring.summary).toMatchObject({
      available: true,
      healthy: false,
      state: "degraded",
      engineState: "degraded",
      actionableTotal: 50,
      degradedChannelTotal: 26,
      // A grade conserva 24h, mas o veredito responde à janela atual de 1h.
      sloBreachTotal: 0,
    });
    expect(monitoring.actions).toHaveLength(3);
    expect(monitoring.slo).toHaveLength(1);
    expect(monitoring.budgets).toHaveLength(1);
    expect(monitoring.budgets[0]).toMatchObject({
      name: "gemini",
      janelaDoCusto: "month",
      rendimento: { identidade: 8 },
    });
    expect(monitoring.budgets[0]).not.toHaveProperty("attributed");
    expect(services.getOperationalSlos.mock.calls.map(([hours]) => hours).sort()).toEqual([1, 24]);
    expect(services.getSettlementManual).toHaveBeenCalledTimes(1);
    expect(services.getPendingIaJudgeSuggestionsPage).toHaveBeenCalledTimes(1);
  });
});

it("Homologar conserva a fonte de redirecionamento com citação confiável", async () => {
  const initial = (await services.getPendingIaJudgeSuggestionsPage()).items[0];
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/prova-pendente";
  services.getPendingIaJudgeSuggestionsPage.mockResolvedValue({ total: 1, items: [{
    ...initial, sourceUrl: redirect, groundingSources: [{ url: redirect, title: "flashscore.com" }], evidenceKind: "GROUNDED_WEB",
  }] });
  const data = await getOperacoesData();
  expect(data.iaJudgeSuggestions[0]?.sourceUrl).toBe(redirect);
});


it.each([
  ["FLASHSCORE_STRUCTURED", "flashscore-stats", true, true],
  ["FLASHSCORE_STRUCTURED", "gemini", false, true],
  ["GROUNDED_WEB", "flashscore-stats", false, false],
])("Homologar distingue a natureza da prova: %s / %s", async (evidenceKind, provider, ruleBased, fromFlashscore) => {
  const initial = (await services.getPendingIaJudgeSuggestionsPage()).items[0];
  services.getPendingIaJudgeSuggestionsPage.mockResolvedValue({ items: [{ ...initial, evidenceKind, provider }], total: 1 });
  expect((await getOperacoesData()).iaJudgeSuggestions[0]).toMatchObject({ ruleBased, fromFlashscore });
});
