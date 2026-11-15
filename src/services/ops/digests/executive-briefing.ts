import { DAILY_NOTIFICATION_DEDUPE_MS } from "@/src/domain/mensagem-operador";
import { FINAL_BET_STATUSES } from "@/src/domain/bet-status";
import { hitRateFromCounts } from "@/src/domain/hit-rate";
import { formatSpDateWithYear, MONTH_NAMES, spDayKey, spStartOfTodayUtc, spToUtc, utcToSpParts } from "@/src/domain/dates";
import { fmtBrl } from "@/src/domain/formato-de-resultado";
import { roundMoney, sumMoneyBy, toNumber, unitsToBrl, unitsToReais } from "@/src/domain/money";
import { LOG_EVENTS } from "@/src/infra/log-events";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { periodKeyFor, PROVIDER_CAPS } from "@/src/providers/budget-config";
import { sendRequiredOperatorNotification } from "@/src/services/ops/alerts";
import { readMatchingDay, recordMatchingDay, type MatchingDay } from "@/src/services/ops/digests/matching-day";
import { truncatePendingDigestMessage } from "@/src/services/ops/digests/pending-digest";
import { countActionableOperationalActions } from "@/src/services/ops/operational-actions";
const log = createLogger("executive-briefing");

export type ExecutiveBriefingData = {
  dataReferencia: string;
  hoje: {
    totalResolvidas: number;
    wins: number;
    losses: number;
    halfWins: number;
    halfLosses: number;
    voids: number;
    lucroUnidades: number;
    lucroReais: number;
    stakeFinalizada: number;
    roi: number | null;
    winRate: number | null;
  };
  mes: {
    nomeMes: string;
    totalResolvidas: number;
    lucroUnidades: number;
    lucroReais: number;
    stakeFinalizada: number;
    roi: number | null;
  };
  bancas: Array<{
    nome: string;
    lucroUnidades: number;
    /** Capital inicial mais o lucro realizado, em unidades (a banca atual). */
    saldoUnidades: number;
    /** `saldoUnidades` em reais, pela unidade atual da banca. */
    saldoEstimado: number;
  }>;
  patrimonio: {
    saldoEmContasAtivas: number;
    contasAtivas: number;
    saldoBancasTotal: number;
  };
  operacoes: {
    tipsHoje: number;
    pendentes: number;
    acoesAbertas: number;
    /** Apostas com o jogo começando no dia: quantas tinham identidade antes do início. */
    identidadeAntesDoJogo: { casadas: number; total: number };
  };
  /**
   * O casamento de jogos do dia, também gravado na série diária
   * (`matching-day.ts`); null quando a leitura falhou e o resumo sai sem o bloco.
   */
  matching: MatchingDay | null;
  quotas: Array<{
    provider: string;
    spent: number;
    cap: number;
    pct: number;
    /** Teto por hora (BridgeOdds): a hora mais cheia do dia, que é onde o teto aperta. */
    peakHour?: { spent: number; cap: number; pct: number };
  }>;
};

/**
 * Cada canal novo ganha banca e o nome do canal vai até 128 caracteres: sem
 * teto, a lista passaria do limite de uma mensagem do Telegram, o envio seria
 * recusado e o resumo não sairia mais.
 */
const MAX_LISTED_BANKROLLS = 15;

/** As bancas da lista, na ordem original; passando do teto, as de maior resultado. */
function listedBankrolls(bankrolls: ExecutiveBriefingData["bancas"]): ExecutiveBriefingData["bancas"] {
  if (bankrolls.length <= MAX_LISTED_BANKROLLS) return bankrolls;
  const largest = new Set(
    [...bankrolls]
      .sort((a, b) => Math.abs(b.lucroUnidades) - Math.abs(a.lucroUnidades) || a.nome.localeCompare(b.nome))
      .slice(0, MAX_LISTED_BANKROLLS),
  );
  return bankrolls.filter((bankroll) => largest.has(bankroll));
}

function formatarSinal(valor: number, sufixo = ""): string {
  const prefix = valor > 0 ? "+" : "";
  return `${prefix}${valor.toFixed(2)}${sufixo}`;
}

