import { cronMaxGapMinutes } from "@/src/domain/cron-cadence";
import { SCHEDULE_MANIFEST } from "@/src/jobs/schedules";

/** Cadência declarada de uma fila — lança se ela não está no manifesto. */
export function cadenciaDaFila(queue: string): number {
  const definicao = SCHEDULE_MANIFEST.find((s) => s.queue === queue);
  if (!definicao) throw new Error(`fila sem agendamento no manifesto: ${queue}`);
  return cronMaxGapMinutes(definicao.cron);
}
