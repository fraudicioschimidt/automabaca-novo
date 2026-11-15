const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const WEEK_MS = WEEK_MINUTES * 60_000;
/** A época Unix caiu numa quinta: 04/01/1970, o primeiro domingo, abre as semanas do relógio. */
const FIRST_SUNDAY_MS = 3 * DAY_MINUTES * 60_000;

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
  const firings = cronFiringMinutes(cron);
  const first = firings[0];
  const last = firings[firings.length - 1];
  if (first === undefined || last === undefined) throw new Error(`cron que nunca dispara: "${cron}"`);
  // A volta da semana conta: de sábado 23:50 para domingo 00:05 são 15 minutos.
  let maxGap = WEEK_MINUTES - last + first;
  for (let index = 1; index < firings.length; index += 1) {
    maxGap = Math.max(maxGap, (firings[index] ?? 0) - (firings[index - 1] ?? 0));
  }
  return maxGap;
}

/**
 * Os minutos da semana (0 = domingo 00:00 no relógio do cron, até 10079) em
 * que o cron dispara, em ordem. Mesmo recorte de `cronMaxGapMinutes`.
 */
export function cronFiringMinutes(cron: string): number[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron sem cinco campos: "${cron}"`);
  const [minuteField, hourField, dayOfMonthField, monthField, weekdayField] = fields as [string, string, string, string, string];
  if (dayOfMonthField !== "*" || monthField !== "*") {
    throw new Error(`cron com dia do mês ou mês fora do suportado: "${cron}"`);
  }
  const minutes = expandCronField(minuteField, 0, 59, cron);
  const hours = expandCronField(hourField, 0, 23, cron);
  const weekdays = expandCronField(weekdayField, 0, 6, cron);
  return weekdays
    .flatMap((weekday) => hours.flatMap((hour) => minutes.map((minute) => weekday * DAY_MINUTES + hour * 60 + minute)))
    .sort((a, b) => a - b);
}

/**
 * O disparo mais recente do cron em (`after`, `until`], com os minutos do cron
 * lidos no relógio deslocado `utcOffsetHours` horas a oeste de UTC (3 para o
 * relógio de São Paulo do manifesto). `null` quando o intervalo não tem
 * disparo.
 */
export function latestCronFiring(cron: string, after: Date, until: Date, utcOffsetHours: number): Date | null {
  const minutes = cronFiringMinutes(cron);
  const offsetMs = utcOffsetHours * 3_600_000;
  const localAfter = after.getTime() - offsetMs;
  const localUntil = until.getTime() - offsetMs;
  const lastWeekStart = FIRST_SUNDAY_MS + Math.floor((localUntil - FIRST_SUNDAY_MS) / WEEK_MS) * WEEK_MS;
  for (let weekStart = lastWeekStart; weekStart + WEEK_MS > localAfter; weekStart -= WEEK_MS) {
    for (let index = minutes.length - 1; index >= 0; index -= 1) {
      const localFiring = weekStart + (minutes[index] ?? 0) * 60_000;
      if (localFiring <= localAfter) return null;
      if (localFiring <= localUntil) return new Date(localFiring + offsetMs);
    }
  }
  return null;
}

function expandCronField(field: string, min: number, max: number, cron: string): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`campo de cron fora do suportado: "${part}" em "${cron}"`);
    const [, range, startText, endText, stepText] = match;
    const start = range === "*" ? min : Number(startText);
    // `5/15` vale como `5-59/15`, como no cron do pg-boss.
    const end = range === "*" ? max : endText !== undefined ? Number(endText) : stepText ? max : start;
    const step = stepText ? Number(stepText) : 1;
    if (start < min || end > max || start > end || step < 1) {
      throw new Error(`campo de cron fora dos limites: "${part}" em "${cron}"`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values];
}
