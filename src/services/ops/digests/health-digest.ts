import { DAILY_NOTIFICATION_DEDUPE_MS } from "@/src/domain/mensagem-operador";
import { formatDurationMinutes, spDayKey } from "@/src/domain/dates";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { sendRequiredOperatorNotification } from "@/src/services/ops/alerts";
import { countActiveDeadLetters } from "@/src/services/ops/dlq/pgboss-queues";
import { CAPTURE_ACTIONS_WHERE, countActionableOperationalActions } from "@/src/services/ops/operational-actions";
import { readCaptureLatency, readChannelUpdateVolume, watchedChannels } from "@/src/services/capture/channel/channel-activity";
import { DIGEST_MAX_CHARS, truncatePendingDigestMessage } from "./pending-digest";

const log = createLogger("health-digest");

/**
 * Digest diário de SAÚDE DA CAPTURA (o `pending-digest` cuida das apostas a
 * liquidar): a aposta foi capturada e MEDIDA como deveria? Falha de captura
 * costuma ser SILENCIOSA (nome de time errado, identidade duplicada,
 * modalidade apagada): o sistema não cai, degrada. Manda o AGREGADO do dia,
 * onde queda de taxa aparece, e não repete o que a caixa de ações mostra item
 * a item.
 */

/** Abaixo disto o dia é reportado como ruim, não como rotina. */
export const CASAMENTO_ALVO_PCT = 80;
/** Do post à captura, no p95: acima disto a aposta chega tarde para o dono pegar. */
export const LATENCIA_ALVO_MIN = 10;

export type HealthDigest = {
  capturadas: number;
  casadas: number;
  pctCasamento: number;
  /** Mesma conta na janela de 7 dias — revela deriva que o dia isolado esconde. */
  pctCasamento7d: number;
  semCasar: number;
  emProcessamento: number;
  liquidadas: number;
  /** Ações da captura na caixa (`CAPTURE_ACTIONS_WHERE`); as demais áreas têm resumo próprio. */
  acoesAbertas: number;
  deadLetters: number;
  /** Updates de canal que chegaram do Telegram em 24 h, antes de qualquer leitura. */
  updates24h: number;
  /** Média diária dos últimos 8 dias; null enquanto a tabela não tem 24 h. */
  updatesMediaDia: number | null;
  /** O dia sem update é alarme: a tabela tem histórico e o normal é ≥ 1 update por dia. */
  updatesCobrados: boolean;
  /** Bancas cujo canal está calado além do próprio ritmo. */
  canaisMudos: string[];
  /** Do post ao 📥 em 24 h, em minutos; null sem captura na janela. */
  latenciaP50Min: number | null;
  latenciaP95Min: number | null;
  saudavel: boolean;
};

