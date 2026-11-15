import { formatSpDateTime, shiftDayKey, spDayKey } from "@/src/domain/dates";
import { rotuloStatus } from "@/src/domain/mensagem-operador";
import { OperationalRisk, type Prisma } from "@/src/generated/prisma/client";
import { createLogger } from "@/src/infra/logger";
import { recordOperationalMetric } from "@/src/infra/operational-metrics";
import { prisma } from "@/src/infra/prisma";
import { deferFlashscoreWork } from "@/src/providers/flashscore/breaker-gate";
import { getFlashscoreCatalog } from "@/src/providers/flashscore/catalog";
import { flashscoreConfigured, listFlashscoreMatchesByDate } from "@/src/providers/flashscore/client";
import { flashscoreSportId } from "@/src/providers/flashscore/sports";
import { chavePlacar } from "@/src/providers/flashscore/terminal";
import type { FlashscoreCatalogMatch } from "@/src/providers/flashscore/types";
import { notifyPersistedOperationalAlert, persistOperationalAlert } from "@/src/services/ops/alerts";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import { jsonObject } from "./observation-store";
import { isFlashscoreRequestRefused, OUTCOMES_INFERIDOS } from "./settle";

/**
 * Rechecagem pós-liquidação das apostas decididas por INFERÊNCIA. Nos esportes
 * sem flag terminal o fim do jogo é dedução nossa (ver
 * `providers/flashscore/terminal.ts`): se o portão abriu no intervalo de um
 * jogo atrasado, liquidamos um placar parcial e o dinheiro sai invertido.
 *
 * Olha de novo bem depois: placar mudado vira alerta no Telegram e ação
 * operacional que NÃO se auto-resolve. Reverter é decisão do dono, pelo botão
 * "Pendente" da ficha (`settleManualFromView({ newStatus: "PENDING" })`).
 */

/**
 * Só reconsulta depois de seis horas, o portão mais longo que ainda é plausível
 * terminar no mesmo dia (críquete usa 12h e cai na passada seguinte). Depois de
 * quinze dias a aposta já passou pela conferência do dono — reabrir é ruído.
 */
const IDADE_MINIMA_MS = 6 * 3_600_000;
const IDADE_MAXIMA_MS = 15 * 86_400_000;
const LOTE_MAXIMO = 200;

type RecheckPendente = {
  betId: string;
  evento: string;
  esporte: string;
  selecao: string;
  status: string;
  data: Date;
  matchId: string;
  placarLiquidado: string | null;
  /** Múltipla: o placar de cada confronto, pelo `match_id`. */
  placares: unknown;
  liquidadaEm: Date;
  version: number;
  snapshot: Prisma.JsonValue;
};

type RecheckVeredito =
  | { resultado: "confere"; placar: string }
  | { resultado: "divergente"; placarAgora: string | null }
  | { resultado: "partida_ausente" }
  | { resultado: "sem_base" };

export type FlashscoreRecheckRun = {
  conferidas: number;
  divergentes: number;
  ausentes: number;
  semBase: number;
  falhas: number;
  semProvider: number;
  obsolete: number;
};

/**
 * Os desfechos SOMAM `pendentes.length`, sempre. `jsonb_exists(..., 'recheck')`
 * tira da fila a aposta já conferida; fica em SQL cru porque "chave AUSENTE no
 * jsonb" não tem expressão no filtro de JSON do Prisma.
 */