/** O desfecho da observação do FlashScore em palavras; um desfecho novo sai com o código. */
const FLASHSCORE_REASON_LABELS: Readonly<Record<string, string>> = {
  no_candidate: "sem candidato",
  below_threshold: "nome pouco parecido",
  ambiguous: "empate entre jogos",
  kickoff_mismatch: "em outro horário",
  invalid_event: "evento sem os dois times",
};

/** O bloco "Casamento": só as linhas com número, e nada quando o dia não teve nenhum. */
function matchingLines(matching: MatchingDay | null): string[] {
  if (!matching) return [];
  const lines: string[] = [];
  const { trainingQueueBets, settled, flashscore, catalog } = matching;
  if (trainingQueueBets > 0) {
    lines.push(`• Vincular: ${trainingQueueBets} ${trainingQueueBets === 1 ? "aposta entrou" : "apostas entraram"} na sua fila`);
  }
  const settledParts = [
    ...(settled.automatic > 0 ? [`${settled.automatic} no automático`] : []),
    ...(settled.manual > 0 ? [`${settled.manual} à mão`] : []),
  ];
  if (settledParts.length > 0) lines.push(`• Liquidadas: ${settledParts.join(", ")}`);
  const reasons = Object.entries(flashscore.notFoundByReason)
    .filter(([, bets]) => bets > 0)
    .sort(([reasonA, a], [reasonB, b]) => b - a || reasonA.localeCompare(reasonB));
  const notFound = reasons.reduce((total, [, bets]) => total + bets, 0);
  if (notFound > 0) {
    const byReason = reasons.map(([reason, bets]) => `${bets} ${FLASHSCORE_REASON_LABELS[reason] ?? reason}`);
    lines.push(`• FlashScore sem o jogo: ${notFound} de ${flashscore.looked} (${byReason.join(", ")})`);
  }
  if (flashscore.notFoundWithBothTeamIds > 0) {
    lines.push(`• FlashScore conhecia os dois times e não achou o jogo: ${flashscore.notFoundWithBothTeamIds}`);
  }
  if (catalog.linkedGames > 0 || catalog.teamCards > 0) {
    // "No dia", como o resto do resumo: ele sai às 00:05, sobre o dia que terminou.
    lines.push(`• Catálogos: ${catalog.linkedGames} ${catalog.linkedGames === 1 ? "jogo ligado" : "jogos ligados"} no dia, `
      + `${catalog.teamCards} ${catalog.teamCards === 1 ? "time" : "times"} com id do FlashScore (${catalog.newTeamCards} `
      + `${catalog.newTeamCards === 1 ? "novo" : "novos"})`);
  }
  return lines.length > 0 ? ["", "🔗 Casamento", ...lines] : [];
}

/**
 * Formata os dados coletados para o Telegram. Texto puro: a mensagem sai sem
 * `parse_mode`, e os `*negrito*` de antes apareciam como asteriscos no chat.
 */
