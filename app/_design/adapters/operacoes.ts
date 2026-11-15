import "server-only";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import {
  formatDurationMinutes as durationLabel, formatSpDateTime, formatSpDayMonth, formatSpTime, spDayKey, spRelative,
} from "@/src/domain/dates";
import { fonteDeFrescor, frescorDaFonte } from "@/src/domain/frescor";
import { isOutrightMarket } from "@/src/domain/mercados/classify";
import { toNumber } from "@/src/domain/money";
import { noOddsReasonLabel } from "@/src/domain/no-odds-reason";
import {
  channelMonitoramentoState,
  deriveMonitoramentoSummary,
} from "@/src/domain/monitoramento-health";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";
import { releaseCommitUrl, releaseCompareUrl } from "@/src/domain/release-verdict";
import { trainingCaseReasonLabel, trainingCaseReasonTag } from "@/src/domain/training-case-reason";
import { sportsSourceForDisplay } from "@/src/domain/trusted-sports-source-url";
import { readLogArchiveHealth, type BackupHealth } from "@/src/infra/observability-status";
import { getRecentReleases, type ReleaseOverview } from "@/src/services/ops/release-verdict";
import { getOperationalSlos } from "@/src/services/ops/slo/slo";
import { getResumoDeReliquidacao } from "@/src/services/painel/aposta/reliquidacao";
import { getOcrModelsReport } from "@/src/services/painel/ocr-models";
import { getPainelOperationalActions } from "@/src/services/painel/operacoes/actions";
import { getProviderBudgets } from "@/src/services/painel/operacoes/budgets";
import { getCanaisMonitorados, type ChannelHealth } from "@/src/services/painel/operacoes/channels";
import type { DiscardReason } from "@/src/services/capture/channel/channel-post-archive";
import { JANELA_DE_JOGO_MS } from "@/src/domain/entrada-ao-vivo";
import { telegramPostLink } from "@/src/domain/telegram-source";
import { getSegmentPolicies, getSemOddsPorMotivo } from "@/src/services/painel/operacoes/cobertura";
import { getJobFailures, type FalhaAgrupada } from "@/src/services/painel/operacoes/falhas";
import {
  countCasosAbertos,
  countSharpPendentes,
  getCasosAbertos,
  getMatchingOverlap,
  getSharpPendentes,
} from "@/src/services/painel/operacoes/filas";
import { getSaudeMotor, workerVivo, type SaudeMotor } from "@/src/services/painel/operacoes/saude";
import {
  getSettlementManual,
  type SettlementManualRow,
} from "@/src/services/painel/operacoes/settlement-manual";
import type { CaseCandidate } from "@/src/services/sharp/training-resolve";
import {
  dismissOrphanedIaJudgeSuggestions,
  getPendingIaJudgeSuggestionsPage,
} from "@/src/services/settlement/ia-judge/suggestions";
import { lacunaNaTela } from "../lib/lacuna-na-tela";
import { contagem, plural } from "../lib/plural";
import { semEmoji } from "../lib/texto-de-ui";
import { readAction } from "../lib/action-reading";
import { splitEvento } from "./_evento";

/**
 * Dados das telas Operações (filas acionáveis) e Monitoramento (saúde e
 * capacidade). Cada tela lê só as seções dela, e cada seção é convertida aqui
 * uma vez, do resultado do serviço para a forma que a tela consome.
 * Mock equivalente: app/_design/mock/operacoes.ts.
 */

// ───────────── Operações ─────────────

