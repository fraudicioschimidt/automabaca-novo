import "server-only";
import { prisma } from "@/src/infra/prisma";
import { getBankrollChart } from "@/src/services/painel/queries/bankroll-curves";
import { getBankrollDetail, getBankrollsTips } from "@/src/services/painel/queries/bankrolls";
import { apostasReliquidadas } from "@/src/services/painel/aposta/reliquidacao";
import { roundMoney } from "@/src/domain/money";
import { spDayKey } from "@/src/domain/dates";
import { toBet, toRemovalView } from "./aposta";
import { splitEvento } from "./_evento";
import { getBankrollVersion } from "@/src/services/painel/queries/bankrolls";

/**
 * Detalhe da banca para BankrollScreen: BETS, METRICS, CHART, a identidade da
 * banca (`bk`) e o seletor (`tips`). A tela recomputa mês, dia, calendário,
 * filtros e CSV do BETS, então basta o array fiel. Mock: app/_design/mock/bet.ts.
 */

/** "2026-06-10" → "10/06". */
function ddmm(dayKey: string): string {
  return `${dayKey.slice(8, 10)}/${dayKey.slice(5, 7)}`;
}

export async function getBankrollData(slug: string) {
  // Lê antes do conteúdo: uma mudança concorrente provoca novo refresh, nunca some entre leituras.
  const liveVersion = await getBankrollVersion(slug);
  const ref = new Date();
  const snapshot = await prisma.$transaction(async (tx) => {
    const detail = await getBankrollDetail(slug, tx);
    if (!detail) return null;
    const tips = await getBankrollsTips(tx);
    const chart = await getBankrollChart(detail.resumo.id, ref, tx);
    // Só os ids exibidos, no mesmo estado das linhas e dos indicadores.
    const reliquidadas = await apostasReliquidadas(detail.bets.map((b) => b.id), tx);
    return { detail, tips, chart, reliquidadas };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
  if (!snapshot) return null;
  const { detail, tips, chart, reliquidadas } = snapshot;
  const r = detail.resumo;

  // O gráfico trata sozinho zero e um ponto (estado vazio e ponto único);
  // completar a série inventaria um lucro zero que ninguém registrou.
  const CHART = chart.map((p) => ({ label: ddmm(p.day), realized: p.realized }));

  return {
    liveVersion,
    BETS: detail.bets.map((b) => ({ ...toBet(b), reliq: reliquidadas.has(b.id) })),
    historyTotal: detail.historyTotal,
    removed: {
      total: detail.removed.total,
      bets: detail.removed.bets.map((b) => ({
        id: b.id,
        ...splitEvento(b.evento),
        market: b.mercado,
        line: b.selecao,
        odds: b.odds,
        stake: b.stake,
        day: spDayKey(b.data),
        removal: toRemovalView(b.removal),
      })),
    },
    METRICS: {
      capital: r.capitalInicial, // já em unidades
      ops: r.apostas,
      settled: r.resolvidas,
      lucro: r.lucro,
      acerto: r.acerto,
      roi: r.roi ?? 0,
      hasRoi: r.roi !== null,
      clvMean: r.clv ?? 0,
      hasClv: r.clv !== null,
      // A média e sua cobertura usam o mesmo histórico completo; a cobertura
      // divide pela base alcançável, não por todas as apostas.
      clvShare: r.clvBase > 0 ? Math.round((r.clvSamples / r.clvBase) * 100) : null,
      open: r.pendentes,
      openUnits: roundMoney(r.stakePendente, 2),
    },
    CHART,
    todayKey: spDayKey(ref),
    bk: { name: r.nome, sharpMode: r.sharpMode, slug: r.slug, logoUrl: r.logoUrl },
    tips: tips.map((s) => ({ id: s.slug, name: s.nome })),
  };
}
