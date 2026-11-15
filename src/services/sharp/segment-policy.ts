import { Prisma, type SegmentPhase } from "@/src/generated/prisma/client";
import { sendOperationalAlert, sendOperatorNotification } from "@/src/services/ops/alerts";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { normalizeMercadoKey } from "@/src/domain/mercados/catalog";
import { SUPPLIER_NO_ODDS_REASONS } from "@/src/domain/no-odds-reason";
import { reliableClvSql } from "@/src/services/sharp/closing-evidence";

const log = createLogger("segment-policy");

/**
 * Probation por segmento esporte×mercado: toda família elegível NASCE em
 * PROBATION com sharp ligado; com volume (≥100 apostas avaliadas), CLV
 * confiável abaixo de 50% vira SHARP_OFF sozinho — as APIs passam a servir só
 * à IDENTIDADE (times/campeonato/país/data). Acima do corte → SHARP_ACTIVE.
 *
 * A chave usa o mercado FINAL sport-aware (Total ≠ Total Points ≠
 * Total (Games) – Match) — contagem separada por esporte E mercado.
 *
 * A amostra é a dos últimos 30 dias e só tem o que fala do fornecedor: o CLV
 * reconstruível e a ausência que é dele (`SUPPLIER_NO_ODDS_REASONS`). Política da
 * banca, entrada ao vivo e falha nossa (captura que não aconteceu a tempo,
 * seleção sem linha) ficam fora. Depois de SHARP_OFF os fechamentos novos saem
 * `sharp_off` e a amostra não andaria mais: passados 14 dias o segmento volta
 * a PROBATION e é medido de novo, só com o que fechou desde então
 * (`sampleStartedAt`, que vale em qualquer fase: sem ele, o fechamento ruim
 * de antes do desligamento voltaria à amostra e a fase oscilaria). Decisão
 * MANUAL do dono nunca é sobrescrita.
 */

export const SEGMENT_MIN_BETS = 100;
export const SEGMENT_MIN_CLV_RELIABLE_PCT = 50;
export const SEGMENT_WINDOW_DAYS = 30;
export const SEGMENT_RETEST_AFTER_DAYS = 14;

// Fases são dado re-derivável: cache curto e invalidação nas escritas.
const CACHE_TTL_MS = 15_000;
let _cache: { byKey: Map<string, SegmentPhase>; at: number } | null = null;

export function invalidateSegmentPolicyCache(): void {
  _cache = null;
}

function keyOf(esporte: string, mercado: string): string {
  return `${normalizeMercadoKey(esporte)}|${normalizeMercadoKey(mercado)}`;
}

type PolicyReader = Pick<Prisma.TransactionClient, "marketSegmentPolicy">;

/** Fases lidas agora, sem cache — para decidir dentro de uma transação. */
export async function loadSegmentPhaseMap(db: PolicyReader = prisma): Promise<Map<string, SegmentPhase>> {
  const rows = await db.marketSegmentPolicy.findMany({
    select: { esporte: true, mercado: true, phase: true },
  });
  return new Map(rows.map((r) => [keyOf(r.esporte, r.mercado), r.phase]));
}

/** Mapa de fases por segmento (cache 15s) — carregar uma vez por lote. */
export async function getSegmentPhaseMap(): Promise<Map<string, SegmentPhase>> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.byKey;
  const byKey = await loadSegmentPhaseMap();
  _cache = { byKey, at: Date.now() };
  return byKey;
}

/** Alguma política SHARP_OFF cobre o segmento, lida agora (sem cache). */
export async function anySegmentSharpOff(db: PolicyReader, esporte: string, mercado: string): Promise<boolean> {
  const policies = await db.marketSegmentPolicy.findMany({
    where: { phase: "SHARP_OFF" },
    select: { esporte: true, mercado: true },
  });
  return policies.some((p) => keyOf(p.esporte, p.mercado) === keyOf(esporte, mercado));
}

/** Fase do segmento; sem linha = PROBATION (sharp ligado, em prova). */
export async function getSegmentPhase(esporte: string, mercado: string): Promise<SegmentPhase> {
  const map = await getSegmentPhaseMap();
  return map.get(keyOf(esporte, mercado)) ?? "PROBATION";
}