/** Filas acionáveis; não carrega telemetria nem histórico. */
export async function getOperacoesData() {
  const saude = await getSaudeMotor();
  if (!saude.dbOk) {
    return {
      available: false,
      engine: engineCard(saude, 0),
      matchingTotal: 0,
      sharpSemMatchTotal: 0,
      matchingSharpSobrepostos: 0,
      iaJudgeSuggestionTotal: 0,
      iaJudgeSuggestions: [],
      settlement: [],
      matching: [],
      sharp: [],
    };
  }
  // Liquidar esconde a aposta com sugestão pendente: uma sugestão desatualizada
  // ainda PENDING a tiraria das duas filas neste carregamento.
  await dismissOrphanedIaJudgeSuggestions();
  // Um instante só: a visibilidade dos casos de Vincular depende da hora, e as
  // contagens abaixo precisam cortar no mesmo ponto para somarem certo.
  const now = new Date();
  const [pendentesTotal, pendentes, casos, casosTotal, overlap, settlement, iaPage] = await Promise.all([
    countSharpPendentes(),
    getSharpPendentes(now),
    getCasosAbertos(now),
    countCasosAbertos(now),
    getMatchingOverlap(now),
    getSettlementManual(),
    getPendingIaJudgeSuggestionsPage(),
  ]);
  return {
    available: true,
    engine: engineCard(saude, pendentesTotal),
    // Totais do backlog, separados das listas paginadas. `settlement` não tem
    // total: o take 500 fica muito acima do que o operador acumula, e passar
    // dele dispara alerta.
    matchingTotal: casosTotal,
    // "Precisa de você" soma as filas menos a interseção (a mesma aposta cai nas duas).
    sharpSemMatchTotal: overlap.semMatchTotal,
    matchingSharpSobrepostos: overlap.sobrepostos,
    iaJudgeSuggestionTotal: iaPage.total,
    iaJudgeSuggestions: iaPage.items.map(iaJudgeRow),
    settlement: settlement.map(settlementRow),
    matching: casos.map(matchingRow),
    sharp: pendentes.map((p) => ({
      id: p.betId,
      ...splitEvento(p.bet.evento),
      region: p.bet.esporte,
      kickoff: formatSpDateTime(p.bet.data),
      tried: spRelative(p.updatedAt),
      state: sharpState(p.identityStatus),
      identityStatus: p.identityStatus,
      inLinkQueue: p.bet.trainingCases.length > 0,
    })),
  };
}

function iaJudgeRow(s: Awaited<ReturnType<typeof getPendingIaJudgeSuggestionsPage>>["items"][number]) {
  const fromFlashscore = s.evidenceKind === "FLASHSCORE_STRUCTURED";
  return {
    id: s.id,
    betId: s.betId,
    ...splitEvento(s.bet.evento),
    region: [s.bet.pais, s.bet.competicao].filter(Boolean).join(" · ") || s.bet.esporte,
    market: s.bet.mercado,
    pick: s.bet.selecao,
    odds: toNumber(s.bet.odds),
    stake: toNumber(s.bet.stake),
    // `data` é o kickoff (o IA-Judge só pega aposta com horário), não o fim do jogo.
    started: spRelative(s.bet.data),
    suggestedStatus: s.suggestedStatus,
    valueFound: s.valueFound,
    confidence: s.confidence,
    reason: s.reason,
    sourceUrl: sportsSourceForDisplay(s.sourceUrl, s.groundingSources)?.url ?? null,
    fromFlashscore,
    ruleBased: fromFlashscore && s.provider.startsWith("flashscore-"),
    provider: s.provider,
    at: formatSpDateTime(s.createdAt),
  };
}

function settlementRow(s: SettlementManualRow) {
  return {
    id: s.betId,
    version: s.manualSettlementVersion,
    ...splitEvento(s.evento),
    region: [s.pais, s.competicao].filter(Boolean).join(" · ") || s.esporte,
    market: s.mercado,
    pick: s.selecao,
    odds: s.odds,
    stake: s.stake,
    // `data` é o kickoff, não o fim do jogo; sem horário, é só o dia dele.
    when: s.cause.kind === "inferred_kickoff" ? `jogo de ${formatSpDayMonth(s.data)}` : `começou ${spRelative(s.data)}`,
    tipster: s.tipster || null,
    bankrollNome: s.bankrollNome,
    reason: settlementReason(s),
    // A liquidação recusa ½ fora da linha asiática fracionária; a tela nem o oferece.
    allowsHalfResult: admitsAsianFractionalSettlement(s.mercado, s.selecao),
  };
}

function matchingRow(c: Awaited<ReturnType<typeof getCasosAbertos>>[number]) {
  const verdict = c.llmVerdictJson as { source?: string; reason?: string } | null;
  const doMatching = verdict?.source === "matching";
  return {
    id: c.id,
    betId: c.betId,
    ...splitEvento(c.evento),
    region: [c.esporte, c.competicao].filter(Boolean).join(" · "),
    kickoff: c.bet?.data ? formatSpDateTime(c.bet.data) : "—",
    llmReason: doMatching ? null : verdict?.reason ?? null,
    matchingReason: doMatching && verdict.reason ? trainingCaseReasonLabel(verdict.reason) : null,
    motivo: doMatching && verdict.reason
      ? trainingCaseReasonTag(verdict.reason)
      : verdict?.reason ? "veredito do juiz de IA" : null,
    candidates: normalizeCandidates(Array.isArray(c.candidatesJson) ? (c.candidatesJson as unknown[]) : [], c.bet?.data ?? null),
  };
}

