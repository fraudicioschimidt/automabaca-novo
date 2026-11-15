// Dados de demonstração de Operações e Monitoramento (`?mock=1`), na forma dos
// adaptadores. Textos relativos (`whenRelativo`, `desde`) são fixos: o mock
// espelha a forma do adaptador, nunca o relógio.
import type { OperacoesData } from "../action-contracts";
import type { MonitoramentoData } from "../adapters/operacoes";
import { lacunaNaTela } from "../lib/lacuna-na-tela";
import { readAction } from "../lib/action-reading";

type MockAction = Omit<MonitoramentoData["actions"][number], "reading"> & { actionType?: string };
/** A leitura da ação sai do texto e da evidência, como no adaptador. */
function withReading({ actionType = "incident.review", ...action }: MockAction): MonitoramentoData["actions"][number] {
  return { ...action, reading: readAction({ title: action.title, description: action.description, actionType, evidence: action.evidence }) };
}

const OPS: Omit<OperacoesData & MonitoramentoData, "ocrModels"> = {
  available: true,
  summary: {
    available: true,
    healthy: false,
    state: 'degraded',
    engineState: 'healthy',
    jobsState: 'degraded',
    channelsState: 'degraded',
    actionableTotal: 3,
    degradedChannelTotal: 3,
    sloBreachTotal: 0,
  },
  engine: {
    worker: { status: 'Ativo', since: 'há 2 min', ok: true },
    banco: { status: 'OK', note: 'SELECT 1 · 8 ms', ok: true },
    closing: { at: '13/06 12:45', note: 'ciclo a cada 5 min', ok: true },
    pending: { n: 3, note: 'aguardando Pinnacle / sem par' },
  },
  backup: { status: 'Em dia', note: 'conferido 13/06 01:21 · 1.284 apostas no backup', ok: true },

  // Settlement manual (NOVO) — apostas PENDING que o automático não liquidou.
  settlement: [
    { id: 's1', version: 1, home: 'Saint Croix', away: 'Minnesota Thunder', region: 'USA · WPSL',
      market: 'Ambas marcam', pick: 'Não', odds: 1.950, stake: 0.25, when: 'começou há 3 dias',
      tipster: null, bankrollNome: 'Big Data', reason: 'o FlashScore não achou o jogo', allowsHalfResult: false },
    { id: 's2', version: 1, home: 'AC Connecticut', away: 'Vermont Green', region: 'USA · USL League 2',
      market: 'Total do mandante', pick: 'Over 1.5', odds: 1.900, stake: 0.50, when: 'começou há 3 dias',
      tipster: null, bankrollNome: 'Big Data', reason: 'o FlashScore não achou o jogo', allowsHalfResult: false },
    { id: 's3', version: 1, home: 'Magesi', away: 'Milford', region: 'South Africa · PSL',
      market: 'Marca no 1º tempo', pick: 'Sim', odds: 2.050, stake: 0.50, when: 'começou há 6 h',
      tipster: null, bankrollNome: 'Big Data', reason: 'o FlashScore achou o jogo, mas não tem o resultado', allowsHalfResult: false },
    { id: 's4', version: 1, home: 'Ogre United', away: 'Riga FC', region: 'Latvia · Virsliga',
      market: 'Total do visitante', pick: 'Under 1.5', odds: 1.875, stake: 0.50, when: 'jogo de 12/06',
      tipster: null, bankrollNome: 'Big Data', reason: 'horário inferido — nenhum liquidador automático pega', allowsHalfResult: false },
    { id: 's5', version: 1, home: 'The Cove', away: 'Modbury Jets', region: 'Australia · SA State League 1',
      market: 'Escanteios', pick: 'Over 8.75', odds: 1.910, stake: 0.50, when: 'começou há 7 h',
      tipster: null, bankrollNome: 'Big Data', reason: 'o FlashScore não publicou a estatística', allowsHalfResult: true },
  ],

  // IA-Judge — sugestões de liquidação (homologação humana).
  iaJudgeSuggestionTotal: 2,
  iaJudgeSuggestions: [
    { id: 'iaj1', betId: 'b1', home: 'Flamengo', away: 'Palmeiras', region: 'Brasil · Série A',
      market: 'Total de Escanteios', pick: 'Mais de 9.5', odds: 1.910, stake: 0.50, started: 'há 14 h',
      suggestedStatus: 'WON', valueFound: '12', confidence: 0.93,
      reason: 'Sofascore registra 12 escanteios no jogo (7–5). Over 9.5 ganhou.',
      ruleBased: false, fromFlashscore: false, sourceUrl: 'https://www.sofascore.com/example', provider: 'gemini', at: '08/07 20:15' },
    { id: 'iaj2', betId: 'b2', home: 'Lakers', away: 'Celtics', region: 'NBA',
      market: 'Pontos do jogador', pick: 'LeBron Over 27.5', odds: 1.870, stake: 0.25, started: 'há 18 h',
      suggestedStatus: 'LOST', valueFound: '24', confidence: 0.88,
      reason: 'Box score oficial: LeBron 24 pts. Under da linha 27.5.',
      ruleBased: false, fromFlashscore: false, sourceUrl: null, provider: 'gemini', at: '08/07 20:18' },
  ],

  // Matching a resolver — auto-match + juiz LLM não fecharam; escolher candidato.
  matchingTotal: 4,
  sharpSemMatchTotal: 3,
  matchingSharpSobrepostos: 0,
  matching: [
    { id: 'm1', betId: 'b-m1', home: 'montgomery', away: 'swarm', region: 'Soccer · post original', kickoff: '13/06 00:00', llmReason: null,
      matchingReason: 'Os dois melhores candidatos ficaram próximos demais para decisão automática.', motivo: 'candidatos próximos',
      candidates: [
        { id: 'c1', index: 0, candidateHash: "a".repeat(64), label: 'Montgomery County SC vs Carolina Swarm', league: 'USL League Two', kickoff: '13/06 00:00', dayShift: null, swapped: false, score: 0.86 },
        { id: 'c2', index: 1, candidateHash: "a".repeat(64), label: 'FC Montgomery vs Swarm United', league: 'NPSL', kickoff: '13/06 19:30', dayShift: null, swapped: true, score: 0.61 },
      ] },
    { id: 'm2', betId: 'b-m2', home: 'Sorrento F', away: 'UWA Nedlands FC F', region: 'Soccer · post original', kickoff: '14/06 00:00',
      llmReason: 'Os dois jogos têm times femininos com o mesmo nome; o post não diz a liga.', matchingReason: null, motivo: 'veredito do juiz de IA',
      candidates: [
        { id: 'c3', index: 0, candidateHash: "a".repeat(64), label: 'Sorrento FC (W) vs UWA Nedlands (W)', league: 'WA NPL Women', kickoff: '14/06 00:00', dayShift: null, swapped: false, score: 0.79 },
        { id: 'c4', index: 1, candidateHash: "a".repeat(64), label: 'Sorrento FC vs Nedlands FC', league: 'WA State League', kickoff: '14/06 04:00', dayShift: null, swapped: false, score: 0.55 },
      ] },
    { id: 'm3', betId: 'b-m3', home: 'Ängby IF', away: 'Skiljebo SK', region: 'Soccer · post original', kickoff: '14/06 00:00', llmReason: null, matchingReason: null, motivo: null,
      candidates: [
        { id: 'c5', index: 0, candidateHash: "a".repeat(64), label: 'Ängby IF vs Skiljebo SK', league: 'Ettan Norra', kickoff: '14/06 00:00', dayShift: null, swapped: false, score: 0.91 },
      ] },
    { id: 'm4', betId: 'b-m4', home: 'Famalicao', away: 'Vitoria Guimaraes', region: 'Soccer · Primeira Liga', kickoff: '14/06 15:30', llmReason: null,
      matchingReason: 'Nenhuma partida foi retornada pelos providers na janela do kickoff.', motivo: 'nenhum candidato',
      candidates: [] },
  ],

  // Identidade sharp — sem par na Pinnacle / aguardando a linha abrir.
  sharp: [
    { id: 'p1', home: 'Ängby IF', away: 'Skiljebo SK', region: 'Soccer', kickoff: '14/06 00:00', tried: '13/06 12:30', state: 'aguardando', identityStatus: 'PENDING', inLinkQueue: false },
    { id: 'p2', home: 'Sorrento F', away: 'UWA Nedlands FC F', region: 'Soccer', kickoff: '14/06 00:00', tried: '13/06 12:30', state: 'aguardando', identityStatus: 'PENDING', inLinkQueue: false },
    { id: 'p3', home: 'montgomery', away: 'swarm', region: 'Soccer', kickoff: '13/06 00:00', tried: '13/06 12:50', state: 'sem par', identityStatus: 'UNMATCHED', inLinkQueue: false },
  ],

  // Caixa única de Monitoramento (incidentes do motor + trabalho detectado).
  actionTotals: { OPEN: 5, ACKED: 1, RESOLVED: 1 },
  actions: ([
    { id: 'a1', area: 'incidentes',
      title: 'Lucro divergente do status', risk: 'CRITICAL', status: 'OPEN',
      description: 'A aposta foi liquidada, mas o lucro gravado não corresponde a odds, stake e status.',
      owner: null, evidence: { gravado: '-0.25u', esperado: '+0.24u' }, occurrences: 2, reopenCount: 0,
      when: '13/06 12:52', whenRelativo: 'há 26 min', desde: 'há 2 h', desdeAbsoluto: '13/06 11:45', resolutionNote: null, href: '/aposta?id=b12' },
    { id: 'a2', area: 'incidentes',
      title: 'Latência elevada no closing', risk: 'MEDIUM', status: 'ACKED',
      description: 'O p95 da fila closing.sync ultrapassou o objetivo operacional.',
      owner: 'Fabricio', evidence: { p95: '142s', limite: '120s' }, occurrences: 33, reopenCount: 13,
      // Incidente crônico, resolvido várias vezes e de volta. Sem um exemplo
      // reincidente no mock, a marca não aparece no protótipo nem no teste
      // visual — e a regressão passa despercebida.
      when: '13/06 12:48', whenRelativo: 'há 30 min', desde: 'há 3 h', desdeAbsoluto: '15/05 09:20', resolutionNote: null, href: null },
    { id: 'a3', area: 'matching',
      title: 'Resolver identidade: Ängby IF vs Skiljebo SK', risk: 'MEDIUM', status: 'OPEN',
      description: '5 candidato(s) aguardando decisão humana.',
      owner: null, evidence: { esporte: 'Soccer', candidates: 5 }, occurrences: 1, reopenCount: 0,
      when: '13/06 12:40', whenRelativo: 'há 38 min', desde: 'há 38 min', desdeAbsoluto: '13/06 12:40', resolutionNote: null, href: null },
    { id: 'a4', area: 'incidentes',
      title: 'Cota pinnacle17 normalizada', risk: 'MEDIUM', status: 'RESOLVED',
      description: 'O período anterior encerrou e o consumo voltou à faixa segura.',
      owner: 'system', evidence: { periodo: '2026-06-12' }, occurrences: 1, reopenCount: 0,
      when: '13/06 00:02', whenRelativo: 'há 13 h', desde: 'há 15 h', desdeAbsoluto: '12/06 22:30', resolutionNote: 'Condição normalizada na reconciliação automática.', href: null },
    { id: 'a5', area: 'incidentes', actionType: "incident.review",
      title: "Escritas fora do fluxo automático", risk: 'LOW', status: 'OPEN',
      description: "🧾 Mudanças feitas fora do fluxo normal (24h até 2026-09-25)\n0 sem autor identificado, 1 feitas por agente a seu pedido.\n🤝 agent:claude:por:fabricio: 10 (pgboss_queue.delete, ops.apagar_apostas, operational_action.auto_resolved)\n👉 Confira se cada uma foi pedida por você e está correta.",
      owner: null, evidence: {"dia": "2026-09-25", "escritas": [{"quem": "agent:claude:por:fabricio", "acoes": ["pgboss_queue.delete", "ops.apagar_apostas", "operational_action.auto_resolved"], "origem": "delegated", "eventos": 10}], "autoResolve": false}, occurrences: 1, reopenCount: 0,
      when: '25/09 03:45', whenRelativo: 'há 8 h', desde: 'há 8 h', desdeAbsoluto: '25/09 03:45', resolutionNote: null, href: null },
    { id: 'a6', area: 'captura', actionType: "incident.review",
      title: "Jorge Neves: recusas repetidas (Total sem dizer a unidade (gols, escanteios ou cartões))", risk: 'HIGH', status: 'OPEN',
      description: "🔁 Recusas repetidas · Jorge Neves\n4 posts recusados em 24 h pelo mesmo motivo: Total sem dizer a unidade (gols, escanteios ou cartões).\n👉 Se o canal não é de futebol, defina os esportes dele em Config › Tipsters; se é, só o post dizendo a unidade do total resolve.\nEnquanto isso, as próximas recusas deste motivo ficam só na caixa de ações, cada post com a sua pendência.\nÚltimo post: https://t.me/c/4496161582/411",
      owner: null, evidence: {"posts": 4, "reason": "mercado_total_ambiguo", "lastMessageId": 411}, occurrences: 1, reopenCount: 0,
      when: '25/09 11:02', whenRelativo: 'há 3 h', desde: 'há 3 h', desdeAbsoluto: '25/09 11:02', resolutionNote: null, href: null },
    { id: 'a7', area: 'captura', actionType: "capture_review",
      title: "Target: conferir bilhete da mensagem 633", risk: 'MEDIUM', status: 'OPEN',
      description: "A extração não preservou todos os confrontos, seleções ou evidências da mensagem. Confira a fonte original.",
      owner: null, evidence: {"link": "https://t.me/c/4403068924/633", "reason": "incomplete_fixture", "caption": "Tipster: Target\\nData: 24/09/2026\\nJogo: TRIPLA\\nEntrada: Anadolu and Olympiacos and Maccabi ML\\nODD: 4.33\\nMínima: 3.5\\nStake: 0.5u", "editDate": null, "postDate": "2026-09-23T23:40:17.000Z", "extraction": {"odds": 4.33, "stake": 0.5, "mercado": "Múltipla", "selecao": "Anadolu, Olympiacos, Maccabi", "evento": "Anadolu", "dataTexto": "24/09/2026", "ticketType": "accumulator", "items": [{"evento": "Anadolu", "mercado": "Money Line – Match", "selecao": "Anadolu", "dataTexto": "24/09/2026"}, {"evento": "Olympiacos", "mercado": "Money Line – Match", "selecao": "Olympiacos", "dataTexto": "24/09/2026"}, {"evento": "Maccabi", "mercado": "Money Line – Match", "selecao": "Maccabi", "dataTexto": "24/09/2026"}]}, "autoResolve": false, "mediaFileId": null}, occurrences: 1, reopenCount: 0,
      when: '24/09 20:40', whenRelativo: 'há 16 h', desde: 'há 16 h', desdeAbsoluto: '24/09 20:40', resolutionNote: null, href: null },
  ] satisfies MockAction[]).map(withReading),

  slo: [
    { id: 'queue-closing', kind: 'queue', name: 'closing.sync', samples: 96, errors: 0, success: 100, p95: 1840, lagP95: 920, status: 'healthy', reasons: [], last: 'agora' },
    { id: 'provider-bridge', kind: 'provider', name: 'bridgeodds.opening-closing/:id', samples: 184, errors: 2, success: 98.9, p95: 2410, lagP95: null, status: 'healthy', reasons: [], last: 'agora' },
    { id: 'action-settle', kind: 'action', name: 'bet.settle', samples: 12, errors: 0, success: 100, p95: 310, lagP95: null, status: 'healthy', reasons: [], last: 'há 1 h' },
  ],

  // Os quatro estados do veredito, do mais novo para o mais velho.
  releases: [
    { id: 'auto-6711865-20260613-6711865', sha: '6711865', at: '13/06 12:40', ago: 'há 38 min', state: 'em_observacao',
      verdictFrom: '13:25', commitUrl: 'https://github.com/fraudicioschimidt/automabaca-novo/commit/6711865aa2b3c4d5e6f708192a3b4c5d6e7f8091',
      compareUrl: 'https://github.com/fraudicioschimidt/automabaca-novo/compare/5595c532bb2b3c4d5e6f708192a3b4c5d6e7f809...6711865aa2b3c4d5e6f708192a3b4c5d6e7f8091',
      knownErrors: null, notice: null, findings: [], belowThreshold: [] },
    { id: 'auto-5595c53-20260613-5595c53', sha: '5595c53', at: '13/06 11:02', ago: 'há 2 h', state: 'erro_novo',
      verdictFrom: '11:47', commitUrl: 'https://github.com/fraudicioschimidt/automabaca-novo/commit/5595c532bb2b3c4d5e6f708192a3b4c5d6e7f809',
      compareUrl: 'https://github.com/fraudicioschimidt/automabaca-novo/compare/aac63afacc2b3c4d5e6f708192a3b4c5d6e7f809...5595c532bb2b3c4d5e6f708192a3b4c5d6e7f809',
      knownErrors: 2, notice: 'sent',
      findings: [
        { id: 'sharp.enrich:TypeError', queue: 'sharp.enrich', text: "TypeError: Cannot read properties of undefined (reading 'odds')", occurrences: 7, jobs: 2, firstAt: '11:06' },
      ],
      belowThreshold: [] },
    { id: 'auto-aac63af-20260613-aac63af', sha: 'aac63af', at: '13/06 10:21', ago: 'há 3 h', state: 'sem_erro_novo',
      verdictFrom: '11:06', commitUrl: 'https://github.com/fraudicioschimidt/automabaca-novo/commit/aac63afacc2b3c4d5e6f708192a3b4c5d6e7f809',
      compareUrl: null, knownErrors: 4, notice: null, findings: [],
      belowThreshold: [
        { id: 'closing.price_series:ZodError', queue: 'closing.price_series', text: 'ZodError: Expected number, received null', occurrences: 2, jobs: 2, firstAt: '10:40' },
      ] },
    { id: 'ci-self-hosted-20260611-6e9b28c', sha: '6e9b28c', at: '11/06 22:10', ago: 'há 1 d', state: 'sem_veredito',
      verdictFrom: '22:55', commitUrl: 'https://github.com/fraudicioschimidt/automabaca-novo/commit/6e9b28c8dd2b3c4d5e6f708192a3b4c5d6e7f809',
      compareUrl: null, knownErrors: null, notice: null, findings: [], belowThreshold: [] },
  ],
  releasesFlagged24h: 1,

  jobsAvailable: true,
  jobsTotal: 20,
  // Resultado de aposta já liquidada reescrito depois (recalc ao vivo, edição
  // do post): o cartão existe para que isso apareça na tela.
  reliquidacao: {
    apostas: 2, eventos: 3,
    recentes: [
      { betId: 'b1', evento: 'Gremio vs Mirassol', de: 'VOID', para: 'LOST', fonte: 'ação manual (new-bot:recalc-ah-live)', em: '2026-08-12T19:12:00.000Z' },
      { betId: 'b2', evento: 'Bage vs Lajeadense', de: 'LOST', para: 'HALF_WON', fonte: 'edição do post no canal', em: '2026-08-11T22:04:00.000Z' },
      { betId: 'b1', evento: 'Gremio vs Mirassol', de: 'LOST', para: 'VOID', fonte: 'edição do post no canal', em: '2026-08-05T22:12:00.000Z' },
    ],
  },
  // Forma AGRUPADA por (fila, causa): linhas planas do mesmo incidente são o
  // defeito que o cartão evita. Os grupos cobrem quatro causas distintas
  // (circuito aberto, tempo, provider, deploy).
  jobs: [
    {
      id: 'sharp.enrich.dlq::circuito_aberto', name: 'sharp.enrich.dlq',
      causa: 'circuito aberto — nós cortamos o provider',
      proximaEtapa: 'Espere o circuito fechar; replay agora falha na hora.',
      n: 15, at: '08/06 08:30 – 14:00',
      bets: ['4e0a9eed-7cdf-449c-8cdb-255aab8bbd7b', 'b3791a01-4df0-488a-ae39-fd1c94dcb357'],
      replay: true, replayHabilitado: false,
      motivoBloqueio: 'Espere o circuito fechar; replay agora falha na hora.',
      replayJobIds: Array.from({ length: 15 }, (_, i) => `j-circ-${i + 1}`),
    },
    {
      id: 'sharp.enrich.dlq::tempo_esgotado', name: 'sharp.enrich.dlq',
      causa: 'o job estourou o tempo',
      proximaEtapa: 'Replay uma vez; se repetir, é lentidão do provider ou bug.',
      n: 3, at: '10/06 12:40 – 19:05', bets: ['33c8682c-9861-452c-9843-1a799b6183a9'],
      replay: true, replayHabilitado: true, motivoBloqueio: null,
      replayJobIds: ['j-tmo-1', 'j-tmo-2', 'j-tmo-3'],
    },
    {
      id: 'sharp.enrich::provider_fora', name: 'sharp.enrich',
      causa: 'o provider não respondeu',
      proximaEtapa: 'Já tratada: a cópia saiu da dead-letter (reenfileirada, descartada ou reprocessada).',
      n: 1, at: '09/06 13:00', bets: ['8964cb5f-04d6-4608-9ecc-8216bbe8517e'],
      // Fila de ORIGEM: histórico de falha já tratada, sem botão.
      replay: false, replayHabilitado: false, motivoBloqueio: null,
      replayJobIds: [],
    },
    {
      id: 'sharp.enrich::worker_saiu', name: 'sharp.enrich',
      causa: 'o worker saiu no meio do trabalho',
      proximaEtapa: 'Já tratada: a cópia saiu da dead-letter (reenfileirada, descartada ou reprocessada).',
      n: 1, at: '11/06 10:15', bets: ['6b284db2-6c70-41d3-a71f-0ea549e7059b'],
      replay: false, replayHabilitado: false, motivoBloqueio: null, replayJobIds: [],
    },
  ],

  noOdds: lacunaNaTela([
    { lado: 'abertura', reason: 'line_mismatch', n: 1, segmentos: 1, topoSegmento: 'Austria · Landesliga', topoN: 1 },
  ]),

  budgets: [
    { name: 'bridgeodds', period: '2026-07-09T21', used: 41, cap: 900, label: '900/h (informado 1.000/h)', janelaDoCusto: 'hour', rendimento: { identidade: 12, fechamento: 25 } },
    { name: 'pinnacle17', period: '2026-06-13', used: 74, cap: 9500, label: '9.500/dia (Ultra 10.000/dia; reserva 500)', janelaDoCusto: 'day', rendimento: { identidade: 30, fechamento: 38 } },
  ],

  probation: [], // Nenhum segmento avaliado — tudo em probation implícita.

  orphanChannels: [],
  orphanChannelsTotal: 0,
  channels: [
    { id: 'ch1', name: 'Big Data', tg: '-1004262961788', state: 'degraded', parse: 100, total: 10, ok: 10, parseFailureTotal: 0, parseDescartadas: 1, captures: 13, last: '12/06 20:51',
      parsePerdas: [], identity: 100, identityResolved: 10, identityPending: 0, identityFailed: 0,
      noOdds: [{ reason: 'sem_linha_atual', label: 'Pinnacle sem linha atual', n: 1 }], resolutionP50: '4 min', resolutionP95: '11 min', resolutionSamples: 10, preKickoffFailures: 0, transientFailures: 1, transientBatchLimit: 100, discardedTotal: 0, discarded: [], orphan: false,
      lastUpdate: 'há 4 min', silence: null, latencyP50: '1 min', latencyP95: '3 min', latencySamples: 12 },
    { id: 'ch2', name: 'Sharp Alerts BR', tg: '-1004119872031', state: 'degraded', parse: 92, total: 25, ok: 23, parseFailureTotal: 2, parseDescartadas: 0, captures: 41, last: '13/06 11:08',
      parsePerdas: [{ motivo: 'odd_legenda_ausente', rotulo: 'legenda sem a odd', classe: 'legenda_incompleta', proximaEtapa: 'a odd decide o lucro', n: 2 }], identity: 96, identityResolved: 24, identityPending: 1, identityFailed: 1,
      noOdds: [{ reason: 'line_mismatch', label: 'linha diferente da casa', n: 3 }], resolutionP50: '7 min', resolutionP95: '28 min', resolutionSamples: 24, preKickoffFailures: 1, transientFailures: 3, transientBatchLimit: 100, discardedTotal: 0, discarded: [], orphan: false,
      lastUpdate: 'há 2 h', silence: { kind: 'aprendendo', detail: 'ainda aprendendo o ritmo do canal' }, latencyP50: '2 min', latencyP95: '14 min', latencySamples: 23 },
    { id: 'ch3', name: 'Value Hunter', tg: '-1003884520177', state: 'degraded', parse: 74, total: 19, ok: 14, parseFailureTotal: 5, parseDescartadas: 2, captures: 22, last: '13/06 09:33',
      parsePerdas: [{ motivo: 'selecao_ausente', rotulo: 'post sem dizer qual é a aposta', classe: 'legenda_incompleta', proximaEtapa: 'sem seleção não há o que liquidar', n: 3 }, { motivo: 'stake_invalido', rotulo: 'stake ilegível', classe: 'legenda_incompleta', proximaEtapa: 'sem stake não há exposição', n: 2 }], identity: 79, identityResolved: 15, identityPending: 2, identityFailed: 4,
      noOdds: [{ reason: 'no_prices', label: 'sem preços na linha', n: 4 }], resolutionP50: '18 min', resolutionP95: '1.4 h', resolutionSamples: 15, preKickoffFailures: 3, transientFailures: 4, transientBatchLimit: 100, discardedTotal: 7,
      discarded: [
        { messageId: 4814, photo: true, text: 'Over 150.5 pontos 1u', reason: 'captura do canal pausada', postedAt: '13/06 09:20', age: 'há 32 min', stale: false, captureRequestedAt: null, link: 'https://t.me/c/3884520177/4814' },
        { messageId: 4812, photo: false, text: 'Flamengo x Palmeiras\nAmbas marcam sim', reason: 'não parecia aposta', postedAt: '13/06 09:12', age: 'há 40 min', stale: false, captureRequestedAt: null, link: 'https://t.me/c/3884520177/4812' },
        { messageId: 4807, photo: false, text: 'Bom dia, galera! Hoje tem rodada cheia 🙌', reason: 'não parecia aposta', postedAt: '13/06 08:02', age: 'há 5 h', stale: true, captureRequestedAt: '13/06 09:40', link: 'https://t.me/c/3884520177/4807' },
      ], orphan: false,
      lastUpdate: 'há 9 h', silence: { kind: 'mudo', detail: 'calado há 9.0 h; o normal é até 6.0 h' }, latencyP50: '3 min', latencyP95: '22 min', latencySamples: 14 },
  ],
};

/** As duas telas leem recortes diferentes do mesmo cockpit. */
export const OPERACOES_MOCK: OperacoesData = OPS;
export const MONITORAMENTO_MOCK: MonitoramentoData = {
  ...OPS,
  ocrModels: { available: true, evaluation: false, generatedAt: '2026-06-13T15:45:00.000Z', periods: [], comparisons: [], readers: [7].map((days) => ({ days, rows: [
    { kind: 'rule' as const, provider: null, model: null, endpoint: null, contractVersion: null, registered: 48, corrected: 3,
      fields: { evento: 0, mercado: 2, selecao: 1, linha: 0, odds: 0, stake: 1 } },
    { kind: 'llm' as const, provider: 'gemini', model: 'gemini-3.1-flash-lite', endpoint: 'generate', contractVersion: 'bet-extraction-v2', registered: 9, corrected: 2,
      fields: { evento: 1, mercado: 0, selecao: 0, linha: 1, odds: 1, stake: 0 } },
  ] })) },
};
