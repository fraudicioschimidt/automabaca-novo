import { isBreakerOpen } from "@/src/infra/circuit-breaker";
import { createLogger } from "@/src/infra/logger";
import { LOG_EVENTS } from "@/src/infra/log-events";

const log = createLogger("flashscore-gate");

/** Qual trabalho está adiando: o rótulo diz o que parou, não só que parou. */
export type FlashscoreDeferralScope = "settlement" | "recheck" | "enrich";

/**
 * Circuito aberto = trabalho ADIADO, não chamada tentada. Sem este gate, cada
 * consumidor (settle, enrich, rechecagem) insistiria por conta própria,
 * e as recusas registradas superariam em muito os timeouts reais do fornecedor.
 *
 * É UMA leitura no topo do trabalho: quem chama sai cedo, o circuito se cura no
 * cooldown e o próximo ciclo repesca (tudo aqui é idempotente). Não lança de
 * propósito — `throw` queima o `retryLimit` da fila e manda um
 * `CircuitOpenError` para a DLQ, que o reprograma para 2 h depois.
 */
export async function deferFlashscoreWork(
  scope: FlashscoreDeferralScope,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  if (!(await isBreakerOpen("flashscore"))) return false;
  log.warn({
    eventCode: LOG_EVENTS.PROVIDER_CIRCUIT_BLOCKED,
    provider: "flashscore",
    scope,
    ...extra,
    actionableHint:
      "Circuit breaker FlashScore aberto. Trabalho adiado ao próximo ciclo após o cooldown.",
  }, "breaker FlashScore aberto; trabalho adiado sem consultar o provider");
  return true;
}