async function listarRecheckPendentes(now: Date): Promise<RecheckPendente[]> {
  const desde = new Date(now.getTime() - IDADE_MAXIMA_MS);
  const ate = new Date(now.getTime() - IDADE_MINIMA_MS);
  return prisma.$queryRaw<RecheckPendente[]>`
    SELECT r."betId" AS "betId", b."evento" AS "evento", b."esporte" AS "esporte",
      b."selecao" AS "selecao", b."status"::text AS "status", b."data" AS "data",
      r."resultMatchId" AS "matchId", r."resultSnapshot"->>'placar' AS "placarLiquidado",
      r."resultSnapshot"->'placares' AS "placares", r."resultCheckedAt" AS "liquidadaEm",
      b."manualSettlementVersion" AS version, r."resultSnapshot" AS snapshot
    FROM "bet_result" r JOIN "bets" b ON b."id" = r."betId"
    WHERE r."resultProvider" = 'flashscore' AND r."resultMatchId" IS NOT NULL
      AND r."resultCheckedAt" BETWEEN ${desde} AND ${ate}
      AND r."resultSnapshot"->>'settlementOutcome' = ANY(${[...OUTCOMES_INFERIDOS]}::text[])
      AND NOT jsonb_exists(r."resultSnapshot", 'recheck') AND b."deletedAt" IS NULL
    ORDER BY r."resultCheckedAt" ASC LIMIT ${LOTE_MAXIMO}
  `;
}

const log = createLogger("flashscore-recheck");

/**
 * Grava a marca sem read-modify-write: `jsonb_set` no próprio UPDATE evita que
 * duas passadas concorrentes sobrescrevam o snapshot uma da outra.
 */
async function marcarConferida(item: RecheckPendente, veredito: RecheckVeredito, em: Date): Promise<boolean> {
  const marca = JSON.stringify({ ...veredito, em: em.toISOString() });
  const updated = await prisma.$executeRaw`
    UPDATE bet_result AS result
    SET "resultSnapshot" = jsonb_set(result."resultSnapshot", '{recheck}', ${marca}::jsonb, true), "updatedAt" = now()
    FROM bets AS bet
    WHERE result."betId" = ${item.betId} AND bet.id = result."betId"
      AND bet."deletedAt" IS NULL AND bet."manualSettlementVersion" = ${item.version}
      AND result."resultProvider" = 'flashscore' AND result."resultMatchId" = ${item.matchId}
      AND result."resultCheckedAt" = ${item.liquidadaEm}
      AND result."resultSnapshot" = ${JSON.stringify(item.snapshot)}::jsonb
  `;
  return updated === 1;
}

/**
 * Procura a partida pelo id já conhecido. Varre o dia da aposta e os vizinhos
 * pelo mesmo motivo do casamento original: o fornecedor publica pelo fuso dele,
 * e jogo perto da meia-noite troca de dia.
 */
async function acharPartida(
  matchId: string,
  sportId: number,
  dia: string,
): Promise<FlashscoreCatalogMatch | null | undefined> {
  let incomplete = false;
  for (const desloc of [0, -1, 1]) {
    const catalogo = await getFlashscoreCatalog(shiftDayKey(dia, desloc), sportId, {
      fetch: listFlashscoreMatchesByDate,
    });
    if (!catalogo) {
      incomplete = true;
      continue;
    }
    const achada = catalogo.find((item) => item.match_id === matchId);
    if (achada) return achada;
  }
  // Ausência exige consultar a janela inteira: o jogo pode estar no único
  // dia indisponível. Consulta incompleta continua na fila da próxima rodada.
  return incomplete ? undefined : null;
}

/**
 * Os placares deduzidos que decidiram o dinheiro: o do jogo, ou o de cada jogo
 * da múltipla cujo fim foi deduzido (o que ainda rolava quando outra perna
 * decidiu fica de fora).
 */
function inferredSettledScores(item: RecheckPendente): Array<{ matchId: string; placar: string }> | null {
  const byMatch = jsonObject(item.placares);
  if (byMatch) {
    const inferred = Object.entries(byMatch).flatMap(([matchId, stored]) => {
      const reading = jsonObject(stored);
      return reading?.inferido === true && typeof reading.placar === "string" ? [{ matchId, placar: reading.placar }] : [];
    });
    return inferred.length > 0 ? inferred : null;
  }
  return item.placarLiquidado === null ? null : [{ matchId: item.matchId, placar: item.placarLiquidado }];
}

