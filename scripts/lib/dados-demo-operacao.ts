import { createHash } from "node:crypto";
import { Client } from "pg";
import type { PgBoss, SendOptions } from "pg-boss";
import type { BetStatus, Prisma } from "@/src/generated/prisma/client";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";
import { createBoss } from "@/src/infra/boss";
import { getEnv } from "@/src/infra/env";
import { prisma } from "@/src/infra/prisma";
import { deadLetterOf, QUEUES } from "@/src/infra/queue-contract";
import { ensureQueueWithDeadLetter } from "@/src/jobs/queues";
import { effectiveQueueOptions, WORKER_JOBS } from "@/src/jobs/worker-jobs";
import { consumeProviderBudget } from "@/src/providers/budget";
import { findProviderCap, periodKeyFor } from "@/src/providers/budget-config";
import { editarBankroll } from "@/src/services/bankrolls/manage";
import { applyManualBetStatusChangeTx } from "@/src/services/bets/settle";
import { recordChannelActivity } from "@/src/services/capture/channel/channel-activity";
import { recordDiscardedChannelPost, recordUnmappedChannel, type DiscardReason } from "@/src/services/capture/channel/channel-post-archive";
import { recordParseTelemetry } from "@/src/services/capture/parse-telemetry";
import { checkEscritasForaDoFluxo } from "@/src/services/ops/consistency/escritas-fora-do-fluxo";
import { recordDeadLetterRetained } from "@/src/services/ops/dlq/repository";
import {
  acknowledgeOperationalAction, closeOperationalAction, reportOperationalAction, type OperationalActionEvidence,
} from "@/src/services/ops/operational-actions";
import { judgePendingReleases, recordReleaseReady } from "@/src/services/ops/release-verdict";
import { configuredOcrReaders } from "@/src/services/painel/ocr-models";
import { persistFlashscoreObservation } from "@/src/services/settlement/flashscore/observation-store";
import { persistSuggestion } from "@/src/services/settlement/ia-judge/suggestions";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { recordTrainingCase } from "@/src/services/sharp/enrich/training-cases";
import { upsertSharp } from "@/src/services/sharp/enrich/upsert-sharp";
import {
  DEMO_ACTOR, demoChannelId, gerador, LIGAS, PERFIS, registrar, voltarNoTempo,
  type Esporte, type Gravada, type Perfil, type PostLido, type Rng,
} from "./dados-demo";

/**
 * O lado operacional dos dados de exemplo: o que Operações e Monitoramento
 * leem. Roda depois de `gerarDadosDemo`, sobre as bancas de exemplo.
 *
 * O que tem banca vai nas apostas e posts dos canais de exemplo, e sai com a
 * exclusão da banca. O que é global carrega a marca `devDemo` (no payload do
 * job, nas labels da métrica, no id da release, na fonte da ação), e a limpeza
 * apaga só o que tem a marca. Nenhum job fica em estado que um worker pegaria
 * (`created`, `retry`, `active`): os de exemplo terminam concluídos ou falhos.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SEMENTE = 11;
/** Marca dos registros globais de exemplo; a limpeza procura por ela. */
const DEMO_MARK = { devDemo: DEMO_ACTOR } as const;
const DEMO_SOURCE_PREFIX = "dev-demo:";
const DEMO_RELEASE_PREFIX = "dev-demo-";
const BUDGET_ACTION = "dev-demo.provider_budget";
/** Canal fictício sem banca: aparece em Canais como "Sem tipster". */
const CANAL_SEM_BANCA = 9;
/** Os ids de mensagem das apostas de cenário, longe dos do histórico (1000 + 3i). */
const MENSAGEM_CENARIO = 50_000;

export type ResumoOperacaoDemo = {
  apagados: { jobs: number; metricas: number; acoes: number; releases: number; orcamentos: number };
  liquidarManual: number;
  vincular: number;
  homologar: number;
  sharpPendentes: number;
  reliquidadas: number;
  postsJulgados: number;
  descartados: number;
  jobsFalhos: number;
  jobsRetidos: number;
  metricas: number;
  releases: number;
  acoes: number;
};

// ─────────────────────────── Limpeza ───────────────────────────

