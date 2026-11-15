import { formatSpDateTime, spDayKey } from "@/src/domain/dates";
import { createLogger } from "@/src/infra/logger";
import { prisma } from "@/src/infra/prisma";
import { sendRequiredOperatorNotification } from "@/src/services/ops/alerts";
import { DAILY_NOTIFICATION_DEDUPE_MS, rotuloStatus } from "@/src/domain/mensagem-operador";
// Mesma trava de tamanho do digest de pendências: truncar mensagem de Telegram
// é um conceito só.
import { truncatePendingDigestMessage } from "@/src/services/ops/digests/pending-digest";
// Vocabulário de quem PRODUZ a marca, não de um consumidor irmão.
import { OUTCOMES_INFERIDOS, SETTLEMENT_OUTCOME_STATS_INFERIDO } from "@/src/services/settlement/flashscore/settle";

const log = createLogger("relatorio-inferencia");

/**
 * Resumo diário das apostas que o FlashScore liquidou por INFERÊNCIA.
 *
 * Nesses esportes o fim do jogo é dedução nossa, não afirmação do fornecedor;
 * a conferência do dono é a validação da regra, e ele só confere o que vê.
 *
 * **Dia sem inferência não manda nada**: alerta que chega todo dia deixa de ser
 * lido, e este precisa ser lido no dia em que trouxer uma divergência. O
 * silêncio é requisito testado.
 */

const JANELA_MS = 24 * 3_600_000;
const MAX_LINHAS = 15;

type LinhaLiquidada = {
  evento: string;
  esporte: string;
  selecao: string;
  status: string;
  placar: string | null;
  viaStats: boolean;
  kickoff: Date;
  decididaEm: Date;
};

type LinhaDivergente = {
  evento: string;
  esporte: string;
  status: string;
  placar: string | null;
  placarAgora: string | null;
};

export type RelatorioInferencia = {
  enviado: boolean;
  liquidadas: number;
  divergentes: number;
};

async function listarLiquidadas(desde: Date): Promise<LinhaLiquidada[]> {
  return prisma.$queryRaw<LinhaLiquidada[]>`
    SELECT
      b."evento"                     AS "evento",
      b."esporte"                    AS "esporte",
      b."selecao"                    AS "selecao",
      b."status"::text               AS "status",
      r."resultSnapshot"->>'placar'  AS "placar",
      (r."resultSnapshot"->>'settlementOutcome' = ${SETTLEMENT_OUTCOME_STATS_INFERIDO}) AS "viaStats",
      b."data"                       AS "kickoff",
      r."resultCheckedAt"            AS "decididaEm"
    FROM "bet_result" r
    JOIN "bets" b ON b."id" = r."betId"
    WHERE r."resultProvider" = 'flashscore'
      AND r."resultCheckedAt" >= ${desde}
      AND r."resultSnapshot"->>'settlementOutcome' = ANY(${[...OUTCOMES_INFERIDOS]}::text[])
      AND b."deletedAt" IS NULL
    ORDER BY r."resultCheckedAt" ASC
  `;
}

/**
 * Divergências que a rechecagem marcou na janela. A marca `recheck` é gravada
 * uma única vez por aposta, então a data dela é a data da descoberta.
 */
async function listarDivergentes(desde: Date): Promise<LinhaDivergente[]> {
  return prisma.$queryRaw<LinhaDivergente[]>`
    SELECT
      b."evento"                                       AS "evento",
      b."esporte"                                      AS "esporte",
      b."status"::text                                 AS "status",
      r."resultSnapshot"->>'placar'                    AS "placar",
      r."resultSnapshot"->'recheck'->>'placarAgora'    AS "placarAgora"
    FROM "bet_result" r
    JOIN "bets" b ON b."id" = r."betId"
    WHERE r."resultProvider" = 'flashscore'
      AND r."resultSnapshot"->'recheck'->>'resultado' = 'divergente'
      AND (r."resultSnapshot"->'recheck'->>'em')::timestamptz >= ${desde}
      AND b."deletedAt" IS NULL
    ORDER BY (r."resultSnapshot"->'recheck'->>'em') ASC
  `;
}

function montarMensagem(
  liquidadas: LinhaLiquidada[],
  divergentes: LinhaDivergente[],
): string {
  const partes: string[] = [];

  if (liquidadas.length > 0) {
    partes.push(
      `🧮 ${liquidadas.length} aposta(s) liquidada(s) por dedução nas últimas 24h\n` +
        "Nesses esportes o FlashScore não diz quando o jogo acaba; o sistema deduziu pelo placar. " +
        "Vale conferir na casa:",
    );
    for (const item of liquidadas.slice(0, MAX_LINHAS)) {
      const horas = Math.round((item.decididaEm.getTime() - item.kickoff.getTime()) / 3_600_000);
      const evidencia = item.viaStats ? "por estatística" : `placar ${item.placar ?? "?"}`;
      partes.push(
        `• ${item.evento} (${item.esporte}) — ${item.selecao}\n` +
          `  ${evidencia} → ${rotuloStatus(item.status)} · decidida ${horas}h após o início ` +
          `(${formatSpDateTime(item.decididaEm)})`,
      );
    }
    if (liquidadas.length > MAX_LINHAS) {
      partes.push(`… e mais ${liquidadas.length - MAX_LINHAS}.`);
    }
  }

  if (divergentes.length > 0) {
    partes.push(
      `\n⚠️ ${divergentes.length} aposta(s) com placar diferente na nova conferência\n` +
        "O placar mudou depois de a aposta ser liquidada:",
    );
    for (const item of divergentes.slice(0, MAX_LINHAS)) {
      partes.push(
        `• ${item.evento} (${item.esporte}): liquidou com ${item.placar ?? "?"}, ` +
          `agora está ${item.placarAgora ?? "sem placar"} (aposta como ${rotuloStatus(item.status)})`,
      );
    }
    if (divergentes.length > MAX_LINHAS) {
      partes.push(`… e mais ${divergentes.length - MAX_LINHAS}.`);
    }
    partes.push(
      '👉 Para desfazer, volte a aposta para "Pendente" na página do tipster: o saldo é ' +
        "desfeito e ela liquida de novo.",
    );
  }

  return partes.join("\n");
}

export async function sendRelatorioInferencia(
  now = new Date(),
): Promise<RelatorioInferencia> {
  const desde = new Date(now.getTime() - JANELA_MS);
  const [liquidadas, divergentes] = await Promise.all([
    listarLiquidadas(desde),
    listarDivergentes(desde),
  ]);

  if (liquidadas.length === 0 && divergentes.length === 0) {
    log.debug({ desde }, "dia sem liquidação por inferência — nenhuma mensagem enviada");
    return { enviado: false, liquidadas: 0, divergentes: 0 };
  }

  const delivery = await sendRequiredOperatorNotification(
    truncatePendingDigestMessage(montarMensagem(liquidadas, divergentes)),
    { key: `inference-report:${spDayKey(now)}`, forMs: DAILY_NOTIFICATION_DEDUPE_MS },
  );
  log.info(
    { liquidadas: liquidadas.length, divergentes: divergentes.length, delivery },
    "relatório de liquidações por inferência",
  );
  return { enviado: true, liquidadas: liquidadas.length, divergentes: divergentes.length };
}