/** O que o FlashScore disse ao fechar a observação sem liquidar. */
const FLASHSCORE_REFUSAL: Record<string, string> = {
  manual_missing_stats: "o FlashScore não publicou a estatística",
  manual_extra_time: "foi à prorrogação — confira o tempo regulamentar",
  manual_regra_de_adiamento_da_casa: "adiado — vale a regra da casa",
};

/** O que o FlashScore espera com o jogo casado, pela última decisão dele. */
const FLASHSCORE_WAITING: Record<string, string> = {
  not_attempted: "o FlashScore achou o jogo, mas ainda não o viu terminar",
  score_pending: "o FlashScore viu o fim do jogo, mas sem placar",
  postponed_waiting: "adiado e sem remarcação depois de 48 h",
};

/** Por que ainda não há resultado, pela última observação do FlashScore. */
const FLASHSCORE_STALLED: Record<string, string> = {
  matched: "o FlashScore achou o jogo, mas não tem o resultado",
  unsupported_sport: "o FlashScore não cobre este esporte",
  sport_without_terminal_status: "o FlashScore não diz quando este esporte termina",
  invalid_event: "evento sem os dois times — o FlashScore não procura",
};

/** O que o automático fez com a aposta: é o que o dono precisa saber para liquidá-la. */
function settlementReason(s: SettlementManualRow): string {
  const { cause } = s;
  switch (cause.kind) {
    case "inferred_kickoff":
      return "horário inferido — nenhum liquidador automático pega";
    case "unconfirmed_sport":
      return "esporte não confirmado — o automático não liquida";
    case "flashscore_refused":
      return FLASHSCORE_REFUSAL[cause.settlementOutcome ?? ""] ?? "o FlashScore viu o fim do jogo, mas não liquidou";
    case "stalled":
      if (isOutrightMarket(s.mercado)) return "outright — não se resolve por uma partida";
      if (cause.flashscoreOutcome === null) return "o FlashScore ainda não observou o jogo";
      return FLASHSCORE_WAITING[cause.settlementOutcome ?? ""] ?? FLASHSCORE_STALLED[cause.flashscoreOutcome]
        ?? "o FlashScore não achou o jogo";
  }
}

function sharpState(identityStatus: string): string {
  return identityStatus === "PENDING" ? "aguardando" : "sem par";
}

/**
 * O horário do candidato é o que a aposta passa a ter: ida e volta, série de
 * playoff e tênis têm os mesmos nomes e só a data os separa.
 */
function normalizeCandidates(raw: unknown[], betKickoff: Date | null) {
  return raw.map((candidate, index) => {
    const item = candidate as Partial<CaseCandidate>;
    const score = typeof item.score === "number" ? (item.score > 1 ? item.score / 100 : item.score) : 0;
    const matchDate = typeof item.matchDate === "string" ? new Date(item.matchDate) : null;
    const kickoff = matchDate && !Number.isNaN(matchDate.getTime()) ? matchDate : null;
    return {
      id: item.matchId != null ? String(item.matchId) : `c${index}`,
      index,
      candidateHash: canonicalSha256(candidate),
      label: item.home && item.away ? `${item.home} vs ${item.away}` : item.league ?? "candidato",
      league: item.league ?? "—",
      kickoff: kickoff ? formatSpDateTime(kickoff) : null,
      dayShift: kickoff && betKickoff ? dayShiftLabel(kickoff, betKickoff) : null,
      swapped: item.swapped === true,
      score: Math.max(0, Math.min(1, score)),
    };
  });
}

/** "2 dias depois do kickoff" quando o jogo do candidato cai noutro dia de São Paulo; null no mesmo dia. */
function dayShiftLabel(candidate: Date, betKickoff: Date): string | null {
  const days = Math.round((Date.parse(spDayKey(candidate)) - Date.parse(spDayKey(betKickoff))) / 86_400_000);
  if (days === 0) return null;
  return `${contagem(Math.abs(days), "dia")} ${days > 0 ? "depois" : "antes"} do kickoff`;
}