/** Apaga os registros globais de exemplo (os das bancas saem com elas). */
async function apagarOperacaoDemo(): Promise<ResumoOperacaoDemo["apagados"]> {
  const marca = DEMO_MARK.devDemo;
  const jobIds = (await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id::text FROM pgboss.job WHERE data->>'devDemo' = ${marca} OR output->>'devDemo' = ${marca}
  `.catch((error: unknown) => {
    // Antes da primeira execução o schema do pg-boss pode não existir.
    if (String(error).includes("does not exist")) return [];
    throw error;
  })).map((row) => row.id);
  if (jobIds.length > 0) {
    await prisma.$executeRaw`DELETE FROM pgboss.job WHERE id = ANY(${jobIds}::uuid[])`;
    await prisma.auditEvent.deleteMany({ where: { action: "job.dlq_retained", resourceId: { in: jobIds } } });
  }
  const metricas = await prisma.$executeRaw`DELETE FROM operational_metrics WHERE labels->>'devDemo' = ${marca}`;

  const acoes = await prisma.operationalAction.findMany({
    where: { fingerprint: { startsWith: DEMO_SOURCE_PREFIX } }, select: { id: true },
  });
  // A revisão diária das escritas só de exemplo também é daqui; a que lista outro autor fica.
  const escritas = (await prisma.operationalAction.findMany({
    where: { fingerprint: { startsWith: "consistency.escritas-fora-do-fluxo:" } }, select: { id: true, evidence: true },
  })).filter((row) => {
    const lista = (row.evidence as { escritas?: Array<{ quem?: string }> } | null)?.escritas ?? [];
    return lista.length > 0 && lista.every((escrita) => escrita.quem?.includes(DEMO_ACTOR));
  });
  const acaoIds = [...acoes, ...escritas].map((row) => row.id);
  await prisma.auditEvent.deleteMany({ where: { resource: "operational_action", resourceId: { in: acaoIds } } });
  await prisma.operationalAction.deleteMany({ where: { id: { in: acaoIds } } });

  const releases = await prisma.auditEvent.deleteMany({
    where: { action: { in: ["release.ready", "release.verdict"] }, resource: "release", resourceId: { startsWith: DEMO_RELEASE_PREFIX } },
  });

  // O gasto de exemplo foi somado ao período do provider; volta a descontar o que somou.
  const gastos = await prisma.auditEvent.findMany({ where: { action: BUDGET_ACTION, actor: DEMO_ACTOR }, select: { id: true, details: true } });
  for (const gasto of gastos) {
    // `periodo`, não `periodKey`: a auditoria redige campo com "key" no nome.
    const { provider, periodo: periodKey, cost } = gasto.details as { provider: string; periodo: string; cost: number };
    await prisma.$executeRaw`
      UPDATE provider_budgets SET spent = GREATEST(spent - ${cost}, 0)
      WHERE provider = ${provider} AND "periodKey" = ${periodKey}`;
    await prisma.providerBudget.deleteMany({ where: { provider, periodKey, spent: 0, reserved: 0 } });
  }
  await prisma.auditEvent.deleteMany({ where: { id: { in: gastos.map((gasto) => gasto.id) } } });

  // Posts de canal e atividade são por chat; os chats de exemplo são só dos exemplos.
  const chats = [...PERFIS.map((perfil) => perfil.canal), CANAL_SEM_BANCA].map((canal) => demoChannelId(canal));
  await prisma.telegramChannelActivity.deleteMany({ where: { chatId: { in: chats } } });
  await prisma.auditEvent.deleteMany({
    where: {
      OR: [
        { action: "telegram.parse", resource: { in: chats.map(String) } },
        { action: "canal_sem_bankroll", resource: "telegram_channel", resourceId: { in: chats.map(String) } },
        { action: { in: ["canal_sem_bankroll_payload", "canal_post_descartado"] }, resource: "telegram_message",
          OR: chats.map((chat) => ({ resourceId: { startsWith: `${chat}:` } })) },
      ],
    },
  });
  return { jobs: jobIds.length, metricas, acoes: acaoIds.length, releases: releases.count, orcamentos: gastos.length };
}

// ─────────────────────────── Apostas de cenário ───────────────────────────

type Bancas = Map<number, { id: string; nome: string }>;

type Cenario = {
  canal: number;
  esporte: Esporte;
  liga: string;
  home: string;
  away: string;
  mercado: string;
  selecao: string;
  odds: number;
  stake?: number;
  /** Horas do kickoff em relação a agora (negativo: já começou). */
  kickoffH: number;
  /** Horas do post antes do kickoff. */
  antesH?: number;
  kickoffDateOnly?: boolean;
  esporteNaoConfirmado?: boolean;
  legs?: PostLido["legs"];
};

let proximaMensagem = MENSAGEM_CENARIO;

async function gravarCenario(cenario: Cenario, bancas: Bancas, now: Date): Promise<Gravada & { bankrollNome: string }> {
  const perfil = PERFIS.find((p) => p.canal === cenario.canal)!;
  const banca = bancas.get(cenario.canal)!;
  const kickoff = new Date(now.getTime() + cenario.kickoffH * HOUR);
  const postedAt = new Date(Math.min(kickoff.getTime() - (cenario.antesH ?? 3) * HOUR, now.getTime() - 5 * MINUTE));
  const post: PostLido = {
    perfil, esporte: cenario.esporte, liga: LIGAS[cenario.esporte][cenario.liga]!, jogo: { home: cenario.home, away: cenario.away },
    mercado: cenario.mercado, selecao: cenario.selecao, odds: cenario.odds, stake: cenario.stake ?? 1, kickoff, postedAt,
    kickoffDateOnly: cenario.kickoffDateOnly, esporteNaoConfirmado: cenario.esporteNaoConfirmado, legs: cenario.legs,
  };
  const gravada = await registrar(post, banca.id, proximaMensagem++);
  if (!gravada) throw new Error(`Aposta de cenário não gravada: ${cenario.home} vs ${cenario.away}`);
  await voltarNoTempo(gravada.betId, new Date(postedAt.getTime() + 20_000), null);
  return { ...gravada, bankrollNome: banca.nome };
}

async function identidade(betId: string, identityStatus: "MATCHED" | "PENDING" | "UNMATCHED", eventId: number): Promise<void> {
  await upsertSharp(betId, identityStatus === "MATCHED"
    ? { identityStatus, confidence: 96, provider: "pinnacle17", providerMatchId: String(eventId), noOddsReason: "unsupported_market" }
    : { identityStatus, confidence: identityStatus === "PENDING" ? 0 : 41 });
}

async function termosDaAposta(betId: string) {
  const bet = await prisma.bet.findUniqueOrThrow({
    where: { id: betId },
    select: {
      id: true, mercado: true, selecao: true, odds: true, stake: true, casaDeAposta: true, evento: true, esporte: true,
      competicao: true, pais: true, data: true, registradoEm: true, sourcePostedAt: true, kickoffInferido: true,
      liveScoreHome: true, liveScoreAway: true, legsJson: true,
    },
  });
  return bet;
}

/** A última olhada do FlashScore, gravada como a observação grava. */
async function observar(betId: string, observacao: { final: boolean; matchId?: string; snapshot: Prisma.InputJsonObject }, now: Date): Promise<void> {
  await persistFlashscoreObservation({
    bet: await termosDaAposta(betId), checkedAt: new Date(now.getTime() - 20 * MINUTE),
    final: observacao.final, snapshot: observacao.snapshot,
    ...(observacao.matchId ? { matchId: observacao.matchId, confidence: 0.94 } : {}),
  });
}

/**
 * Liquidação manual: uma aposta por motivo que a fila mostra, cada uma caindo
 * nela pela regra real (`getSettlementManual`).
 */
async function cenariosDeLiquidacao(bancas: Bancas, now: Date): Promise<number> {
  let n = 0;
  // Ninguém olhou ainda, 9 h depois do kickoff: passou do prazo do IA-Judge.
  const semOlhada = await gravarCenario({ canal: 1, esporte: "Soccer", liga: "premier", home: "Newcastle United", away: "Aston Villa",
    mercado: "Money Line – Match", selecao: "Newcastle United", odds: 2.08, stake: 1.5, kickoffH: -9 }, bancas, now);
  await identidade(semOlhada.betId, "MATCHED", 1_690_000_001);
  n++;

  const naoAchou = await gravarCenario({ canal: 2, esporte: "Soccer", liga: "argentina", home: "Estudiantes", away: "Velez Sarsfield",
    mercado: "Handicap – Match", selecao: "Estudiantes -0.25", odds: 1.93, stake: 2, kickoffH: -20 }, bancas, now);
  await identidade(naoAchou.betId, "MATCHED", 1_690_000_002);
  await observar(naoAchou.betId, { final: false, snapshot: { outcome: "not_found" } }, now);
  n++;

  const semCobertura = await gravarCenario({ canal: 5, esporte: "eSports", liga: "lol", home: "Top Esports", away: "Fnatic",
    mercado: "Handicap – Match", selecao: "Fnatic +1.5", odds: 1.72, kickoffH: -11 }, bancas, now);
  await identidade(semCobertura.betId, "MATCHED", 1_690_000_003);
  await observar(semCobertura.betId, { final: false, snapshot: { outcome: "unsupported_sport", sport: "eSports" } }, now);
  n++;

  const semPlacar = await gravarCenario({ canal: 3, esporte: "Basketball", liga: "euroleague", home: "Olympiacos", away: "AS Monaco",
    mercado: "Total – Match", selecao: "Under 164.5", odds: 1.9, stake: 1.25, kickoffH: -30 }, bancas, now);
  await identidade(semPlacar.betId, "MATCHED", 1_690_000_004);
  await observar(semPlacar.betId, { final: false, matchId: "fs-demo-4", snapshot: { outcome: "matched", settlementOutcome: "score_pending", finished: true } }, now);
  n++;

  const semEstatistica = await gravarCenario({ canal: 1, esporte: "Soccer", liga: "seriea", home: "Atalanta", away: "Fiorentina",
    mercado: "Total (Corners) – Match", selecao: "Over 9.5", odds: 1.87, kickoffH: -7 }, bancas, now);
  await identidade(semEstatistica.betId, "MATCHED", 1_690_000_005);
  await observar(semEstatistica.betId, { final: true, matchId: "fs-demo-5",
    snapshot: { outcome: "matched", settlementOutcome: "manual_missing_stats", finished: true, placar: "2-1" } }, now);
  n++;

  const prorrogacao = await gravarCenario({ canal: 8, esporte: "Basketball", liga: "nba", home: "Denver Nuggets", away: "Phoenix Suns",
    mercado: "Handicap – Match", selecao: "Phoenix Suns +4.5", odds: 1.91, kickoffH: -8 }, bancas, now);
  await identidade(prorrogacao.betId, "MATCHED", 1_690_000_006);
  await observar(prorrogacao.betId, { final: true, matchId: "fs-demo-6",
    snapshot: { outcome: "matched", settlementOutcome: "manual_extra_time", finished: true, placar: "118-118" } }, now);
  n++;

  const aguardandoFim = await gravarCenario({ canal: 4, esporte: "Tennis", liga: "wtaWuhan", home: "Coco Gauff", away: "Qinwen Zheng",
    mercado: "Money Line – Match", selecao: "Qinwen Zheng", odds: 2.35, kickoffH: -26 }, bancas, now);
  await identidade(aguardandoFim.betId, "MATCHED", 1_690_000_007);
  await observar(aguardandoFim.betId, { final: false, matchId: "fs-demo-7", snapshot: { outcome: "matched", settlementOutcome: "not_attempted" } }, now);
  n++;

  // Flamengo tem time de futebol e de basquete: no canal de vários esportes, o resolvedor não decide.
  await gravarCenario({ canal: 8, esporte: "Basketball", liga: "nbb", home: "Flamengo", away: "Minas",
    mercado: "Money Line – Match", selecao: "Flamengo", odds: 1.62, stake: 2, kickoffH: -5, esporteNaoConfirmado: true }, bancas, now);
  n++;

  // O post disse só o dia: sem horário, a aposta espera o jogo certamente ter acabado.
  const doisDias = new Date(now.getTime() - 2 * DAY);
  await gravarCenario({ canal: 7, esporte: "Volleyball", liga: "superlega", home: "Itas Trentino", away: "Sir Safety Perugia",
    mercado: "Money Line – Match", selecao: "Sir Safety Perugia", odds: 1.74, kickoffH: (doisDias.getTime() - now.getTime()) / HOUR,
    antesH: 6, kickoffDateOnly: true }, bancas, now);
  n++;
  return n;
}

/** Casos de Vincular: a busca devolveu candidatos que ninguém decidiu, ou nenhum. */
async function cenariosDeVincular(bancas: Bancas, now: Date): Promise<number> {
  const candidato = (id: number, home: string, away: string, league: string, horas: number, score: number, swapped = false) => ({
    match: { match_id: id, sport: "Soccer", league, home, away, match_date: new Date(now.getTime() + horas * HOUR).toISOString() },
    score, swapped,
  });
  const casos: Array<{ cenario: Cenario; candidatos: ReturnType<typeof candidato>[]; verdict: unknown; reason?: string }> = [
    {
      cenario: { canal: 2, esporte: "Soccer", liga: "brasileirao", home: "Atletico Mineiro", away: "Cruzeiro",
        mercado: "Total – Match", selecao: "Under 2.5", odds: 1.84, kickoffH: -3 },
      candidatos: [
        candidato(8_801_001, "Atletico-MG", "Cruzeiro", "Brazil - Serie A", -3, 1.52),
        candidato(8_801_002, "Atletico-MG U20", "Cruzeiro U20", "Brazil - Brasileiro U20", -2.5, 1.47),
      ],
      verdict: null, reason: "auto_ambiguo_gap",
    },
    {
      cenario: { canal: 8, esporte: "Soccer", liga: "premier", home: "Brighton and Hove Albion", away: "West Ham United",
        mercado: "Money Line – Match", selecao: "Draw", odds: 3.4, kickoffH: -5 },
      candidatos: [
        candidato(8_801_003, "Brighton", "West Ham", "England - Premier League", -5, 1.41),
        candidato(8_801_004, "Brighton", "West Ham", "England - Premier League 2", -26, 1.38),
      ],
      verdict: { candidateIndex: null, confidence: 0.4, reason: "Os dois jogos têm o mesmo par de times em dias diferentes, e o post não diz a data." },
    },
    {
      cenario: { canal: 2, esporte: "Soccer", liga: "portugal", home: "Famalicao", away: "Vitoria Guimaraes",
        mercado: "Handicap – Match", selecao: "Famalicao +0.25", odds: 1.97, kickoffH: -10 },
      candidatos: [], verdict: null, reason: "no_results",
    },
  ];
  for (const caso of casos) {
    const gravada = await gravarCenario(caso.cenario, bancas, now);
    await identidade(gravada.betId, "UNMATCHED", 0);
    const bet = await prisma.bet.findUniqueOrThrow({ where: { id: gravada.betId }, select: { id: true, evento: true, esporte: true, pais: true, competicao: true } });
    await recordTrainingCase(bet, caso.candidatos, "OPEN", caso.verdict, caso.reason);
  }
  return casos.length;
}

/** Sharp sem par: a Pinnacle ainda não listou o jogo, ou a busca terminou sem ele. */
async function cenariosDeSharp(bancas: Bancas, now: Date): Promise<number> {
  const cenarios: Array<{ cenario: Cenario; status: "PENDING" | "UNMATCHED" }> = [
    { cenario: { canal: 5, esporte: "eSports", liga: "cs2", home: "The MongolZ", away: "Heroic", mercado: "Money Line – Match",
      selecao: "The MongolZ", odds: 1.66, kickoffH: 7, antesH: 1 }, status: "PENDING" },
    { cenario: { canal: 5, esporte: "eSports", liga: "cs2", home: "FURIA", away: "Astralis", mercado: "Handicap – Match",
      selecao: "FURIA -1.5", odds: 2.45, kickoffH: 9, antesH: 1 }, status: "PENDING" },
    { cenario: { canal: 3, esporte: "Basketball", liga: "nbb", home: "Franca", away: "Bauru", mercado: "Handicap – Match",
      selecao: "Franca -5.5", odds: 1.88, kickoffH: 18, antesH: 2 }, status: "PENDING" },
    { cenario: { canal: 6, esporte: "Hockey", liga: "nhl", home: "Winnipeg Jets", away: "Carolina Hurricanes", mercado: "Puck Line",
      selecao: "Carolina Hurricanes +1.5", odds: 1.58, kickoffH: 22, antesH: 4 }, status: "UNMATCHED" },
  ];
  for (const { cenario, status } of cenarios) {
    const gravada = await gravarCenario(cenario, bancas, now);
    await identidade(gravada.betId, status, 0);
  }
  return cenarios.length;
}

/**
 * Homologar: o IA-Judge só sugere, e o dono decide, o que o placar final não
 * responde (parte do jogo, estatística, múltipla).
 */
async function cenariosDoIaJudge(bancas: Bancas, now: Date): Promise<number> {
  const sugestoes: Array<{ cenario: Cenario; status: BetStatus; valor: string; confianca: number; motivo: string; url: string }> = [
    {
      cenario: { canal: 1, esporte: "Soccer", liga: "laliga", home: "Real Sociedad", away: "Villarreal",
        mercado: "Total (Corners) – Match", selecao: "Over 9.5", odds: 1.9, kickoffH: -6 },
      status: "WON", valor: "11 escanteios (6–5)", confianca: 0.97,
      motivo: "O relatório da partida lista 6 escanteios da Real Sociedad e 5 do Villarreal no tempo regulamentar.",
      url: "https://www.flashscore.com/match/demo-real-sociedad-villarreal/#/match-summary/match-statistics",
    },
    {
      cenario: { canal: 3, esporte: "Basketball", liga: "nba", home: "Milwaukee Bucks", away: "Oklahoma City Thunder",
        mercado: "Total – 1st Half", selecao: "Under 114.5", odds: 1.87, kickoffH: -8 },
      status: "LOST", valor: "1º tempo 61–58 (119 pontos)", confianca: 0.96,
      motivo: "Placar do intervalo 61–58 no box score oficial: 119 pontos, acima da linha de 114.5.",
      url: "https://www.espn.com/nba/boxscore/_/gameId/demo",
    },
    {
      cenario: { canal: 5, esporte: "eSports", liga: "cs2", home: "Natus Vincere", away: "G2 Esports",
        mercado: "Total (Kills) – Map 1", selecao: "Over 180.5", odds: 1.83, kickoffH: -5 },
      status: "WON", valor: "Mapa 1 (Mirage): 196 abates", confianca: 0.88,
      motivo: "Estatística do mapa 1 soma 196 abates; a fonte não separa prorrogação do mapa, por isso a confiança menor.",
      url: "https://www.hltv.org/matches/demo/natus-vincere-vs-g2",
    },
    {
      cenario: { canal: 1, esporte: "Soccer", liga: "bundesliga", home: "Bayer Leverkusen", away: "VfB Stuttgart",
        mercado: "Money Line – Match", selecao: "Bayer Leverkusen + Borussia Dortmund", odds: 2.95, stake: 0.5, kickoffH: -7,
        legs: { kind: "parlay", legs: [
          { evento: "Bayer Leverkusen vs VfB Stuttgart", mercado: "Money Line – Match", selecao: "Bayer Leverkusen" },
          { evento: "Borussia Dortmund vs SC Freiburg", mercado: "Money Line – Match", selecao: "Borussia Dortmund" },
        ] } },
      status: "LOST", valor: "Leverkusen 2–0 ✓ · Dortmund 1–1 ✗", confianca: 0.95,
      motivo: "A primeira perna ganhou; a segunda empatou em 1–1, e a múltipla perde.",
      url: "https://www.flashscore.com/match/demo-dortmund-freiburg/#/match-summary",
    },
  ];
  for (const [i, s] of sugestoes.entries()) {
    const gravada = await gravarCenario(s.cenario, bancas, now);
    if (!s.cenario.legs) await identidade(gravada.betId, "MATCHED", 1_690_000_100 + i);
    const bet = await prisma.bet.findUniqueOrThrow({
      where: { id: gravada.betId },
      select: { id: true, evento: true, esporte: true, competicao: true, mercado: true, selecao: true, odds: true, stake: true,
        data: true, updatedAt: true, legsJson: true },
    });
    const { outcome } = await persistSuggestion({
      ...bet, odds: Number(bet.odds), stake: Number(bet.stake), bankrollNome: gravada.bankrollNome, combinedTicket: bet.legsJson !== null,
      liveEntry: false, liveScoreAtEntry: null,
    }, {
      suggestedStatus: s.status, valueFound: s.valor, confidence: s.confianca, reason: s.motivo, sourceUrl: s.url,
      provider: "gemini", evidenceKind: "GROUNDED_WEB", groundingQuery: `${bet.evento} ${bet.mercado}`,
      groundingSources: [{ url: s.url, title: bet.evento }], groundedAt: new Date(now.getTime() - 30 * MINUTE),
    });
    if (outcome !== "created") throw new Error(`Sugestão do IA-Judge não gravada para ${bet.evento}`);
  }
  return sugestoes.length;
}

/** Resultado trocado depois de liquidado, pela liquidação manual (a do painel e do `ops-settle`). */
async function reliquidar(): Promise<number> {
  const trocas: Array<[BetStatus, BetStatus]> = [["WON", "LOST"], ["LOST", "VOID"], ["WON", "HALF_WON"]];
  const usadas = new Set<string>();
  for (const [de, para] of trocas) {
    const candidatas = await prisma.bet.findMany({
      where: { status: de, deletedAt: null, bankroll: { telegramChannelId: { in: [demoChannelId(1), demoChannelId(2)] } } },
      orderBy: { data: "desc" },
      select: { id: true, mercado: true, selecao: true },
      take: 40,
    });
    // Meio resultado só na linha asiática fracionária, como a liquidação exige.
    const bet = candidatas.find((c) => !usadas.has(c.id) && (para !== "HALF_WON" || admitsAsianFractionalSettlement(c.mercado, c.selecao)));
    if (!bet) continue;
    usadas.add(bet.id);
    await runSerializableTransaction("dev.demo.resettle", (tx) => applyManualBetStatusChangeTx(tx, {
      betId: bet.id, newStatus: para, source: `manual:${DEMO_ACTOR}`,
    }));
  }
  return usadas.size;
}

// ─────────────────────────── Canais ───────────────────────────

type FalhaDeLeitura = { outcome: "unparseable" | "guard_rejected"; reason: string; via: string; missing?: string[] };

/** Quantas leituras falharam por canal, e por quê (o funil do Monitoramento). */
const FALHAS_DE_LEITURA: Record<number, FalhaDeLeitura[]> = {
  1: [
    { outcome: "unparseable", reason: "not_bet", via: "universal" }, { outcome: "unparseable", reason: "not_bet", via: "universal" },
    { outcome: "guard_rejected", reason: "odd_legenda_ausente", via: "universal" },
  ],
  2: [
    ...Array.from({ length: 5 }, () => ({ outcome: "guard_rejected" as const, reason: "mercado_total_ambiguo", via: "universal" })),
    { outcome: "guard_rejected", reason: "lado_handicap_ausente", via: "universal" },
  ],
  3: [{ outcome: "unparseable", reason: "llm_exhausted", via: "gemini-vision" }],
  4: [
    ...Array.from({ length: 8 }, (_, i) => ({ outcome: "unparseable" as const, reason: i % 2 ? "evento_ausente" : "selecao_ausente", via: "universal",
      missing: [i % 2 ? "evento" : "selecao"] })),
    { outcome: "unparseable", reason: "not_bet", via: "universal" },
  ],
  5: [{ outcome: "unparseable", reason: "imagem_original_indisponivel", via: "gemini-vision" }, { outcome: "guard_rejected", reason: "odd_invalida", via: "universal" }],
  7: [{ outcome: "unparseable", reason: "not_bet", via: "universal" }],
  8: [
    { outcome: "guard_rejected", reason: "legenda_com_multiplas_apostas", via: "universal" },
    { outcome: "guard_rejected", reason: "legenda_com_multiplas_apostas", via: "universal" },
  ],
};

type Descartado = { canal: number; mensagem: number; horasAtras: number; reason: DiscardReason; texto: string; foto?: boolean };

const DESCARTADOS: readonly Descartado[] = [
  { canal: 1, mensagem: 2, horasAtras: 1.2, reason: "nao_parece_aposta", texto: "Bom dia, galera! Rodada cheia na Premier hoje, fiquem ligados 👀" },
  { canal: 1, mensagem: 5, horasAtras: 21, reason: "resultado_ou_balanco", texto: "Fechamos a semana com +8,4u ✅✅✅\nObrigado pela confiança de sempre!" },
  { canal: 2, mensagem: 8, horasAtras: 2, reason: "jogo_ja_terminado", texto: "Botafogo x Fluminense\nOver 2.5 @1.90\n(entrada de ontem que esqueci de mandar)" },
  { canal: 2, mensagem: 11, horasAtras: 5, reason: "ia_nao_viu_aposta", texto: "Classificação atualizada 📊", foto: true },
  { canal: 4, mensagem: 14, horasAtras: 0.7, reason: "captura_recusada", texto: "Sinner -3.5 games\n@1.95" },
  { canal: 5, mensagem: 17, horasAtras: 30, reason: "nao_parece_aposta", texto: "Live hoje às 20h no canal, bora!" },
  { canal: 7, mensagem: 20, horasAtras: 3, reason: "canal_pausado", texto: "Sada Cruzeiro x Minas\nCruzeiro -1.5 sets @1.85 | 1u" },
  { canal: 7, mensagem: 23, horasAtras: 27, reason: "canal_pausado", texto: "Praia Clube x Campinas\nPraia vence @1.55 | 2u" },
];

/**
 * Leitura dos posts pela telemetria da captura, os posts que não viraram
 * aposta, a atividade do canal no Telegram, a pausa de um canal e um canal
 * sem banca.
 */
async function canais(bancas: Bancas, now: Date): Promise<{ julgados: number; descartados: number }> {
  let julgados = 0;
  const posts = await prisma.bet.findMany({
    where: { deletedAt: null, bankrollId: { in: [...bancas.values()].map((b) => b.id) }, sourceExternalId: { not: null } },
    select: { source: true, sourceExternalId: true, sourcePostedAt: true },
  });
  for (const post of posts) {
    const chatId = BigInt(post.source!.split(":").at(-1)!);
    await recordParseTelemetry({ chatId, messageId: Number(post.sourceExternalId) }, "registered", { via: "universal" });
    julgados++;
    if (post.sourcePostedAt) await recordChannelActivity({ channel_post: { chat: { id: String(chatId), type: "channel" } } }, post.sourcePostedAt);
  }
  for (const [canal, falhas] of Object.entries(FALHAS_DE_LEITURA)) {
    for (const [i, falha] of falhas.entries()) {
      const chatId = demoChannelId(Number(canal));
      const { outcome, ...details } = falha;
      await recordParseTelemetry({ chatId, messageId: 1_001 + i * 3 }, outcome, details);
      await recordChannelActivity({ channel_post: { chat: { id: String(chatId), type: "channel" } } },
        new Date(now.getTime() - (4 + i * 7) * HOUR));
      julgados++;
    }
  }

  for (const post of DESCARTADOS) {
    const chatId = demoChannelId(post.canal);
    const postDate = new Date(now.getTime() - post.horasAtras * HOUR);
    await recordDiscardedChannelPost({
      chatId, messageId: 900 + post.mensagem, bankrollId: bancas.get(post.canal)!.id, text: post.texto, postDate, reason: post.reason,
      ...(post.foto ? { photo: { mediaFileId: null } } : {}),
    });
    await recordChannelActivity({ channel_post: { chat: { id: String(chatId), type: "channel" } } }, postDate);
  }
  // A captura do Rede Vôlei está pausada: os posts dele vão direto para os descartados.
  await editarBankroll(bancas.get(7)!.id, { capturePaused: true }, DEMO_ACTOR);

  const semBanca = demoChannelId(CANAL_SEM_BANCA);
  for (const [i, horas] of [52, 30, 9, 2].entries()) {
    await recordUnmappedChannel({
      chatId: semBanca, messageId: 300 + i, kind: i === 2 ? "photo" : "text", now: new Date(now.getTime() - horas * HOUR),
      text: ["🔥 SUPER ODD 🔥 Inter x Milan ambas marcam @2.10", "Bom dia! Grupo VIP com 50% off hoje", "", "Palmeiras -1 @2.05 | 2u"][i],
    });
  }
  return { julgados, descartados: DESCARTADOS.length };
}

// ─────────────────────────── pg-boss ───────────────────────────

type FalhaDeJob = {
  fila: string;
  erro: { name: string; message: string };
  /** Horas atrás de cada ocorrência (uma por job). */
  horasAtras: number[];
  /** A cópia na dead-letter fica retida para o dono; senão já saiu dela. */
  retida?: { classe: "business" | "transient" | "other"; waitsFor?: string };
  betIds?: string[];
  /** Release que rodou cada tentativa, para o veredito da release. */
  release?: string;
  /** Tentativas por job (métrica de erro), para a release. */
  tentativas?: number[];
};

type Fila = { boss: PgBoss; client: Client };
/** O cliente que o pg-boss aceita no lugar do pool dele (`options.db`). */
type IDatabase = NonNullable<SendOptions["db"]>;

async function prepararPgBoss(): Promise<Fila> {
  // Só produtor: sem supervisão nem cron, e nenhum consumidor registrado.
  const boss = createBoss({ producerOnly: true });
  await boss.start();
  // A mesma topologia que o worker cria no boot (fila + dead-letter + retry).
  for (const job of WORKER_JOBS) await ensureQueueWithDeadLetter(boss, job.queue, effectiveQueueOptions(job));
  const client = new Client({ connectionString: getEnv().DATABASE_URL });
  await client.connect();
  return { boss, client };
}

/**
 * Cada job de exemplo nasce e termina numa transação só: um worker rodando
 * neste banco (o do `dev:local`) nunca o vê em `created` para pegá-lo com o
 * payload de exemplo.
 */
async function numaTransacao<T>({ client }: Fila, fn: (db: IDatabase) => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn({ executeSql: (text: string, values?: unknown[]) => client.query(text, values) });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function datarJob(db: IDatabase, ids: string[], quando: Date, duracaoMs: number): Promise<void> {
  await db.executeSql(
    "UPDATE pgboss.job SET created_on = $2, started_on = $3, completed_on = $4 WHERE id = ANY($1::uuid[])",
    [ids, new Date(quando.getTime() - duracaoMs - 2_000), new Date(quando.getTime() - duracaoMs), quando],
  );
}

let jobSeq = 0;

/** Um job que termina concluído, sem passar por worker: o motor vivo e o ciclo de fechamento. */
async function jobConcluido(fila: Fila, nome: string, quando: Date, output: object): Promise<string> {
  const { boss } = fila;
  return numaTransacao(fila, async (db) => {
    const id = await boss.send(nome, { ...DEMO_MARK, demoJob: ++jobSeq }, { singletonKey: `dev-demo:${jobSeq}`, db });
    if (!id) throw new Error(`O pg-boss recusou o job de exemplo em ${nome}`);
    await boss.complete(nome, id, { ...DEMO_MARK, ...output }, { includeQueued: true, db });
    await datarJob(db, [id], quando, 1_500);
    return id;
  });
}

/**
 * A falha como o pg-boss a grava ao esgotar as tentativas: a origem `failed`
 * e a cópia na dead-letter, que fica retida (falhada com o aviso de replay
 * manual, e a causa na auditoria) ou já saiu (concluída).
 */
async function falhar(fila: Fila, falha: FalhaDeJob, now: Date): Promise<{ jobs: Array<{ id: string; quando: Date }>; retidos: number }> {
  const { boss } = fila;
  const dlq = deadLetterOf(falha.fila);
  const jobs: Array<{ id: string; quando: Date }> = [];
  let retidos = 0;
  for (const [i, horas] of falha.horasAtras.entries()) {
    const seq = ++jobSeq;
    const betId = falha.betIds?.[i % falha.betIds.length];
    const data = { ...(betId ? { betId } : {}), ...DEMO_MARK, demoJob: seq };
    const quando = new Date(now.getTime() - horas * HOUR);
    const { id, copia } = await numaTransacao(fila, async (db) => {
      const id = await boss.send(falha.fila, data, { retryLimit: 0, singletonKey: betId ? `bet:${betId}` : `dev-demo:${seq}`, db });
      if (!id) throw new Error(`O pg-boss recusou o job de exemplo em ${falha.fila}`);
      await boss.fail(falha.fila, id, falha.erro, { db });
      const { rows } = await db.executeSql(
        "SELECT id::text FROM pgboss.job WHERE name = $1 AND data @> $2::jsonb", [dlq, JSON.stringify({ demoJob: seq })],
      );
      const copia = (rows as Array<{ id: string }>)[0]?.id;
      if (!copia) throw new Error(`Cópia na dead-letter não encontrada para ${falha.fila}`);
      if (falha.retida) {
        await boss.fail(dlq, copia, { name: "Error", message: `Dead-letter ${copia} retida para replay manual.` }, { db });
      } else {
        await boss.complete(dlq, copia, { ...DEMO_MARK, discarded: true }, { includeQueued: true, db });
      }
      await datarJob(db, [id], quando, 25_000);
      await datarJob(db, [copia], new Date(quando.getTime() + 30_000), 500);
      return { id, copia };
    });
    if (falha.retida) {
      await recordDeadLetterRetained({
        queue: falha.fila, jobId: copia, errorMessage: falha.erro.message, classification: falha.retida.classe,
        ...(falha.retida.waitsFor ? { waitsFor: falha.retida.waitsFor } : {}),
      });
      retidos++;
    }
    jobs.push({ id, quando });
  }
  return { jobs, retidos };
}

// ─────────────────────────── Releases ───────────────────────────

/** Commits reais da main: os links do cartão levam a um commit que existe. */
const RELEASES = [
  { sha: "b76a0e75b6a2a954bd4aa44f7ef4e442042adaab", prontaH: 98 },
  { sha: "cc6d2f1bd6cc4cdfaf8c6146d736a3fb7da32a30", prontaH: 50 },
  { sha: "986cff23cea8d016732432f3b8b43e36b359bfab", prontaH: 20 },
  { sha: "37f14d20ccdbaa09d67698a172e963d121d611d0", prontaH: 3 },
  { sha: "2149a5aafc0ae4f38983c1660ffecb3573536137", prontaH: 0.25 },
] as const;

const releaseId = (sha: string) => `${DEMO_RELEASE_PREFIX}${sha.slice(0, 7)}`;

/** Instante em que a release ficou pronta (o boot foi 2 min antes). */
const prontaEm = (now: Date, horas: number) => new Date(now.getTime() - horas * HOUR);

// ─────────────────────────── Métricas ───────────────────────────

type SerieSlo = {
  kind: "queue" | "provider" | "action" | "http";
  name: string;
  amostras: number;
  erros?: number;
  retries?: number;
  duracao: [number, number];
  atraso?: [number, number];
  /** Amostras extras na última hora, com outra duração (o SLO de 1 h). */
  ultimaHora?: { amostras: number; duracao: [number, number] };
  statusCode?: number;
};

const SERIES_SLO: readonly SerieSlo[] = [
  { kind: "queue", name: "telegram.updates", amostras: 220, duracao: [1_800, 7_000], atraso: [400, 9_000], ultimaHora: { amostras: 12, duracao: [1_800, 6_000] } },
  { kind: "queue", name: "sharp.enrich", amostras: 150, retries: 18, duracao: [140_000, 560_000], atraso: [2_000, 40_000],
    ultimaHora: { amostras: 9, duracao: [300_000, 620_000] } },
  { kind: "queue", name: "closing.sync", amostras: 288, duracao: [3_500, 14_000], atraso: [300, 2_000], ultimaHora: { amostras: 12, duracao: [3_500, 12_000] } },
  { kind: "queue", name: "closing.price_series", amostras: 400, duracao: [900, 3_000], atraso: [200, 1_500] },
  { kind: "queue", name: "capture.sport_resolve", amostras: 70, duracao: [1_500, 95_000], atraso: [300, 4_000] },
  { kind: "queue", name: "settlement.flashscore_results", amostras: 96, duracao: [6_000, 38_000], atraso: [300, 3_000] },
  { kind: "queue", name: "settlement.ia_judge", amostras: 4, duracao: [20_000, 60_000], atraso: [500, 2_000] },
  { kind: "queue", name: "health.heartbeat", amostras: 288, duracao: [40, 300], atraso: [100, 900] },
  { kind: "provider", name: "pinnacle17/events", amostras: 300, erros: 3, duracao: [350, 1_400], statusCode: 200 },
  { kind: "provider", name: "flashscore/v1/match/list", amostras: 180, erros: 14, duracao: [700, 4_200], statusCode: 200 },
  { kind: "provider", name: "bridgeodds.opening-closing/:id", amostras: 70, duracao: [40_500, 44_000], statusCode: 200 },
  { kind: "provider", name: "llm.cascade", amostras: 60, duracao: [4_000, 21_000] },
  { kind: "provider", name: "llm.transport.gemini.generate", amostras: 70, erros: 3, duracao: [3_000, 15_000], statusCode: 200 },
  { kind: "action", name: "provider.cadence", amostras: 150, retries: 60, duracao: [8_000, 41_000] },
  { kind: "action", name: "sharp.identity.kickoff", amostras: 40, duracao: [80, 900] },
  { kind: "http", name: "/api/health", amostras: 300, duracao: [15, 80], statusCode: 200 },
  { kind: "http", name: "/api/telegram/webhook", amostras: 250, duracao: [20, 150], statusCode: 200 },
];

type Metrica = Prisma.OperationalMetricCreateManyInput;

/** Valor com mediana `p50` e percentil 95 perto de `p95` (log-normal). */
function amostra(rng: Rng, [p50, p95]: [number, number]): number {
  const sigma = Math.log(p95 / p50) / 1.645;
  return Math.max(1, Math.round(p50 * Math.exp(rng.normal(0, sigma))));
}

function metricasDeSlo(rng: Rng, now: Date): Metrica[] {
  const linhas: Metrica[] = [];
  for (const serie of SERIES_SLO) {
    const erros = serie.erros ?? 0;
    const retries = serie.retries ?? 0;
    for (let i = 0; i < serie.amostras; i++) {
      const outcome = i < erros ? "error" : i < erros + retries ? "expected_retry" : "success";
      linhas.push({
        kind: serie.kind, name: serie.name, outcome, durationMs: amostra(rng, serie.duracao),
        queueLagMs: serie.atraso ? amostra(rng, serie.atraso) : null,
        statusCode: serie.statusCode && outcome === "error" ? 503 : serie.statusCode ?? null,
        labels: { ...DEMO_MARK }, occurredAt: new Date(now.getTime() - HOUR - rng.next() * 23 * HOUR),
      });
    }
    for (let i = 0; i < (serie.ultimaHora?.amostras ?? 0); i++) {
      linhas.push({
        kind: serie.kind, name: serie.name, outcome: "success", durationMs: amostra(rng, serie.ultimaHora!.duracao),
        queueLagMs: serie.atraso ? amostra(rng, serie.atraso) : null, statusCode: serie.statusCode ?? null,
        labels: { ...DEMO_MARK }, occurredAt: new Date(now.getTime() - rng.next() * 55 * MINUTE),
      });
    }
  }
  // O circuito da BridgeOdds abriu duas vezes: uma amostra por abertura.
  for (const horas of [5, 0.6]) {
    linhas.push({ kind: "provider", name: "bridgeodds.breaker", outcome: "error",
      labels: { ...DEMO_MARK, reason: "structural", failures: 5, cooldownMs: 3_600_000 }, occurredAt: new Date(now.getTime() - horas * HOUR) });
  }
  return linhas;
}

/** Leituras de imagem da cascata de IA, por modelo configurado, nos últimos 30 dias. */
function metricasDeOcr(rng: Rng, now: Date): Metrica[] {
  const leitores = configuredOcrReaders().filter((leitor) => leitor.enabled && leitor.endpoint !== "ocr");
  if (leitores.length === 0) return [];
  const linhas: Metrica[] = [];
  for (let item = 0; item < 160; item++) {
    const callId = createHash("sha256").update(`dev-demo-ocr-${item}`).digest("hex").slice(0, 32);
    const inicio = new Date(now.getTime() - rng.next() * 30 * DAY);
    const canal = rng.pick(PERFIS);
    const chatIdHash = createHash("sha256").update(String(demoChannelId(canal.canal))).digest("hex").slice(0, 16);
    let at = inicio.getTime();
    for (const [posicao, leitor] of leitores.entries()) {
      const r = rng.next();
      // O primeiro modelo lê a maior parte; os seguintes resgatam o que ele não leu.
      const aceita = posicao === 0 ? 0.8 : 0.65;
      const result = r < aceita ? "accepted" : r < aceita + 0.08 ? "rejected" : r < aceita + 0.14 ? "rate_limit" : "http_error";
      const state = result === "accepted" ? (rng.next() < 0.12 ? "draft" : "complete") : result === "rejected" ? "review" : undefined;
      const durationMs = amostra(rng, [4_500, 16_000]);
      const inputTokens = Math.round(rng.between(1_600, 2_600));
      const outputTokens = Math.round(rng.between(180, 420));
      linhas.push({
        kind: "provider", name: "llm.attempt", outcome: result === "accepted" ? "success" : "error", durationMs,
        statusCode: result === "rate_limit" ? 429 : result === "http_error" ? 503 : 200,
        labels: {
          ...DEMO_MARK, provider: leitor.provider, model: leitor.model, endpoint: leitor.endpoint, result, modality: "image",
          task: "channel-image", ...(state ? { extractionState: state } : {}), llmCallId: callId, chatIdHash, messageId: String(2_000 + item),
          ...(result === "accepted" || result === "rejected"
            ? { inputTokens, outputTokens, paidEquivalentUsd: Number(((inputTokens * 0.3 + outputTokens * 2.5) / 1_000_000).toFixed(6)) }
            : {}),
        },
        occurredAt: new Date(at),
      });
      at += durationMs + 400;
      if (result === "accepted") break;
    }
  }
  return linhas;
}

// ─────────────────────────── Orçamento de providers ───────────────────────────

/** Gasto do período corrente por provider, pelo mesmo serviço que reserva a cota; a auditoria guarda quanto foi de exemplo. */
async function gastarOrcamento(now: Date): Promise<void> {
  const fracoes: Record<string, number> = { bridgeodds: 0.62, pinnacle17: 0.41, flashscore: 0.18 };
  for (const [provider, fracao] of Object.entries(fracoes)) {
    const cap = findProviderCap(provider)!;
    const periodKey = periodKeyFor(cap.period, now);
    const atual = await prisma.providerBudget.findUnique({ where: { provider_periodKey: { provider, periodKey } } });
    const cost = Math.max(0, Math.min(Math.round(cap.cap * fracao), cap.cap - (atual?.spent ?? 0) - (atual?.reserved ?? 0)));
    if (cost === 0 || !await consumeProviderBudget(provider, cost, now)) continue;
    await prisma.auditEvent.create({
      data: { actor: DEMO_ACTOR, action: BUDGET_ACTION, resource: "provider_budget", resourceId: `${provider}:${periodKey}`,
        details: { provider, periodo: periodKey, cost } },
    });
  }
}

// ─────────────────────────── Caixa de ações ───────────────────────────

type AcaoDemo = {
  fonte: string;
  titulo: string;
  descricao: string;
  risco: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  area: string;
  abertaH: number;
  vistaH: number;
  ocorrencias: number;
  evidencia?: OperationalActionEvidence;
  recurso?: { resource: string; resourceId: string };
  desfecho?: { status: "ACKED" } | { status: "RESOLVED" | "DISMISSED"; nota: string; horasAtras: number };
};

async function caixaDeAcoes(betIds: { liquidar: string }, now: Date): Promise<number> {
  const acoes: AcaoDemo[] = [
    {
      fonte: "provider.breaker", area: "providers", risco: "HIGH", abertaH: 5, vistaH: 0.6, ocorrencias: 2,
      titulo: "Circuito da BridgeOdds abriu 2 vezes",
      descricao: "🔌 A BridgeOdds falhou 5 vezes seguidas e o circuito abriu por 1 h, duas vezes nas últimas 5 h.\nAbertura e fechamento pós-jogo ficam na fila até ela voltar.\n👉 Confira a cota e o status da BridgeOdds.",
      evidencia: { provider: "bridgeodds", aberturas: 2, cooldownMin: 60 },
    },
    {
      fonte: "slo", area: "incidentes", risco: "MEDIUM", abertaH: 3, vistaH: 0.15, ocorrencias: 6,
      titulo: "SLO violado em sharp.enrich",
      descricao: "⏱️ sharp.enrich está lento: p95 de 9 min 40 s na última hora (teto 8 min).\nO preço de entrada das apostas novas chega atrasado.\n👉 Veja se a cadência da BridgeOdds está segurando a fila.",
      evidencia: { samples: 9, reasons: ["p95 580000ms > 480000ms"] },
    },
    {
      fonte: "release", area: "incidentes", risco: "MEDIUM", abertaH: 2.2, vistaH: 2.2, ocorrencias: 1,
      titulo: "Erro novo na release 37f14d2",
      descricao: "🆕 Depois da publicação de 37f14d2, sharp.enrich passou a falhar com TypeError: Cannot read properties of undefined (reading 'home').\n👉 Abra o erro em Monitoramento › Manutenção.",
      evidencia: { release: releaseId(RELEASES[3].sha), fila: "sharp.enrich" },
    },
    {
      fonte: "settlement.stale", area: "liquidacao", risco: "LOW", abertaH: 30, vistaH: 1, ocorrencias: 4,
      titulo: "Aposta esperando liquidação manual há mais de um dia",
      descricao: "📚 Olympiacos vs AS Monaco começou há 30 h e o FlashScore viu o fim do jogo sem placar.\n👉 Liquide em Operações › Liquidar.",
      recurso: { resource: "bet", resourceId: betIds.liquidar },
    },
    {
      fonte: "capture.refusals", area: "captura", risco: "MEDIUM", abertaH: 20, vistaH: 4, ocorrencias: 5,
      titulo: "Recusas repetidas no Asiático do Léo: Total sem dizer a unidade",
      descricao: "🧩 5 posts do Asiático do Léo foram recusados porque o Total não diz se é de gols, escanteios ou cartões.\n👉 Se o canal não é só de futebol, marque os esportes dele em Config › Tipsters.",
      evidencia: { canal: String(demoChannelId(2)), motivo: "mercado_total_ambiguo", posts: 5 },
      desfecho: { status: "ACKED" },
    },
    {
      fonte: "dlq", area: "incidentes", risco: "MEDIUM", abertaH: 34, vistaH: 30, ocorrencias: 3,
      titulo: "3 tarefas de capture.sport_resolve paradas na dead-letter",
      descricao: "🛑 A resolução de esporte falhou 3 vezes sem resposta da BridgeOdds (conexão derrubada).\n👉 Dê replay em Monitoramento › Manutenção depois que ela voltar.",
      evidencia: { fila: "capture.sport_resolve", jobs: 3 },
      desfecho: { status: "ACKED" },
    },
    {
      fonte: "backup", area: "infra", risco: "HIGH", abertaH: 75, vistaH: 72, ocorrencias: 2,
      titulo: "Backup diário atrasado",
      descricao: "💾 O último backup conferido tem mais de 26 h.\n👉 Veja o log do backup no servidor.",
      desfecho: { status: "RESOLVED", nota: "Backup conferido às 03:12; faltava espaço no disco do servidor, já liberado.", horasAtras: 70 },
    },
    {
      fonte: "worker", area: "infra", risco: "HIGH", abertaH: 50.5, vistaH: 50.2, ocorrencias: 1,
      titulo: "Worker sem heartbeat há 18 min",
      descricao: "💤 O worker parou de mandar heartbeat durante a publicação.\n👉 Confira o container do worker.",
      desfecho: { status: "RESOLVED", nota: "Voltou sozinho quando a publicação terminou.", horasAtras: 50 },
    },
    {
      fonte: "capture.odd", area: "captura", risco: "LOW", abertaH: 12, vistaH: 12, ocorrencias: 1,
      titulo: "Odd fora do teto de sanidade no Clutch eSports",
      descricao: "🎯 Um post do Clutch eSports trouxe odd 21.0 e a captura recusou.\n👉 Confira se a odd era mesmo essa.",
      desfecho: { status: "DISMISSED", nota: "Era um mapa bônus com odd alta de verdade; a recusa estava certa.", horasAtras: 10 },
    },
  ];
  for (const [i, acao] of acoes.entries()) {
    const aberta = await reportOperationalAction({
      source: `${DEMO_SOURCE_PREFIX}${acao.fonte}`, key: String(i), area: acao.area, actionType: "incident.review",
      title: acao.titulo, description: acao.descricao, risk: acao.risco,
      priority: { CRITICAL: 95, HIGH: 80, MEDIUM: 70, LOW: 35 }[acao.risco],
      resource: acao.recurso?.resource ?? null, resourceId: acao.recurso?.resourceId ?? null,
      evidence: acao.evidencia ?? {}, occurrenceCount: acao.ocorrencias, autoResolve: false,
    }, new Date(now.getTime() - acao.abertaH * HOUR));
    // A última vez vista é a da última ocorrência, não a da abertura.
    await prisma.operationalAction.update({ where: { id: aberta.id }, data: { lastSeenAt: new Date(now.getTime() - acao.vistaH * HOUR) } });
    if (acao.desfecho?.status === "ACKED") {
      await acknowledgeOperationalAction(aberta.id, DEMO_ACTOR, new Date(now.getTime() - acao.vistaH * HOUR + 10 * MINUTE));
    } else if (acao.desfecho) {
      await closeOperationalAction(aberta.id, DEMO_ACTOR, acao.desfecho.status, acao.desfecho.nota,
        new Date(now.getTime() - acao.desfecho.horasAtras * HOUR));
    }
  }
  // A revisão diária real, sobre as escritas do próprio gerador.
  await checkEscritasForaDoFluxo(now);
  return acoes.length + 1;
}

// ─────────────────────────── Orquestração ───────────────────────────

/**
 * Grava o lado operacional sobre as bancas de exemplo que `gerarDadosDemo`
 * acabou de criar. Re-rodável: apaga antes o que é dele.
 */
export async function gerarOperacaoDemo(options: { now?: Date } = {}): Promise<ResumoOperacaoDemo> {
  const now = options.now ?? new Date();
  const rng = gerador(SEMENTE);
  proximaMensagem = MENSAGEM_CENARIO;
  jobSeq = 0;
  const apagados = await apagarOperacaoDemo();
  const bancas: Bancas = new Map((await prisma.bankroll.findMany({
    where: { telegramChannelId: { in: PERFIS.map((perfil) => demoChannelId(perfil.canal)) } },
    select: { id: true, nome: true, telegramChannelId: true },
  })).map((banca) => [PERFIS.find((p: Perfil) => demoChannelId(p.canal) === banca.telegramChannelId)!.canal, banca]));
  if (bancas.size !== PERFIS.length) throw new Error("As bancas de exemplo não existem: rode gerarDadosDemo antes.");

  const liquidarManual = await cenariosDeLiquidacao(bancas, now);
  const vincular = await cenariosDeVincular(bancas, now);
  const sharpPendentes = await cenariosDeSharp(bancas, now) + vincular;
  const homologar = await cenariosDoIaJudge(bancas, now);
  const reliquidadas = await reliquidar();
  const { julgados, descartados } = await canais(bancas, now);

  const fila = await prepararPgBoss();
  let jobsFalhos = 0;
  let jobsRetidos = 0;
  const metricas: Metrica[] = [];
  try {
    await jobConcluido(fila, QUEUES.healthHeartbeat, new Date(now.getTime() - 40_000), { heartbeat: "exemplo" });
    await jobConcluido(fila, QUEUES.closingSync, new Date(now.getTime() - 3 * MINUTE), { fechadas: 4 });

    const enrichBets = (await prisma.bet.findMany({
      where: { bankrollId: bancas.get(1)!.id, status: "PENDING" }, select: { id: true }, orderBy: { data: "asc" }, take: 3,
    })).map((bet) => bet.id);
    const fantasma = (i: number) => createHash("sha256").update(`dev-demo-bet-${i}`).digest("hex").replace(
      /^(.{8})(.{4})(.{3})(.{3})(.{12}).*$/, "$1-$2-4$3-a$4-$5");
    const falhas: FalhaDeJob[] = [
      // Erro conhecido: a aposta foi apagada antes do enrich. Aparece na release mais velha e volta na seguinte.
      { fila: QUEUES.sharpEnrich, erro: { name: "Error", message: `Aposta ${fantasma(1)} not found` }, horasAtras: [97.6],
        betIds: [fantasma(1)], release: releaseId(RELEASES[0].sha), tentativas: [1] },
      { fila: QUEUES.sharpEnrich, erro: { name: "Error", message: `Aposta ${fantasma(2)} not found` }, horasAtras: [49.8, 49.5],
        betIds: [fantasma(2), fantasma(3)], release: releaseId(RELEASES[1].sha), tentativas: [1, 1] },
      // Erro novo da release de 3 h atrás: um bug, retido para o dono.
      { fila: QUEUES.sharpEnrich, erro: { name: "TypeError", message: "Cannot read properties of undefined (reading 'home')" },
        horasAtras: [2.8, 2.5, 2.3], retida: { classe: "other" }, betIds: enrichBets, release: releaseId(RELEASES[3].sha), tentativas: [2, 1, 1] },
      { fila: QUEUES.sportResolve, erro: { name: "ProviderRequestError", message: "BridgeOdds: fetch failed (ECONNRESET)" },
        horasAtras: [34, 33.2, 31.9], retida: { classe: "transient" }, betIds: enrichBets },
      { fila: QUEUES.iaJudge, erro: { name: "RecusaDeNegocioError", message: "Aposta sofreu mutação material de termos ou identidade antes da liquidação." },
        horasAtras: [14], retida: { classe: "business" } },
      { fila: QUEUES.policyEvaluate, erro: { name: "Error", message: "handler execution exceeded 300000ms" }, horasAtras: [9], retida: { classe: "transient" } },
      // O deploy de dois dias atrás derrubou o worker no meio: as cópias já saíram da dead-letter.
      { fila: QUEUES.closingSeries, erro: { name: "Error", message: "job shut down while active" }, horasAtras: [50.3, 50.3, 50.29, 50.28] },
    ];
    const releaseMetrics: Metrica[] = [];
    for (const falha of falhas) {
      const { jobs, retidos } = await falhar(fila, falha, now);
      jobsFalhos += jobs.length;
      jobsRetidos += retidos;
      if (!falha.release) continue;
      for (const [i, job] of jobs.entries()) {
        for (let t = 0; t < (falha.tentativas?.[i] ?? 1); t++) {
          releaseMetrics.push({
            kind: "queue", name: falha.fila, outcome: "error", durationMs: 1_200 + t * 300, queueLagMs: 800,
            labels: { ...DEMO_MARK, jobId: job.id, releaseId: falha.release, error: falha.erro.name, process: "worker" },
            occurredAt: new Date(job.quando.getTime() - (t + 1) * 60_000),
          });
        }
      }
    }
    metricas.push(...metricasDeSlo(rng, now), ...metricasDeOcr(rng, now), ...releaseMetrics);
    for (let i = 0; i < metricas.length; i += 1_000) await prisma.operationalMetric.createMany({ data: metricas.slice(i, i + 1_000) });

    // Cada release pronta e o veredito dela, na ordem, com o relógio de quando a observação terminou.
    for (const release of RELEASES) {
      const readyAt = prontaEm(now, release.prontaH);
      await recordReleaseReady({ bootedAt: new Date(readyAt.getTime() - 2 * MINUTE), readyAt, releaseId: releaseId(release.sha), sha: release.sha });
      const fimDaObservacao = new Date(readyAt.getTime() + 46 * MINUTE);
      if (fimDaObservacao <= now) await judgePendingReleases(fimDaObservacao);
    }
  } finally {
    await fila.client.end();
    await fila.boss.stop({ graceful: false });
  }

  await gastarOrcamento(now);
  const liquidarBet = await prisma.bet.findFirstOrThrow({ where: { evento: "Olympiacos vs AS Monaco", bankrollId: bancas.get(3)!.id }, select: { id: true } });
  const acoes = await caixaDeAcoes({ liquidar: liquidarBet.id }, now);

  return {
    apagados, liquidarManual, vincular, homologar, sharpPendentes, reliquidadas, postsJulgados: julgados, descartados,
    jobsFalhos, jobsRetidos, metricas: metricas.length, releases: RELEASES.length, acoes,
  };
}