export function formatarExecutiveBriefing(data: ExecutiveBriefingData): string {
  const h = data.hoje;
  const m = data.mes;
  const dayProfit = roundMoney(h.lucroReais, 2);
  const sinalIcone = dayProfit > 0 ? "🟢" : dayProfit < 0 ? "🔴" : "⚪";

  const linhas: string[] = [
    `📊 Resumo do dia · ${data.dataReferencia}`,
    "",
    "💰 Resultado",
  ];

  if (h.totalResolvidas === 0) {
    linhas.push("• Nenhuma aposta liquidada no dia.");
  } else {
    const roiTexto = h.roi !== null ? formatarSinal(h.roi, "%") : "— (sem stake finalizada)";
    const acerto = h.winRate !== null ? ` · acerto ${h.winRate}%` : "";
    const placar = [
      `${h.wins} ${h.wins === 1 ? "ganha" : "ganhas"}`,
      `${h.losses} ${h.losses === 1 ? "perdida" : "perdidas"}`,
      ...(h.voids > 0 ? [`${h.voids} ${h.voids === 1 ? "anulada" : "anuladas"}`] : []),
    ].join(", ");

    linhas.push(`• No dia: ${fmtBrl(h.lucroReais, true)} ${sinalIcone}`);
    linhas.push(`• ROI ${roiTexto}${acerto} (${placar})`);
  }

  const mesRoi = m.roi !== null ? ` · ROI ${formatarSinal(m.roi, "%")}` : "";
  linhas.push(`• ${m.nomeMes} até o dia: ${fmtBrl(m.lucroReais, true)}${mesRoi}`);

  linhas.push("");
  linhas.push("🏦 Banca por tipster");
  if (data.bancas.length === 0) {
    linhas.push("• Nenhum tipster cadastrado.");
  } else {
    const listed = listedBankrolls(data.bancas);
    for (const banca of listed) {
      const lucroSinal = banca.lucroUnidades >= 0 ? "+" : "";
      linhas.push(
        `• ${banca.nome}: ${banca.saldoUnidades.toFixed(2)}u · ${fmtBrl(banca.saldoEstimado)} (${lucroSinal}${banca.lucroUnidades.toFixed(2)}u)`,
      );
    }
    const omitted = data.bancas.length - listed.length;
    if (omitted > 0) {
      linhas.push(`• … e mais ${omitted} ${omitted === 1 ? "tipster" : "tipsters"}; veja Tipsters no painel.`);
    }
    linhas.push(`• Total: ${fmtBrl(data.patrimonio.saldoBancasTotal)}`);
    if (data.patrimonio.contasAtivas > 0) {
      linhas.push(`• Nas ${data.patrimonio.contasAtivas} conta(s) ativa(s): ${fmtBrl(data.patrimonio.saldoEmContasAtivas)}`);
    }
  }

  linhas.push("");
  linhas.push("🎯 Operação");
  linhas.push(
    `• Apostas do dia: ${data.operacoes.tipsHoje} (${h.totalResolvidas} liquidada(s); ${data.operacoes.pendentes} pendente(s) agora)`,
  );
  const { casadas, total } = data.operacoes.identidadeAntesDoJogo;
  if (total > 0) {
    linhas.push(`• Jogos do dia casados antes do início: ${casadas} de ${total} (${Math.round((casadas / total) * 100)}%)`);
  }
  linhas.push(
    data.operacoes.acoesAbertas === 0
      ? "• Caixa de ações vazia ✅"
      : `• ⚠️ ${data.operacoes.acoesAbertas} ação(ões) esperando você em Monitoramento`,
  );
  linhas.push(...matchingLines(data.matching));

  if (data.quotas.length > 0) {
    linhas.push("");
    linhas.push("🔌 Cotas de API (no dia)");
    for (const q of data.quotas) {
      if (q.peakHour) {
        const alerta = q.peakHour.pct >= 85 ? " ⚠️" : "";
        linhas.push(`• ${q.provider}: ${q.spent} no dia · hora mais cheia ${q.peakHour.pct}% (${q.peakHour.spent}/${q.peakHour.cap})${alerta}`);
        continue;
      }
      const alerta = q.pct >= 85 ? " ⚠️" : "";
      linhas.push(`• ${q.provider}: ${q.pct}% (${q.spent}/${q.cap})${alerta}`);
    }
  }

  return linhas.join("\n");
}


/** Retorna o instante UTC correspondente ao primeiro segundo do mês atual no fuso SP. */
export function spStartOfMonthUtc(now = new Date()): Date {
  const sp = utcToSpParts(now);
  return spToUtc({ year: sp.getUTCFullYear(), month: sp.getUTCMonth() + 1, day: 1 });
}

const LIQUIDADAS = [...FINAL_BET_STATUSES, "VOID", "CANCELED"] as const;

type BetFinanceira = {
  status: string;
  lucro: unknown;
  stake: unknown;
  valorUnidade: unknown;
};

/**
 * Lucro em reais: lucro × unidade da aposta, o mesmo valor que o ledger lança
 * e que o dashboard mostra. As movimentações não servem de fonte: a aposta que
 * perdeu a conta fica com o lançamento estornado e somaria zero.
 */
function lucroReaisFromBet(bet: { lucro: unknown; valorUnidade: unknown }): number {
  return unitsToBrl(toNumber(bet.lucro), toNumber(bet.valorUnidade));
}