// ───────────── Monitoramento ─────────────

async function readMonitoringSections(now: Date) {
  const desde30d = new Date(now.getTime() - 30 * 86_400_000);
  const [
    pendentesTotal, falhas, budgets, canais, semOdds, segmentos,
    slo24h, slo1h, acoes, reliquidacao, recentReleases,
  ] = await Promise.all([
    countSharpPendentes(),
    getJobFailures(now),
    getProviderBudgets(now),
    getCanaisMonitorados(now),
    getSemOddsPorMotivo(desde30d),
    getSegmentPolicies(),
    getOperationalSlos(24),
    getOperationalSlos(1),
    getPainelOperationalActions(),
    // Resultado trocado depois de liquidado: sem isto, descobrir exigia abrir aposta por aposta.
    getResumoDeReliquidacao(desde30d),
    getRecentReleases(10, now),
  ]);
  return { pendentesTotal, falhas, budgets, canais, semOdds, segmentos, slo24h, slo1h, acoes, reliquidacao, recentReleases };
}

type MonitoringSections = Awaited<ReturnType<typeof readMonitoringSections>>;

/** Banco fora: seções vazias, e `available: false` avisa que vazio não é zero. */
const MONITORING_UNAVAILABLE: MonitoringSections = {
  pendentesTotal: 0,
  falhas: { disponivel: false, total: 0, retidas: 0, grupos: [] },
  budgets: [],
  canais: { canais: [], orfaos: [], orfaosTotal: 0 },
  semOdds: [],
  segmentos: [],
  slo24h: [],
  slo1h: [],
  acoes: { acoes: [], totais: { abertas: 0, assumidas: 0, encerradas: 0, acionaveis: 0 } },
  reliquidacao: { apostas: 0, eventos: 0, recentes: [] },
  recentReleases: { releases: [], flaggedLast24h: 0 },
};

/** Saúde e capacidade; não consulta settlement, IA-Judge nem listas acionáveis. */
export async function getMonitoramentoData() {
  const now = new Date();
  // O backup vem do vigia do host, não do banco: aparece mesmo com o banco fora.
  const [saude, ocrModels, hostHealth] = await Promise.all([getSaudeMotor(), getOcrModelsReport(), readLogArchiveHealth()]);
  const s = saude.dbOk ? await readMonitoringSections(now) : MONITORING_UNAVAILABLE;
  const engine = engineCard(saude, s.pendentesTotal);
  const channels = s.canais.canais.map((canal) => channelRow(canal, now));
  const { totais } = s.acoes;
  return {
    ocrModels,
    available: saude.dbOk,
    summary: deriveMonitoramentoSummary({
      available: saude.dbOk,
      workerOk: engine.worker.ok,
      bancoOk: engine.banco.ok,
      closingOk: engine.closing.ok,
      jobsAvailable: s.falhas.disponivel,
      // O que falta tratar: o histórico de 7 dias fica no cartão, fora do veredito.
      jobFailureTotal: s.falhas.retidas,
      openActions: totais.abertas,
      ackedActions: totais.assumidas,
      // O veredito responde "como está agora" (1h); a grade guarda 24h.
      sloBreachTotal: s.slo1h.filter((row) => row.status === "breach" && row.alerting).length,
      channelStates: channels.map((channel) => channel.state),
      orphanChannelTotal: s.canais.orfaosTotal,
    }),
    engine,
    backup: backupRow(hostHealth.backup),
    actions: s.acoes.acoes.map(actionRow),
    actionTotals: { OPEN: totais.abertas, ACKED: totais.assumidas, RESOLVED: totais.encerradas },
    slo: s.slo24h.map((row) => ({
      id: `${row.kind}-${row.name}`,
      kind: row.kind,
      name: row.name,
      samples: row.samples,
      errors: row.errors,
      success: row.successPct,
      p95: row.p95DurationMs,
      lagP95: row.p95QueueLagMs,
      status: row.status,
      reasons: row.reasons,
      last: formatSpDateTime(row.lastSeenAt),
    })),
    releases: s.recentReleases.releases.map((release) => releaseRow(release, now)),
    releasesFlagged24h: s.recentReleases.flaggedLast24h,
    jobs: s.falhas.grupos.map(jobRow),
    jobsAvailable: s.falhas.disponivel,
    jobsTotal: s.falhas.total,
    reliquidacao: s.reliquidacao,
    // Por motivo e separado nas três bases: fornecedor (cobertura), sistema
    // (conserto nosso) e `nao_se_aplica` (ao vivo, política da banca).
    noOdds: lacunaNaTela(s.semOdds),
    budgets: s.budgets,
    probation: s.segmentos.map((p) => ({
      id: `${p.esporte}-${p.mercado}`,
      esporte: p.esporte,
      mercado: p.mercado,
      phase: p.phase,
      source: p.source,
      bets: p.betsAvaliadas,
      clv: p.clvReliablePct === null ? null : toNumber(p.clvReliablePct),
      evaluatedAt: p.evaluatedAt ? formatSpDateTime(p.evaluatedAt) : null,
    })),
    channels,
    orphanChannels: s.canais.orfaos.map((c) => ({
      id: c.channelId,
      name: "Sem tipster",
      tg: c.channelId,
      parse: 0,
      total: 0,
      ok: 0,
      captures: c.postsPreservados,
      last: formatSpDateTime(c.ultimaVez),
      orphan: true,
    })),
    orphanChannelsTotal: s.canais.orfaosTotal,
  };
}