export function isSegmentSharpOff(
  esporte: string,
  mercado: string,
  phaseMap: Map<string, SegmentPhase>,
): boolean;
export function isSegmentSharpOff(esporte: string, mercado: string): Promise<boolean>;
export function isSegmentSharpOff(
  esporte: string,
  mercado: string,
  phaseMap?: Map<string, SegmentPhase>,
): boolean | Promise<boolean> {
  if (phaseMap) {
    return (phaseMap.get(keyOf(esporte, mercado)) ?? "PROBATION") === "SHARP_OFF";
  }
  return getSegmentPhase(esporte, mercado).then((phase) => phase === "SHARP_OFF");
}

type SegmentAggregate = { esporte: string; mercado: string; n: bigint; ok: bigint };

/** SHARP_OFF automático antigo volta a PROBATION para ser medido de novo. */
async function reopenOldSharpOff(now: Date): Promise<number> {
  const due = await prisma.marketSegmentPolicy.findMany({
    where: {
      phase: "SHARP_OFF",
      source: "AUTO",
      decidedAt: { lte: new Date(now.getTime() - SEGMENT_RETEST_AFTER_DAYS * 86_400_000) },
    },
    select: { id: true, esporte: true, mercado: true },
  });
  let reopened = 0;
  for (const policy of due) {
    const updated = await prisma.marketSegmentPolicy.updateMany({
      where: { id: policy.id, phase: "SHARP_OFF", source: "AUTO" },
      data: { phase: "PROBATION", decidedAt: now, evaluatedAt: now, sampleStartedAt: now },
    });
    if (updated.count === 0) continue;
    reopened += 1;
    await sendOperatorNotification(
      `🔁 ${policy.esporte} · ${policy.mercado}: medição de preço religada para novo teste\n` +
        `Passaram ${SEGMENT_RETEST_AFTER_DAYS} dias desligada; conta de novo só o que fechar daqui para a frente.`,
    );
  }
  return reopened;
}

/**
 * Avaliador (job `policy.evaluate`): agrega apostas com avaliação de closing
 * CONCLUÍDA (fetchedAt) em bancas CLV_ONLY e decide a fase por segmento.
 */
