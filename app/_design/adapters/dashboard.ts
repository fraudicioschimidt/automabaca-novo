import "server-only";
import { prisma } from "@/src/infra/prisma";
import type { Prisma } from "@/src/generated/prisma/client";
import { getBankrollEquityCurves } from "@/src/services/painel/queries/bankroll-curves";
import { getBankrollSummaries, type BankrollSummary } from "@/src/services/painel/queries/bankrolls";
import { getLastVisit, getResumoHoje, getSinceLastVisit } from "@/src/services/painel/queries/dashboard";
import { getAlertas } from "@/src/services/painel/operacoes/alertas";
import { getSaudeMotor, workerVivo } from "@/src/services/painel/operacoes/saude";
import { WEEKDAY_ABBREVIATIONS, formatSpDateTime, formatSpFullDate, formatSpTime, spGreeting, utcToSpParts } from "@/src/domain/dates";
import { fonteDeFrescor, frescorDaFonte } from "@/src/domain/frescor";
import { roundMoney, sumMoneyBy } from "@/src/domain/money";
import { spSky } from "@/src/domain/sky";
import { getCanaisDecisao } from "@/src/services/painel/canais";
import { baseTipster } from "./_tipster";

/**
 * Dashboard: cada banca vira um "tipster" do ranking, com a curva de equity. O
 * resumo de hoje vem pronto de `getResumoHoje`; a tela nunca o estima a partir
 * dos totais. Mock: app/_design/mock/dashboard.ts.
 */

/**
 * O resumo "desde a última visita" conta até o instante desta leitura, que a
 * tela devolve para avançar a visita depois de mostrá-lo. A leitura não escreve.
 * Primeira visita: não há resumo.
 */
async function sinceLastVisit(username: string, lidoEm: Date, client: Prisma.TransactionClient) {
  const lastVisit = await getLastVisit(username, client);
  if (!lastVisit || lastVisit >= lidoEm) return null;
  const s = await getSinceLastVisit(lastVisit, lidoEm, client);
  return {
    sinceLabel: formatSpDateTime(s.since),
    newBets: s.newBets,
    settled: s.settled,
    lucroUnits: s.lucroUnits,
    lucroReais: s.lucroReais,
    closings: s.closings,
    clvMean: s.clvMean,
    openAlerts: s.openAlerts,
  };
}

export async function getDashboardData(nome: string, username: string) {
  const lidoEm = new Date();
  const lidoEmSp = utcToSpParts(lidoEm);
  const saudePromise = getSaudeMotor();
  // Totais, curva e bases de decisão precisam enxergar a mesma liquidação.
  // Saúde e filas operacionais não mantêm a transação financeira aberta.
  const [financial, saude, alertas] = await Promise.all([
    prisma.$transaction(async (tx) => {
      const summaries = await getBankrollSummaries(tx);
      const hoje = await getResumoHoje(lidoEm, tx);
      const eq = await getBankrollEquityCurves(tx);
      const decs = await getCanaisDecisao(lidoEm, {}, tx);
      const desdeUltimaVisita = await sinceLastVisit(username, lidoEm, tx);
      return { summaries, hoje, eq, decs, desdeUltimaVisita };
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 }),
    saudePromise,
    saudePromise.then((status) => getAlertas(status, lidoEm)),
  ]);

  const { summaries, hoje, eq, decs, desdeUltimaVisita } = financial;

  // Todas as curvas têm o mesmo comprimento (a tela soma índice-a-índice); ≥2
  // para o sparkline/área não dividir por zero.
  const L = Math.max(eq.days.length, 2);
  const curveBy = new Map(eq.curves.map((c) => [c.bankrollId, c]));

  function equitySeries(s: BankrollSummary, key: "acumulado" | "accumulatedBrl"): number[] {
    const acc = curveBy.get(s.id)?.[key];
    if (!acc || acc.length === 0) return Array.from({ length: L }, () => 0);
    const u = acc.map((v) => roundMoney(v));
    while (u.length < L) u.unshift(0);
    return u;
  }

  const byId = new Map(decs.map((d) => [d.id, d.decisao]));
  const tipsters = summaries.map((s) => {
    const d = byId.get(s.id);
    return {
      ...baseTipster(s),
      equity: equitySeries(s, "acumulado"),
      equityBrl: equitySeries(s, "accumulatedBrl"),
      veredito: d?.veredito ?? "AMOSTRA_CURTA",
      tStat: d?.tStat ?? null,
      clvMedio: d?.clvMedio ?? null,
    };
  });

  /**
   * Média por dia OPERADO — a régua que o lucro de hoje não tem sozinho. O
   * divisor é `eq.days`, que a query monta só com dias de jogo que TÊM aposta
   * liquidada: responde "num dia em que eu opero, quanto costuma sair" sem
   * diluir por dias parados. O rótulo diz o divisor junto.
   *
   * `null` com menos de 2 dias: média de um dia é o próprio dia.
   */
  const totalRealizado = sumMoneyBy(eq.curves, (c) => c.accumulatedBrl[c.accumulatedBrl.length - 1] ?? 0);
  const diasOperados = eq.days.length;
  const mediaDiaria = diasOperados >= 2 ? roundMoney(totalRealizado / diasOperados) : null;

  return {
    tipsters,
    // Os alertas são o estado lido agora: o horário é o da leitura, para a
    // página aberta há uma hora não dizer "agora" sobre um estado antigo.
    alerts: alertas.map((a) => ({ id: a.id, kind: a.kind, title: a.title, desc: a.desc, time: `lido às ${formatSpTime(lidoEm)}` })),
    engine: {
      alive: workerVivo(saude, lidoEm),
      dbOk: saude.dbOk,
      // A idade do motor sai do mesmo `frescorDaFonte` que decide `alive`.
      frescor: [frescorDaFonte(fonteDeFrescor("motor"), saude.ultimoHeartbeat, lidoEm)],
    },
    greeting: `${spGreeting(lidoEm)}, ${nome}`,
    // O sol ou a lua ao lado da saudação, no céu de SP do instante da leitura.
    sky: spSky(lidoEm),
    todayLabel: formatSpFullDate(lidoEm),
    // A folhinha do cartão "Hoje": dia da semana abreviado e dia do mês, em SP.
    todayTile: { weekday: WEEKDAY_ABBREVIATIONS[lidoEmSp.getUTCDay()] ?? "", day: lidoEmSp.getUTCDate() },
    today: {
      // Lucro do dia pela data de SP em getResumoHoje, não pelo delta da curva.
      lucroDia: hoje.lucroDia,
      resolvidas: hoje.resolvidasHoje,
      tips: hoje.tipsNovas,
      aResolver: hoje.aResolver,
      mediaDiaria,
      diasOperados,
    },
    visit: { readAt: lidoEm.toISOString(), since: desdeUltimaVisita },
  };
}
