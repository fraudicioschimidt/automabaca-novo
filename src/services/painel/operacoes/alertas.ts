import "server-only";
import { fonteDeFrescor, frescorDaFonte } from "@/src/domain/frescor";
import { createLogger } from "@/src/infra/logger";
import { countCasosAbertos, getMatchingOverlap } from "./filas";
import { getSaudeMotor, workerVivo, type SaudeMotor } from "./saude";
import { countActiveDeadLetters } from "@/src/services/ops/dlq/pgboss-queues";

const log = createLogger("operacoes");

export type Alerta = { id: string; kind: "warn" | "info" | "ok"; title: string; desc: string };

/** Alertas operacionais resumidos para o sino do dashboard (sinais reais). */
export async function getAlertas(saudeInformada?: SaudeMotor, now: Date = new Date()): Promise<Alerta[]> {
  const saude = saudeInformada ?? await getSaudeMotor();
  const out: Alerta[] = [];

  if (!workerVivo(saude, now)) {
    // A idade sai de `domain/frescor`, a mesma redação das outras telas.
    const motor = frescorDaFonte(fonteDeFrescor("motor"), saude.ultimoHeartbeat, now);
    out.push({
      id: "worker",
      kind: "warn",
      title: "Worker parado",
      desc:
        motor.idadeMin == null
          ? "Sem heartbeat recente — verificar o container do worker"
          : `Último heartbeat ${motor.texto}`,
    });
  }

  if (saude.dbOk) {
    const [dlq, treino, sharp] = await Promise.all([
      // Dead-letter ativa não expira por idade: enquanto o job continua preso,
      // ainda existe trabalho replayável e o sino não pode dizer “Tudo em ordem”.
      countActiveDeadLetters().catch((err) => {
        log.error({ mod: "operacoes-alertas", err }, "falha ao contar dead-letters (pgboss)");
        return null;
      }),
      countCasosAbertos(now),
      getMatchingOverlap(now),
    ]);
    // A que aguarda a Pinnacle listar o revival resolve sozinho: o sino conta
    // só a sem par que não está em Vincular, a mesma da aba Sharp.
    const semPar = Math.max(0, sharp.semMatchTotal - sharp.sobrepostos);
    // DLQ ilegível (pgboss fora) não pode virar "0 falhas" calado.
    if (dlq === null) {
      out.push({
        id: "dlq",
        kind: "warn",
        title: "Falhas de job: leitura indisponível",
        desc: "Não foi possível ler a DLQ (pgboss) — verificar",
      });
    } else if (dlq > 0) {
      out.push({
        id: "dlq",
        kind: "warn",
        title: `${dlq} falha${dlq === 1 ? "" : "s"} de job`,
        desc: "Dead-letters aguardando replay em Monitoramento",
      });
    }
    if (treino > 0) {
      out.push({
        id: "treino",
        kind: "info",
        title: `${treino} jogo${treino === 1 ? "" : "s"} para vincular`,
        desc: "A busca automática não resolveu — escolha em Operações › Vincular",
      });
    }
    if (semPar > 0) {
      out.push({
        id: "sharp",
        kind: "info",
        title: `${semPar} aposta${semPar === 1 ? "" : "s"} sem par sharp`,
        desc: "A busca terminou sem o jogo — reprocesse em Operações › Sharp",
      });
    }
  } else {
    // Banco indisponível nunca cai no "Tudo em ordem" abaixo.
    out.push({
      id: "db",
      kind: "warn",
      title: "Banco indisponível",
      desc: "Não foi possível checar a saúde do motor — verificar Postgres/worker",
    });
  }

  if (out.length === 0) {
    out.push({
      id: "ok",
      kind: "ok",
      title: "Tudo em ordem",
      desc: saude.ultimoClosing ? "Motor saudável · closing recente" : "Motor saudável",
    });
  }
  return out;
}