export async function evaluateSegmentPolicies(now = new Date()): Promise<{
  segmentos: number;
  transicoes: number;
}> {
  let transicoes = await reopenOldSharpOff(now);
  const windowStart = new Date(now.getTime() - SEGMENT_WINDOW_DAYS * 86_400_000);
  const supplierReasons = [...SUPPLIER_NO_ODDS_REASONS];
  const rows = await prisma.$transaction(async (tx) => {
    const clvEvidence = await reliableClvSql(tx, {
      fetchedAt: { gte: windowStart },
      bet: {
        deletedAt: null,
        bankroll: { is: { sharpMode: "CLV_ONLY" } },
        sharp: { is: { identityStatus: { in: ["MATCHED", "MANUAL"] } } },
      },
    });
    return tx.$queryRaw<SegmentAggregate[]>(Prisma.sql`
      SELECT b.esporte, b.mercado, count(*) AS n,
             count(*) FILTER (WHERE ${clvEvidence}) AS ok
      FROM bets b
      JOIN bet_closing bc ON bc."betId" = b.id
      JOIN bet_sharp s ON s."betId" = b.id
      JOIN bankrolls k ON k.id = b."bankrollId"
      LEFT JOIN market_segment_policies p ON p.esporte = b.esporte AND p.mercado = b.mercado
      WHERE b."deletedAt" IS NULL
        AND bc."fetchedAt" >= ${windowStart}
        -- Segmento religado para novo teste conta só o que fechou depois disso,
        -- também depois de a nova amostra decidir a fase.
        AND (p."sampleStartedAt" IS NULL OR bc."fetchedAt" >= p."sampleStartedAt")
        -- Só o que fala do fornecedor: o CLV confiável ou a ausência que é dele.
        -- Os congelamentos do próprio SHARP_OFF e as falhas nossas ficam fora.
        AND ((${clvEvidence}) OR bc."noOddsReason" = ANY(${supplierReasons}::text[]))
        AND s."identityStatus" IN ('MATCHED', 'MANUAL')
        AND k."sharpMode" = 'CLV_ONLY'
      GROUP BY 1, 2
      HAVING count(*) >= ${SEGMENT_MIN_BETS}
    `);
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });

  // A falha de UM segmento (deadlock/blip) não aborta a avaliação dos demais:
  // coleta as falhas e alerta uma vez no fim. As operações são idempotentes.
  const falhas: Array<{ esporte: string; mercado: string }> = [];
  for (const row of rows) {
    try {
      const n = Number(row.n);
      const ok = Number(row.ok);
      const pct = (ok / n) * 100;
      const alvo: SegmentPhase = pct < SEGMENT_MIN_CLV_RELIABLE_PCT ? "SHARP_OFF" : "SHARP_ACTIVE";

      const existing = await prisma.marketSegmentPolicy.findUnique({
        where: { esporte_mercado: { esporte: row.esporte, mercado: row.mercado } },
      });
      if (existing?.source === "MANUAL") continue;

      const mudou = (existing?.phase ?? "PROBATION") !== alvo;
      const updated = await prisma.marketSegmentPolicy.updateMany({
        where: { esporte: row.esporte, mercado: row.mercado, source: "AUTO" },
        data: {
          phase: alvo,
          betsAvaliadas: n,
          clvReliablePct: pct,
          evaluatedAt: now,
          ...(mudou ? { decidedAt: now } : {}),
        },
      });

      if (updated.count === 0 && !existing) {
        try {
          await prisma.marketSegmentPolicy.create({
            data: {
              esporte: row.esporte,
              mercado: row.mercado,
              phase: alvo,
              betsAvaliadas: n,
              clvReliablePct: pct,
              evaluatedAt: now,
              decidedAt: now,
            },
          });
        } catch (err: unknown) {
          const code = (err && typeof err === "object" && "code" in err) ? (err as { code: unknown }).code : "";
          if (code !== "P2002") throw err;
        }
      }
      if (mudou) {
        transicoes += 1;
        const emoji = alvo === "SHARP_OFF" ? "🔇" : "📈";
        await sendOperatorNotification(
          `${emoji} ${row.esporte} · ${row.mercado}: ` +
            (alvo === "SHARP_OFF" ? "medição de preço desligada\n" : "medição de preço ligada\n") +
            `Em ${n} apostas, ${pct.toFixed(1)}% tiveram CLV confiável (mínimo ${SEGMENT_MIN_CLV_RELIABLE_PCT}%).` +
            (alvo === "SHARP_OFF" ? " As fontes de preço seguem usadas só para identificar o jogo." : ""),
        );
      }
    } catch (err) {
      log.warn(
        { err, esporte: row.esporte, mercado: row.mercado },
        "avaliação de segmento falhou — lote continua",
      );
      falhas.push({ esporte: row.esporte, mercado: row.mercado });
    }
  }
  if (falhas.length > 0) {
    await sendOperationalAlert(
      `⚠️ Avaliação de segmentos com falhas\n` +
        `${falhas.length} segmento(s) não puderam ser avaliados; os demais seguiram: ` +
        falhas.map((f) => `${f.esporte} · ${f.mercado}`).join(", ") +
        "\n👉 Nada a fazer: esses segmentos mantêm a fase atual até a próxima avaliação. Se repetir, veja o log do worker (policy.evaluate).",
      {
        source: "policy.evaluate",
        key: "segment-batch-failure",
        title: "Falha parcial na avaliação de segmentos",
        resource: "market-segment-policy",
        evidence: { failedSegments: falhas.map((f) => `${f.esporte}·${f.mercado}`) },
        autoResolve: false,
      },
    );
  }
  invalidateSegmentPolicyCache();
  if (rows.length > 0) {
    log.info({ segmentos: rows.length, transicoes }, "avaliação de segmentos concluída");
  }
  return { segmentos: rows.length, transicoes };
}