export type MonitoramentoData = Awaited<ReturnType<typeof getMonitoramentoData>>;

const MOTIVO_DO_DESCARTE: Record<DiscardReason, string> = {
  nao_parece_aposta: "não parecia aposta",
  resultado_ou_balanco: "resultado ou balanço",
  jogo_ja_terminado: "jogo já tinha terminado",
  canal_pausado: "captura do canal pausada",
  ia_nao_viu_aposta: "a IA leu e não viu aposta",
  captura_recusada: "a captura recusou a aposta lida",
  rascunho_incompleto: "leitura incompleta (falta stake, odd ou outro dado)",
};

/** Selo do canal: calado além do ritmo, ou ainda sem histórico para julgar. */
function silenceBadge(
  silence: ChannelHealth["activity"]["silence"],
  capturePaused: boolean,
): { kind: "mudo" | "aprendendo" | "pausado"; detail: string } | null {
  // Pausado pelo dono: o silêncio é esperado e não vira alerta.
  if (capturePaused) return { kind: "pausado", detail: "captura pausada em Config › Tipsters" };
  if (silence.state === "aprendendo") return { kind: "aprendendo", detail: "ainda aprendendo o ritmo do canal" };
  if (silence.state === "ok") return null;
  return { kind: "mudo", detail: `calado há ${durationLabel(silence.silentHours * 60)}; o normal é até ${durationLabel(silence.limitHours * 60)}` };
}

function channelRow(c: ChannelHealth, now: Date) {
  const parse = c.parse.taxaOk == null ? null : Math.round(c.parse.taxaOk);
  const identity = c.identity.taxaOk == null ? null : Math.round(c.identity.taxaOk);
  return {
    id: c.channelId,
    name: c.bankrollNome,
    tg: c.channelId,
    state: channelMonitoramentoState({
      parse,
      identity,
      preKickoffFailures: c.preKickoffFailures,
      transientFailures: c.transientFailures,
      silent: !c.capturePaused && c.activity.silence.state === "mudo",
      paused: c.capturePaused,
    }),
    parse,
    // A base da taxa é TENTATIVA (post que era aposta), não post lido: o
    // descarte correto sai do denominador, e o detalhe mostra a mesma base.
    total: c.parse.tentativas,
    ok: c.parse.ok,
    parseFailureTotal: c.parse.falhas,
    parseDescartadas: c.parse.descartadas,
    captures: c.capturas,
    last: c.ultimaCaptura ? formatSpDateTime(c.ultimaCaptura) : "—",
    // O que chegou do Telegram, antes da leitura: separa "canal calado" de "captura falhando".
    lastUpdate: c.activity.lastUpdateAt ? spRelative(c.activity.lastUpdateAt, now) : null,
    silence: silenceBadge(c.activity.silence, c.capturePaused),
    latencyP50: durationLabel(c.latency.p50Min),
    latencyP95: durationLabel(c.latency.p95Min),
    latencySamples: c.latency.samples,
    parsePerdas: c.parse.perdas,
    identity,
    identityResolved: c.identity.resolved,
    identityPending: c.identity.pending,
    identityFailed: c.identity.failed,
    noOdds: c.odds.faltas.map((f) => ({ reason: f.reason, label: noOddsReasonLabel(f.reason), n: f.n })),
    resolutionP50: durationLabel(c.resolution.p50Min),
    resolutionP95: durationLabel(c.resolution.p95Min),
    resolutionSamples: c.resolution.samples,
    preKickoffFailures: c.preKickoffFailures,
    transientFailures: c.transientFailures,
    transientBatchLimit: c.transientBatchLimit,
    // Posts que não viraram aposta (filtro, pausa, IA), com o texto para o operador julgar.
    discardedTotal: c.discarded.total,
    discarded: c.discarded.recent.map((post) => ({
      messageId: post.messageId,
      photo: post.kind === "photo",
      text: post.textTruncated ? `${post.text}…` : post.text,
      reason: MOTIVO_DO_DESCARTE[post.reason],
      postedAt: formatSpDateTime(post.postedAt),
      age: spRelative(post.postedAt, now),
      // Depois da janela de um jogo, capturar pode registrar jogo encerrado.
      stale: now.getTime() - post.postedAt.getTime() > JANELA_DE_JOGO_MS,
      captureRequestedAt: post.captureRequestedAt ? formatSpDateTime(post.captureRequestedAt) : null,
      link: telegramPostLink(c.channelId, post.messageId),
    })),
    orphan: false,
  };
}