/** Lucro, stake e ROI de um período; VOID e CANCELED não entram. */
function resumoFinanceiro(bets: BetFinanceira[]) {
  const finalizadas = bets.filter((b) => b.status !== "VOID" && b.status !== "CANCELED");
  const lucroUnidades = roundMoney(sumMoneyBy(finalizadas, (b) => toNumber(b.lucro), 6), 4);
  const lucroReais = roundMoney(sumMoneyBy(finalizadas, lucroReaisFromBet, 2), 2);
  const stakeFinalizada = roundMoney(sumMoneyBy(finalizadas, (b) => toNumber(b.stake), 6), 4);
  // ROI da carteira usa dinheiro pelo snapshot, como o Analyzer. O lucro
  // exibido acima conserva centavos por aposta, como o extrato do dia.
  const stakedBrl = sumMoneyBy(finalizadas, (b) => unitsToReais(toNumber(b.stake), toNumber(b.valorUnidade)));
  const profitBrl = sumMoneyBy(finalizadas, (b) => unitsToReais(toNumber(b.lucro), toNumber(b.valorUnidade)));
  const roi = stakedBrl > 0
    ? roundMoney((profitBrl / stakedBrl) * 100, 2)
    : null;
  return { lucroUnidades, lucroReais, stakeFinalizada, roi };
}

function resultadosDoDia(bets: BetFinanceira[]) {
  const wins = bets.filter((b) => b.status === "WON").length;
  const losses = bets.filter((b) => b.status === "LOST").length;
  const halfWins = bets.filter((b) => b.status === "HALF_WON").length;
  const halfLosses = bets.filter((b) => b.status === "HALF_LOST").length;
  const voids = bets.filter((b) => b.status === "VOID" || b.status === "CANCELED").length;
  const rawWinRate = hitRateFromCounts({ won: wins, lost: losses, halfWon: halfWins, halfLost: halfLosses });
  return {
    wins,
    losses,
    halfWins,
    halfLosses,
    voids,
    winRate: rawWinRate !== null ? roundMoney(rawWinRate, 1) : null,
  };
}

/**
 * O dia que o briefing resume: o de São Paulo que terminou antes de `now`. O
 * envio é às 00:05, depois do fim do dia, para a aposta liquidada na última
 * hora entrar.
 */
export function briefingDay(now = new Date()): { start: Date; end: Date } {
  const end = spStartOfTodayUtc(now);
  return { start: spStartOfTodayUtc(new Date(end.getTime() - 12 * 3_600_000)), end };
}

/** As chaves horárias de budget (`periodKeyFor("hour")`) de cada hora do dia. */
function hourKeysOf(day: { start: Date; end: Date }): string[] {
  const keys: string[] = [];
  for (let t = day.start.getTime(); t < day.end.getTime(); t += 3_600_000) {
    keys.push(periodKeyFor("hour", new Date(t)));
  }
  return keys;
}