function joinScores(scores: ReadonlyArray<string | null>): string | null {
  return scores.length === 1 ? scores[0]! : scores.map((score) => score ?? "sem placar").join(" · ");
}

function textoDoAlerta(item: RecheckPendente, placarLiquidado: string | null, placarAgora: string | null): string {
  const quando = formatSpDateTime(item.liquidadaEm);
  const agora = placarAgora ?? "sem placar";
  return (
    `🔁 Placar mudou depois da liquidação · ${item.evento} (${item.esporte})\n` +
    `${item.selecao}: está como ${rotuloStatus(item.status)}\n` +
    `Liquidada com ${placarLiquidado ?? "?"} (lido em ${quando}); agora: ${agora}\n` +
    "O jogo provavelmente ainda não tinha acabado.\n" +
    '👉 Confira na casa e, se preciso, volte a aposta para "Pendente": o saldo é desfeito e ela liquida de novo.'
  );
}

/**
 * Uma passada de rechecagem. Isolada por aposta: uma falha não aborta o lote,
 * e só o fracasso TOTAL vira exceção — aí o problema é o provider, não a aposta.
 */
export async function runFlashscoreRecheckOnce(
  now = new Date(),
): Promise<FlashscoreRecheckRun> {
  const run: FlashscoreRecheckRun = {
    conferidas: 0,
    divergentes: 0,
    ausentes: 0,
    semBase: 0,
    falhas: 0,
    semProvider: 0,
    obsolete: 0,
  };
  if (!flashscoreConfigured()) return run;
  // Circuito aberto: lista e varre depois — a marca `recheck` mantém a fila.
  if (await deferFlashscoreWork("recheck")) return run;

  const pendentes = await listarRecheckPendentes(now);
  if (pendentes.length === 0) return run;

  for (const item of pendentes) {
    try {
      const sportId = flashscoreSportId(item.esporte);
      const settledScores = inferredSettledScores(item);
      if (sportId === null || settledScores === null) {
        // Não deveria acontecer: `_inferido` só existe com esporte mapeado e
        // placar presente. Marca para não represar a fila, e o log fica.
        log.warn({ betId: item.betId, esporte: item.esporte }, "rechecagem sem base comparável");
        if (await marcarConferida(item, { resultado: "sem_base" }, now)) run.semBase += 1;
        else run.obsolete += 1;
        continue;
      }

      // Cada confronto pelo próprio `match_id` (a múltipla tem vários); sem o
      // catálogo de um deles, a passada seguinte tenta a aposta inteira.
      const matches: Array<FlashscoreCatalogMatch | null> = [];
      for (const { matchId } of settledScores) {
        const match = await acharPartida(matchId, sportId, spDayKey(item.data));
        if (match === undefined) break;
        matches.push(match);
      }
      if (matches.length < settledScores.length) {
        run.semProvider += 1;
        continue;
      }
      const currentScores = matches.map((match) => (match ? chavePlacar(match) : null));
      const changed = settledScores.some((settled, index) =>
        matches[index] !== null && currentScores[index] !== settled.placar);
      if (!changed && matches.some((match) => match === null)) {
        if (await marcarConferida(item, { resultado: "partida_ausente" }, now)) run.ausentes += 1;
        else run.obsolete += 1;
        continue;
      }
      const placarLiquidado = joinScores(settledScores.map((settled) => settled.placar));
      const placarAgora = joinScores(currentScores);
      if (!changed) {
        if (await marcarConferida(item, { resultado: "confere", placar: placarLiquidado! }, now)) run.conferidas += 1;
        else run.obsolete += 1;
        continue;
      }

      // Placar diferente OU placar que sumiu: nos dois casos a leitura que
      // decidiu o dinheiro não era estável. Quem reverte é o dono.
      //
      // ALERTA ANTES DA MARCA: a marca `recheck` tira a aposta da fila de vez,
      // então com o Telegram fora do ar a divergência se perderia. Nesta ordem
      // o pior caso é o alerta repetir amanhã, e `sendOperationalAlert`
      // deduplica pela `key` (o `betId`).
      const message = textoDoAlerta(item, placarLiquidado, placarAgora);
      const context = {
        source: "settlement.flashscore-recheck",
        key: item.betId,
        title: `Liquidação por inferência divergente: ${item.evento}`,
        risk: OperationalRisk.HIGH,
        resource: "bet",
        resourceId: item.betId,
        evidence: {
          esporte: item.esporte,
          selecao: item.selecao,
          statusAtual: item.status,
          placarLiquidado,
          placarAgora,
          liquidadaEm: item.liquidadaEm.toISOString(),
        },
        autoResolve: false,
      };
      // A ação pertence à evidência lida, não só ao id da aposta. Trava a
      // aposta antes de reler: edição e nova liquidação não recebem alerta antigo.
      const persisted = await runSerializableTransaction("flashscore.recheck-alert", async (tx) => {
        const current = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT bet.id FROM bets AS bet JOIN bet_result AS result ON result."betId" = bet.id
          WHERE bet.id = ${item.betId} AND bet."deletedAt" IS NULL
            AND bet."manualSettlementVersion" = ${item.version}
            AND result."resultProvider" = 'flashscore' AND result."resultMatchId" = ${item.matchId}
            AND result."resultCheckedAt" = ${item.liquidadaEm}
            AND result."resultSnapshot" = ${JSON.stringify(item.snapshot)}::jsonb
          FOR UPDATE OF bet, result
        `;
        if (current.length === 0) return false;
        await persistOperationalAlert(message, context, { client: tx });
        return true;
      });
      if (!persisted) {
        run.obsolete += 1;
        continue;
      }
      await notifyPersistedOperationalAlert(message, context);
      if (await marcarConferida(item, { resultado: "divergente", placarAgora }, now)) run.divergentes += 1;
      else run.obsolete += 1;
    } catch (error) {
      // Indisponibilidade do fornecedor não é falha desta aposta. `acharPartida`
      // já converte cota esgotada em `undefined`, mas breaker aberto e recusa do
      // provider sobem como exceção e não podem contar como `falhas`.
      if (isFlashscoreRequestRefused(error)) {
        run.semProvider += 1;
        log.warn(
          { err: error, betId: item.betId },
          "rechecagem sem provider disponível; a próxima passada continua",
        );
        continue;
      }
      run.falhas += 1;
      log.error({ err: error, betId: item.betId }, "falha ao reconferir liquidação; lote segue");
    }
  }

  // O que ainda estoura alto é erro NOSSO — bug de código, banco fora. Cota
  // esgotada e breaker aberto saem por `semProvider` e a passada encerra limpa:
  // este job roda uma vez por dia, a marca `recheck` o torna idempotente, e a
  // passada de amanhã continua de onde parou, sem levar indisponibilidade ao
  // dead-letter.
  const tudoFalhou = run.falhas > 0 && run.falhas === pendentes.length;

  await recordOperationalMetric({
    kind: "action",
    name: "flashscore.recheck",
    outcome: tudoFalhou ? "error" : "success",
    labels: {
      conferidas: run.conferidas,
      divergentes: run.divergentes,
      ausentes: run.ausentes,
      semBase: run.semBase,
      falhas: run.falhas,
      semProvider: run.semProvider,
      obsolete: run.obsolete,
    },
  });
  log.info(run, "rechecagem de liquidações por inferência concluída");

  if (run.semProvider > 0) {
    log.warn(
      { semProvider: run.semProvider, pendentes: pendentes.length },
      "rechecagem sem cota/provider neste ciclo; a próxima passada continua",
    );
  }

  // Fail-loud para o pg-boss reter e realertar.
  if (tudoFalhou) {
    throw new Error(
      `Rechecagem por inferência falhou em ${pendentes.length} de ${pendentes.length} aposta(s) — ` +
        "erro nosso, não indisponibilidade do FlashScore; ver o log por betId.",
    );
  }
  return run;
}