/** Uma release com o veredito dela: os links levam ao commit (e ao PR) e às mudanças. */
function releaseRow(r: ReleaseOverview, now: Date) {
  return {
    id: r.releaseId,
    sha: r.sha.slice(0, 7),
    at: formatSpDateTime(r.readyAt),
    ago: spRelative(r.readyAt, now),
    state: r.state,
    verdictFrom: formatSpTime(r.observationEnd),
    commitUrl: releaseCommitUrl(r.sha),
    compareUrl: releaseCompareUrl(r.previousSha, r.sha),
    knownErrors: r.knownErrors,
    notice: r.notice,
    findings: r.findings.map(releaseFindingRow),
    belowThreshold: r.belowThreshold.map(releaseFindingRow),
  };
}

function releaseFindingRow(f: ReleaseOverview["findings"][number]) {
  return {
    id: `${f.queue}:${f.text}`,
    queue: f.queue,
    text: f.text,
    occurrences: f.occurrences,
    jobs: f.jobs,
    firstAt: formatSpTime(f.firstAt),
  };
}

/**
 * O backup diário como o vigia do host julgou: a tela não refaz a régua de
 * 26 h, e por isso o vermelho aqui é o mesmo que abre a ação e chama no Telegram.
 */
function backupRow(backup: BackupHealth | null) {
  if (!backup) return { status: "Sem leitura", note: "o vigia do servidor não publicou o estado do backup", ok: null };
  const last = backup.createdAt ? formatSpDateTime(new Date(backup.createdAt)) : null;
  if (backup.state === "fresh") {
    const bets = backup.bets == null ? null : `${backup.bets.toLocaleString("pt-BR")} ${plural(backup.bets, "aposta")} no backup`;
    return { status: "Em dia", note: [`conferido ${last ?? "—"}`, bets].filter(Boolean).join(" · "), ok: true };
  }
  const lastNote = last ? `último conferido ${last}` : "nenhum backup conferido";
  const failedNote = backup.failedAt ? `última tentativa falhou ${formatSpDateTime(new Date(backup.failedAt))}` : null;
  return backup.state === "failed"
    ? { status: "Falhou", note: [failedNote ?? "última tentativa falhou", lastNote].join(" · "), ok: false }
    : { status: "Atrasado", note: [lastNote, failedNote].filter(Boolean).join(" · "), ok: false };
}

/** Uma linha por incidente (fila + causa), não por ocorrência. */
function jobRow(j: FalhaAgrupada) {
  return {
    id: j.id,
    name: j.fila,
    causa: j.rotulo,
    proximaEtapa: j.proximaEtapa,
    n: j.n,
    // Uma data quando o incidente é pontual; a janela quando ele se repetiu.
    at: j.n === 1 ? formatSpDateTime(j.ultima) : janelaDeIncidente(j.primeira, j.ultima),
    // O array agregado, não um filtro re-derivado.
    bets: j.membros.flatMap((m) => (m.betId ? [m.betId] : [])),
    replay: j.replayable,
    replayHabilitado: j.replayHabilitado,
    motivoBloqueio: j.motivoBloqueio,
    // Mesma base do `n`: o clique trata todos os membros ainda na DLQ.
    replayJobIds: j.membros.map((m) => m.id),
  };
}

