// A regra mora em Rust (`rust/crates/dominio/src/cron.rs`), pela ponte N-API.
// Este arquivo só converte `Date` em milissegundos e de volta.
import dominio from "@automabaca/dominio";

/**
 * Cadência de um cron de cinco campos: o MAIOR intervalo, em minutos, entre
 * duas execuções seguidas ao longo da semana. É o pior caso que decide quando
 * um job agendado "parou de rodar", quanto tempo guardar os jobs concluídos e
 * a tolerância de frescor da tela.
 *
 * Só entende o que o manifesto usa: minuto, hora e dia da semana (0 = domingo)
 * com `*`, número, lista, intervalo `a-b` e passo `/n`; dia do mês e mês têm
 * de ser `*`. Qualquer outra forma lança, em vez de devolver uma cadência
 * inventada.
 */
export function cronMaxGapMinutes(cron: string): number {
  return dominio.cronMaxGapMinutes(cron);
}

/**
 * Os minutos da semana (0 = domingo 00:00 no relógio do cron, até 10079) em
 * que o cron dispara, em ordem. Mesmo recorte de `cronMaxGapMinutes`.
 */
export function cronFiringMinutes(cron: string): number[] {
  return dominio.cronFiringMinutes(cron);
}

/**
 * O disparo mais recente do cron em (`after`, `until`], com os minutos do cron
 * lidos no relógio deslocado `utcOffsetHours` horas a oeste de UTC (3 para o
 * relógio de São Paulo do manifesto). `null` quando o intervalo não tem
 * disparo.
 */
export function latestCronFiring(cron: string, after: Date, until: Date, utcOffsetHours: number): Date | null {
  const firing = dominio.latestCronFiring(cron, after.getTime(), until.getTime(), utcOffsetHours);
  return firing === null ? null : new Date(firing);
}
