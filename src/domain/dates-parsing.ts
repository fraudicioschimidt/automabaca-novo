// A regra mora em Rust: chave de dia, componentes de São Paulo → UTC e os
// campos de data e hora do painel em `rust/crates/dominio/src/dates.rs`, e a
// leitura de data e hora no texto do post em `kickoff.rs`.
import dominio from "@automabaca/dominio";

export const SAO_PAULO_UTC_OFFSET_HOURS = 3;

export function assertValidDate(date: Date, caller: string): void {
  if (!Number.isFinite(date.getTime())) throw new RangeError(`${caller}: data inválida.`);
}

/** Instante UTC representado com getters UTC no relógio de São Paulo. */
export function utcToSpParts(date: Date): Date {
  assertValidDate(date, "utcToSpParts");
  return new Date(date.getTime() - SAO_PAULO_UTC_OFFSET_HOURS * 3_600_000);
}

/** Soma dias de calendario a uma chave YYYY-MM-DD sem reinterpretar fuso. */
export function shiftDayKey(dayKey: string, days: number): string {
  return dominio.shiftDayKey(dayKey, days);
}

/** Componentes de data/hora locais de São Paulo → instante UTC. */
export function spToUtc(parts: {
  year: number;
  month: number; // 1-12
  day: number;
  hour?: number;
  minute?: number;
}): Date {
  return new Date(dominio.spToUtc(parts.year, parts.month, parts.day, parts.hour ?? 0, parts.minute ?? 0));
}

/**
 * Campos HTML `date` + `time` no relógio de São Paulo → instante UTC.
 * Valida por round-trip porque `Date.UTC` aceita datas impossíveis por rollover
 * (por exemplo, 31/02 vira março silenciosamente).
 */
export function parseSpDateTimeInput(dateText: string, timeText: string): Date | null {
  const result = dominio.parseSpDateTimeInput(dateText, timeText);
  return result === null ? null : new Date(result);
}

/** Resultado do parse de kickoff: instante UTC + se a hora veio no texto. */
export type ParsedBrKickoff = {
  date: Date;
  /** true = só dia/mês(/ano); hora foi defaultada para 00:00 SP (provisória). */
  dateOnly: boolean;
};

/**
 * Texto logo antes de um número que faz dele a nota do tipster ("Confiança 5/5",
 * "⭐ 3"). O `parse-bet-post` ainda o usa em TypeScript; a leitura de data
 * (`kickoff.rs`) tem o mesmo padrão.
 */
export const RATING_BEFORE = /(?:confian[cç]a|nota|rating|n[ií]vel|estrelas?|⭐|🌟|★)[^\n\d]{0,12}$/i;

/**
 * Interpreta "dd/mm hh:mm" (e variações com ano, ponto como separador, ISO,
 * mês em inglês e dia relativo com hora) como horário de São Paulo. Sem ano:
 * assume o que deixar a data mais próxima de `ref` no FUTURO (kickoffs são
 * futuros), tolerando até 30 dias no passado (post atrasado). Null quando não
 * há data reconhecível. A regra mora em Rust (`rust/crates/dominio/src/kickoff.rs`).
 *
 * `dateOnly` distingue "15/06" (hora inventada) de "15/06 16:00" (hora do tipster)
 * — base do flag `Bet.kickoffInferido`.
 */
export function parseBrKickoffDetailed(
  text: string,
  ref: Date = new Date(),
): ParsedBrKickoff | null {
  let parsed: [number, boolean] | null;
  try {
    parsed = dominio.parseBrKickoff(text, ref.getTime());
  } catch (error) {
    // Referência inválida, quando o texto precisa dela: o `utcToSpParts` lançava RangeError.
    if (error instanceof Error && error.message === "utcToSpParts: data inválida.") throw new RangeError(error.message);
    throw error;
  }
  return parsed === null ? null : { date: new Date(parsed[0]), dateOnly: parsed[1] };
}
