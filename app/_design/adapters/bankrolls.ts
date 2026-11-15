import "server-only";
import { prisma } from "@/src/infra/prisma";
import { getBankrollSummaries } from "@/src/services/painel/queries/bankrolls";
import { getCanaisDecisao } from "@/src/services/painel/canais";
import { AMOSTRA_MINIMA_CLV, VEREDITO_NA_TELA } from "@/src/domain/analyzer/shared";
import { baseTipster } from "./_tipster";
import { formaDoDelta, textoDeAmostraCurta } from "../lib/comparacao-de-janelas";

/**
 * Lista de bancas (BankrollsScreen): cada banca vira um "tipster" com a decisão
 * de assinatura de `getCanaisDecisao`. Mock: app/_design/mock/dashboard.ts.
 */

const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

const JANELA_ANTERIOR = "30 dias anteriores";

/**
 * O Δ 30d só é número com base nos dois lados (a mesma guarda do Analyzer):
 * um fechamento contra um pintaria de verde ou vermelho uma variação de acaso.
 * Sem base, a nota diz por quê.
 */
function deltaDe30Dias(d: {
  clv30d: number | null; n30d: number; n30a60d: number; deltaClv30d: number | null;
}): { d30: number | null; d30Note: string | null } {
  const base = { atual: d.n30d, anterior: d.n30a60d };
  const anterior = d.clv30d != null && d.deltaClv30d != null ? d.clv30d - d.deltaClv30d : null;
  const forma = formaDoDelta({ rotuloAnterior: JANELA_ANTERIOR, atual: d.clv30d, anterior, base });
  if (forma === "delta") return { d30: round1(d.deltaClv30d), d30Note: null };
  if (forma === "amostra-curta") return { d30: null, d30Note: textoDeAmostraCurta(base, JANELA_ANTERIOR) };
  if (forma === "anterior-vazia") return { d30: null, d30Note: `sem fechamento nos ${JANELA_ANTERIOR}` };
  return { d30: null, d30Note: "sem fechamento nos últimos 30 dias" };
}

export async function getBankrollsData() {
  const ref = new Date();
  const { sums, decs } = await prisma.$transaction(async (tx) => {
    const sums = await getBankrollSummaries(tx);
    const decs = await getCanaisDecisao(ref, {}, tx);
    return { sums, decs };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
  const byId = new Map(decs.map((d) => [d.id, d.decisao]));

  const tipsters = sums.map((s) => {
    const d = byId.get(s.id);
    const dec = d
      ? {
          amostra: d.nClv,
          beat: d.beatClosePct == null ? null : Math.round(d.beatClosePct),
          clv: round1(d.clvMedio),
          clvMedio: d.clvMedio,
          distClv: d.distClv,
          ...deltaDe30Dias(d),
          roiReal: round1(d.roiReal),
          // Quantas apostas sustentam o ROI. A coluna "Amostra" ao lado conta
          // CLVs, outra base: sem isto um ROI de uma aposta pareceria medido.
          nRoi: d.nFinal,
          verdict: VEREDITO_NA_TELA[d.veredito],
          veredito: d.veredito,
          tStat: d.tStat,
          faltam: Math.max(0, AMOSTRA_MINIMA_CLV - d.nClv),
        }
      : {
          amostra: 0,
          beat: null,
          clv: null,
          clvMedio: null,
          distClv: [],
          d30: null,
          d30Note: null,
          roiReal: null,
          nRoi: 0,
          verdict: VEREDITO_NA_TELA.AMOSTRA_CURTA,
          veredito: "AMOSTRA_CURTA" as const,
          tStat: null,
          faltam: AMOSTRA_MINIMA_CLV,
        };
    return { ...baseTipster(s), dec };
  });

  return { tipsters };
}