async function lerDadosDoBriefing(day: { start: Date; end: Date }) {
  const inicioMes = spStartOfMonthUtc(day.start);
  const betFinanceiraSelect = {
    status: true,
    lucro: true,
    stake: true,
    valorUnidade: true,
  } as const;
  const noDia = { gte: day.start, lt: day.end };
  const [
    betsHoje, betsMes, tipsHoje, pendentes, acoesAbertas, bancas, contas, budgets, identidadeAntesDoJogo, matching,
  ] = await Promise.all([
    prisma.bet.findMany({
      where: { deletedAt: null, status: { in: [...LIQUIDADAS] }, settledAt: noDia },
      select: betFinanceiraSelect,
    }),
    // O mês é desempenho por período: pelo dia do jogo, como o Analyzer. O
    // "no dia" acima é o que foi liquidado no dia.
    prisma.bet.findMany({
      where: { deletedAt: null, status: { in: [...LIQUIDADAS] }, data: { gte: inicioMes, lt: day.end } },
      select: betFinanceiraSelect,
    }),
    prisma.bet.count({ where: { deletedAt: null, registradoEm: noDia } }),
    prisma.bet.count({ where: { deletedAt: null, status: "PENDING" } }),
    countActionableOperationalActions(),
    prisma.bankroll.findMany({
      orderBy: { nome: "asc" },
      select: {
        nome: true,
        capitalInicial: true,
        valorUnidade: true,
        bets: {
          where: { deletedAt: null, status: { in: [...FINAL_BET_STATUSES] } },
          select: { lucro: true },
        },
      },
    }),
    prisma.conta.findMany({
      where: { status: "ATIVA", deletedAt: null },
      select: { saldoAtual: true },
    }),
    prisma.providerBudget.findMany({
      where: { periodKey: { in: [spDayKey(day.start), ...hourKeysOf(day)] } },
    }),
    lerIdentidadeAntesDoJogo(day),
    // A medição do casamento não segura o resumo: se a leitura falhar, ele sai
    // sem o bloco, e o dia fica sem linha na série.
    readMatchingDay(day).catch((err: unknown) => {
      log.error(
        { err, eventCode: LOG_EVENTS.OBSERVABILITY_METRICS_WRITE_FAILED, day: spDayKey(day.start) },
        "casamento do dia não lido; o resumo sai sem o bloco e a série diária fica sem o dia",
      );
      return null;
    }),
  ]);
  return { betsHoje, betsMes, tipsHoje, pendentes, acoesAbertas, bancas, contas, budgets, identidadeAntesDoJogo, matching };
}

/**
 * Das apostas cujo jogo começou no dia, quantas tinham a identidade sharp
 * resolvida antes do início, que é o que deixa o fechamento da Pinnacle ser
 * colhido. Ficam de fora a banca sem sharp, o kickoff provisório (sem início
 * conhecido), a entrada ao vivo (com placar, ou postada depois do início), a múltipla e o mercado
 * sem cobertura (UNSUPPORTED): nelas a identidade antes do jogo não é esperada.
 */
async function lerIdentidadeAntesDoJogo(day: { start: Date; end: Date }) {
  const [row] = await prisma.$queryRaw<Array<{ casadas: bigint; total: bigint }>>`
    SELECT
      count(*) FILTER (
        WHERE s."identityStatus" IN ('MATCHED', 'MANUAL') AND s."identityResolvedAt" <= b.data
      ) AS casadas,
      count(*) AS total
    FROM bets b
    JOIN bankrolls k ON k.id = b."bankrollId"
    LEFT JOIN bet_sharp s ON s."betId" = b.id
    WHERE b."deletedAt" IS NULL
      AND b."kickoffInferido" = false
      AND b."liveScoreHome" IS NULL
      AND COALESCE(b."sourcePostedAt", b."registradoEm") < b.data
      AND b.data >= ${day.start} AND b.data < ${day.end}
      AND k."sharpMode" <> 'OFF'
      AND (s."betId" IS NULL OR (
        s."identityStatus" <> 'UNSUPPORTED' AND s."noOddsReason" IS DISTINCT FROM 'multipla'
      ))
  `;
  return { casadas: Number(row?.casadas ?? 0), total: Number(row?.total ?? 0) };
}

const pctOf = (spent: number, cap: number) => (cap > 0 ? Math.round((spent / cap) * 100) : 0);

/**
 * Consumo das cotas dos providers principais no dia. A BridgeOdds tem teto por
 * HORA, e a hora do envio (madrugada) diria ~0%: entra o total do dia e a hora
 * mais cheia, que é onde o teto aperta.
 */
export function quotasPrincipais(
  budgets: Array<{ provider: string; periodKey: string; spent: number }>,
  day: { start: Date; end: Date },
): ExecutiveBriefingData["quotas"] {
  const principais = ["flashscore", "pinnacle17", "bridgeodds"];
  const dayKey = spDayKey(day.start);
  const hourKeys = new Set(hourKeysOf(day));
  return PROVIDER_CAPS
    .filter((cap) => principais.includes(cap.provider))
    .map((cap) => {
      if (cap.period === "hour") {
        const hours = budgets.filter((row) => row.provider === cap.provider && hourKeys.has(row.periodKey));
        const spent = hours.reduce((total, row) => total + row.spent, 0);
        const peak = hours.reduce((max, row) => Math.max(max, row.spent), 0);
        const dayCap = cap.cap * hourKeys.size;
        return { provider: cap.provider, spent, cap: dayCap, pct: pctOf(spent, dayCap),
          peakHour: { spent: peak, cap: cap.cap, pct: pctOf(peak, cap.cap) } };
      }
      const spent = budgets.find((row) => row.provider === cap.provider && row.periodKey === dayKey)?.spent ?? 0;
      return { provider: cap.provider, spent, cap: cap.cap, pct: pctOf(spent, cap.cap) };
    });
}