/**
 * A janela de um incidente repetido: `08/08 08:30 – 14:00` no mesmo dia,
 * `06/08 12:56 – 10/08 19:05` quando atravessa a meia-noite. Encurtar o fim
 * para só a hora num incidente de dias o faria parecer de horas.
 */
function janelaDeIncidente(primeira: Date, ultima: Date): string {
  const inicio = formatSpDateTime(primeira);
  const mesmoDia = spDayKey(primeira) === spDayKey(ultima);
  return `${inicio} – ${mesmoDia ? formatSpTime(ultima) : formatSpDateTime(ultima)}`;
}

type OperationalAction = Awaited<ReturnType<typeof getPainelOperationalActions>>["acoes"][number];

/**
 * `desde` sai de `openedAt`, a PRIMEIRA vez que a condição virou ação, não o
 * ciclo atual: um problema de semanas não pode aparecer como "desde há 17 h".
 */
function actionRow(item: OperationalAction) {
  return {
    id: item.id,
    area: item.area,
    title: semEmoji(item.title),
    description: semEmoji(item.description),
    // A leitura parte do texto cru: o 👉 é o que marca o próximo passo.
    reading: readAction({ title: item.title, description: item.description, actionType: item.actionType, evidence: item.evidence }),
    risk: item.risk,
    status: item.status,
    owner: rotuloDeResponsavel(item.owner),
    evidence: item.evidence,
    occurrences: item.occurrenceCount,
    resolutionNote: item.resolutionNote,
    href: incidentHref(item.resource, item.resourceId),
    when: formatSpDateTime(item.lastSeenAt),
    // Recência relativa ao lado do carimbo absoluto: "há 26 min" e "há 3 d"
    // pedem ações opostas, e o operador não faz a conta de cabeça.
    whenRelativo: spRelative(item.lastSeenAt),
    // A frase de histórico é decidida no cartão, que sabe quantos irmãos
    // idênticos a linha representa.
    desde: spRelative(item.openedAt),
    desdeAbsoluto: formatSpDateTime(item.openedAt),
    reopenCount: item.reopenCount,
  };
}

/**
 * `owner` guarda o ator de sistema "operator" em ações antigas. Traduz na borda
 * em vez de reescrever a coluna: nome de pessoa passa intacto.
 */
function rotuloDeResponsavel(owner: string | null): string | null {
  return owner === "operator" ? "operador" : owner;
}

/** O incidente abre a página do recurso: a ficha da aposta ou o detalhe da conta. */
export function incidentHref(resource: string | null, resourceId: string | null): string | null {
  if (!resourceId) return null;
  if (resource === "bet") return `/aposta?id=${encodeURIComponent(resourceId)}`;
  if (resource === "conta") return `/contas?acc=${encodeURIComponent(resourceId)}`;
  return null;
}

// ───────────── Comum às duas telas ─────────────

/**
 * Cartão do motor. As duas fontes com cadência saem de `domain/frescor`, o
 * mesmo cálculo da tira do Analyzer e da pill do Dashboard; a legenda do ciclo
 * sai da cadência declarada, não de um literal.
 */
function engineCard(saude: SaudeMotor, pendentesTotal: number) {
  const agora = new Date();
  const fonteCiclo = fonteDeFrescor("cicloDeFechamento");
  const frescorMotor = frescorDaFonte(fonteDeFrescor("motor"), saude.ultimoHeartbeat, agora);
  const frescorCiclo = frescorDaFonte(fonteCiclo, saude.ultimoClosing, agora);
  const vivo = workerVivo(saude);
  return {
    worker: { status: vivo ? "Ativo" : "Parado", since: frescorMotor.texto, ok: vivo },
    banco: { status: saude.dbOk ? "OK" : "Erro", note: "SELECT 1", ok: saude.dbOk },
    closing: {
      at: saude.ultimoClosing ? formatSpDateTime(saude.ultimoClosing) : "—",
      note: `ciclo a cada ${fonteCiclo.cadenciaMin} min`,
      ok: saude.ultimoClosing != null && !frescorCiclo.atrasada,
    },
    pending: { n: pendentesTotal, note: "aguardando Pinnacle / sem par" },
  };
}