export async function coletarHealthDigest(now = new Date()): Promise<HealthDigest> {
  const desde = new Date(now.getTime() - 24 * 3_600_000);
  const [volume, canais, latencia] = await Promise.all([
    readChannelUpdateVolume(now),
    watchedChannels(now),
    readCaptureLatency(null, desde),
  ]);
  const [capturadas, casadas, semCasar, emProcessamento, liquidadas, acoesAbertas, dlq] =
    await Promise.all([
      prisma.bet.count({ where: { deletedAt: null, registradoEm: { gte: desde } } }),
      prisma.bet.count({
        where: {
          deletedAt: null,
          registradoEm: { gte: desde },
          sharp: { is: { identityStatus: { in: ["MATCHED", "MANUAL"] } } },
        },
      }),
      prisma.bet.count({
        where: {
          deletedAt: null,
          registradoEm: { gte: desde },
          sharp: { is: { identityStatus: "UNMATCHED" } },
        },
      }),
      prisma.bet.count({
        where: {
          deletedAt: null,
          registradoEm: { gte: desde },
          sharp: { is: { identityStatus: "PENDING" } },
        },
      }),
      // Apostas que SAÍRAM de pendente, uma vez cada: reabertura (→ PENDING)
      // e correção (WON → LOST) também gravam STATUS_CHANGED e não são
      // liquidação nova. Amarrado à aposta VIVA, como as contagens de captura
      // acima: tip que depois levou 👎 não conta.
      prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(DISTINCT e."betId") AS n
        FROM settlement_events e JOIN bets b ON b.id = e."betId"
        WHERE e.type = 'STATUS_CHANGED' AND e."createdAt" >= ${desde}
          AND b."deletedAt" IS NULL
          AND e.payload->>'from' = 'PENDING' AND e.payload->>'to' <> 'PENDING'
      `.then((rows) => Number(rows[0]?.n ?? 0)),
      // Só as da captura: SLO, liquidação e filas agendadas abertos não dizem
      // que a captura está doente.
      countActionableOperationalActions(CAPTURE_ACTIONS_WHERE),
      countActiveDeadLetters(),
    ]);

  // Denominador só do que já tem veredito: aposta em processamento ainda pode
  // casar, e contá-la como falha faria o número piscar sem motivo.
  const comVeredito = casadas + semCasar;
  const pctCasamento = comVeredito === 0 ? 100 : (casadas / comVeredito) * 100;
  const deadLetters = dlq;

  // A referência de 7 dias existe para pegar DERIVA: a taxa cair de 84% para
  // 70% ao longo de uma semana não chama atenção em nenhum dia isolado, e com
  // ~8 apostas/dia um alerta por hora julgaria amostras de 0 a 2 — alarme falso
  // que ensina a ignorar. Comparar hoje com a semana custa uma consulta.
  const [semana] = await prisma.$queryRaw<Array<{ casadas: bigint; comVeredito: bigint }>>`
    SELECT count(*) FILTER (WHERE s."identityStatus" IN ('MATCHED', 'MANUAL')) AS casadas,
           count(*) FILTER (WHERE s."identityStatus" IN ('MATCHED', 'MANUAL', 'UNMATCHED')) AS "comVeredito"
    FROM bets b JOIN bet_sharp s ON s."betId" = b.id
    WHERE b."deletedAt" IS NULL
      AND b."registradoEm" >= ${new Date(now.getTime() - 7 * 24 * 3_600_000)}
  `;
  const comVeredito7d = Number(semana?.comVeredito ?? 0);
  const pctCasamento7d = comVeredito7d === 0
    ? 100
    : (Number(semana?.casadas ?? 0) / comVeredito7d) * 100;

  // Tabela nova ou canais que quase não postam: zero no dia não prova nada.
  const updatesCobrados = volume.dailyAverage !== null && volume.dailyAverage >= 1;
  const canaisMudos = canais.filter((canal) => canal.silence.state === "mudo").map((canal) => canal.nome);
  const tempo = latencia.get("*");
  const latenciaP95Min = tempo?.p95Min ?? null;
  return {
    capturadas,
    casadas,
    pctCasamento,
    pctCasamento7d,
    semCasar,
    emProcessamento,
    liquidadas,
    acoesAbertas,
    deadLetters,
    updates24h: volume.last24h,
    updatesMediaDia: volume.dailyAverage,
    updatesCobrados,
    canaisMudos,
    latenciaP50Min: tempo?.p50Min ?? null,
    latenciaP95Min,
    // Dia sem nenhum update não é dia tranquilo: é o Telegram sem entregar,
    // e as contas de captura acima ficam todas em zero sem motivo aparente.
    saudavel:
      pctCasamento >= CASAMENTO_ALVO_PCT &&
      pctCasamento7d >= CASAMENTO_ALVO_PCT &&
      deadLetters === 0 &&
      acoesAbertas === 0 &&
      (!updatesCobrados || volume.last24h > 0) &&
      canaisMudos.length === 0 &&
      (latenciaP95Min === null || latenciaP95Min <= LATENCIA_ALVO_MIN),
  };
}

export function formatarHealthDigest(d: HealthDigest, now = new Date()): string {
  const cabecalho = d.updatesCobrados && d.updates24h === 0
    ? "⚠️ Nenhum post chegou do Telegram em 24 h"
    : d.saudavel ? "✅ Captura saudável" : "⚠️ Captura precisa de atenção";
  const taxa = d.capturadas === 0 && d.casadas === 0
    ? "sem apostas novas nas últimas 24h"
    : `${d.casadas} de ${d.casadas + d.semCasar} achadas na Pinnacle (${d.pctCasamento.toFixed(0)}%`
      + ` · 7 dias ${d.pctCasamento7d.toFixed(0)}% · alvo ${CASAMENTO_ALVO_PCT}%)`;

  const linhas = [
    `${cabecalho} · ${spDayKey(now)}`,
    `📡 ${d.updates24h} update(s) dos canais em 24 h` +
      (d.updatesMediaDia ? ` · média de ${Math.round(d.updatesMediaDia)}/dia na semana` : ""),
    `📥 ${d.capturadas} aposta(s) capturada(s) · ${taxa}`,
    `⚖️ ${d.liquidadas} aposta(s) liquidada(s)`,
  ];
  if (d.latenciaP50Min !== null && d.latenciaP95Min !== null) {
    linhas.push(`⏱️ Do post à captura: ${formatDurationMinutes(d.latenciaP50Min)} na mediana, ${formatDurationMinutes(d.latenciaP95Min)} no p95 (alvo ${LATENCIA_ALVO_MIN} min)`);
  }
  if (d.canaisMudos.length > 0) linhas.push(`🔇 Canal(is) calado(s) além do ritmo: ${d.canaisMudos.join(", ")}`);
  if (d.emProcessamento > 0) linhas.push(`⏳ ${d.emProcessamento} ainda em processamento`);
  if (d.semCasar > 0) linhas.push(`❓ ${d.semCasar} não achada(s) na Pinnacle: ficam sem CLV`);
  if (d.deadLetters > 0) linhas.push(`🔴 ${d.deadLetters} tarefa(s) travada(s) depois de esgotar as tentativas: reprocesse ou descarte em Monitoramento`);
  if (d.acoesAbertas > 0) linhas.push(`📋 ${d.acoesAbertas} ação(ões) da captura esperando você em Monitoramento`);
  return truncatePendingDigestMessage(linhas.join("\n"), DIGEST_MAX_CHARS, "Monitoramento");
}

export async function sendHealthDigest(now = new Date()): Promise<HealthDigest> {
  const digest = await coletarHealthDigest(now);
  const delivery = await sendRequiredOperatorNotification(formatarHealthDigest(digest, now), {
    key: `health-digest:${spDayKey(now)}`, forMs: DAILY_NOTIFICATION_DEDUPE_MS,
  });
  log.info({ ...digest, delivery }, "digest diário de saúde entregue");
  return digest;
}