/** Coleta todos os indicadores financeiros, patrimoniais e operacionais do briefing. */
async function coletarExecutiveBriefing(day: { start: Date; end: Date }): Promise<ExecutiveBriefingData> {
  const dados = await lerDadosDoBriefing(day);
  // O capital da banca é em unidades, como no painel: a banca atual é
  // capital + lucro em unidades, e vale em reais pela unidade de hoje.
  const bancas = dados.bancas.map((banca) => {
    const lucroUnidades = roundMoney(sumMoneyBy(banca.bets, (bet) => toNumber(bet.lucro), 6), 4);
    const saldoUnidades = roundMoney(toNumber(banca.capitalInicial) + lucroUnidades, 4);
    return {
      nome: banca.nome,
      lucroUnidades,
      saldoUnidades,
      saldoEstimado: unitsToBrl(saldoUnidades, toNumber(banca.valorUnidade)),
    };
  });

  return {
    dataReferencia: formatSpDateWithYear(day.start),
    hoje: {
      totalResolvidas: dados.betsHoje.length,
      ...resultadosDoDia(dados.betsHoje),
      ...resumoFinanceiro(dados.betsHoje),
    },
    mes: {
      nomeMes: MONTH_NAMES[utcToSpParts(day.start).getUTCMonth()] ?? "Mês",
      totalResolvidas: dados.betsMes.length,
      ...resumoFinanceiro(dados.betsMes),
    },
    bancas,
    patrimonio: {
      saldoEmContasAtivas: roundMoney(sumMoneyBy(dados.contas, (c) => toNumber(c.saldoAtual), 2), 2),
      contasAtivas: dados.contas.length,
      saldoBancasTotal: roundMoney(sumMoneyBy(bancas, (b) => b.saldoEstimado, 2), 2),
    },
    operacoes: {
      tipsHoje: dados.tipsHoje,
      pendentes: dados.pendentes,
      acoesAbertas: dados.acoesAbertas,
      identidadeAntesDoJogo: dados.identidadeAntesDoJogo,
    },
    matching: dados.matching,
    quotas: quotasPrincipais(dados.budgets, day),
  };
}

export async function sendExecutiveBriefing(now = new Date()): Promise<{ data: ExecutiveBriefingData; delivered: boolean }> {
  const day = briefingDay(now);
  const data = await coletarExecutiveBriefing(day);
  // A série diária do casamento sai antes do envio, para o Telegram fora do ar
  // não deixar o dia sem linha, e não segura o resumo: se falhar, o log
  // registra o dia que faltou.
  if (data.matching) {
    await recordMatchingDay(day, data.matching, data.operacoes.identidadeAntesDoJogo).catch((err: unknown) => {
      log.error(
        { err, eventCode: LOG_EVENTS.OBSERVABILITY_METRICS_WRITE_FAILED, dataReferencia: data.dataReferencia },
        "série diária do casamento não gravada; o resumo segue",
      );
    });
  }
  // Última trava: nomes longos ainda podem passar do limite do Telegram.
  const texto = truncatePendingDigestMessage(formatarExecutiveBriefing(data));
  const delivery = await sendRequiredOperatorNotification(texto, {
    key: `executive-briefing:${data.dataReferencia}`, forMs: DAILY_NOTIFICATION_DEDUPE_MS,
  });
  log.info({ dataReferencia: data.dataReferencia, delivery }, "briefing executivo diário entregue");
  return { data, delivered: delivery === "delivered" || delivery === "deduplicated" };
}
