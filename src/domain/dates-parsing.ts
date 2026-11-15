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
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match || !Number.isInteger(days)) throw new Error(`Chave de dia invalida: ${dayKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const source = new Date(Date.UTC(year, month - 1, day));
  if (
    source.getUTCFullYear() !== year ||
    source.getUTCMonth() !== month - 1 ||
    source.getUTCDate() !== day
  ) {
    throw new Error(`Chave de dia invalida: ${dayKey}`);
  }
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/** Componentes de data/hora locais de São Paulo → instante UTC. */
export function spToUtc(parts: {
  year: number;
  month: number; // 1-12
  day: number;
  hour?: number;
  minute?: number;
}): Date {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      (parts.hour ?? 0) + SAO_PAULO_UTC_OFFSET_HOURS,
      parts.minute ?? 0,
    ),
  );
}

/**
 * Campos HTML `date` + `time` no relógio de São Paulo → instante UTC.
 * Valida por round-trip porque `Date.UTC` aceita datas impossíveis por rollover
 * (por exemplo, 31/02 vira março silenciosamente).
 */
export function parseSpDateTimeInput(dateText: string, timeText: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeText.trim());
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const result = spToUtc({ year, month, day, hour, minute });
  const roundTrip = utcToSpParts(result);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return result;
}

/** Resultado do parse de kickoff: instante UTC + se a hora veio no texto. */
export type ParsedBrKickoff = {
  date: Date;
  /** true = só dia/mês(/ano); hora foi defaultada para 00:00 SP (provisória). */
  dateOnly: boolean;
};

/** Texto logo antes de um número que faz dele a nota do tipster ("Confiança 5/5", "⭐ 3"). */
export const RATING_BEFORE = /(?:confian[cç]a|nota|rating|n[ií]vel|estrelas?|⭐|🌟|★)[^\n\d]{0,12}$/i;

/** Palavras que podem vir entre a data e a hora: "às", "horário" e o dia da semana. */
const DATE_TIME_FILLER = String.raw`(?<!\p{L})(?:[aà]s?|hor[aá](?:rio)?|dom(?:ingo)?|seg(?:unda)?|ter(?:[cç]a)?|qua(?:rta)?|qui(?:nta)?|sex(?:ta)?|s[aá]b(?:ado)?)(?:-feira)?(?!\p{L})`;

/**
 * Hora escrita na MESMA linha logo depois da data, com separador, emoji ou
 * sufixo que o padrão da data não aceita ("27/09 | 16:00", "📅 27/09 ⏰ 16:00",
 * "27/09 16:00hs", "16h30min"). Até a hora, no máximo 16 caracteres, sem
 * dígito nem "@", e só separador, emoji ou `DATE_TIME_FILLER`: a odd ("27/09
 * @1.85"), a linha de um total ("Over 2.5 às 20h") e outro texto ("27/09 HT
 * 1h", "27/09 • Rodada 5h") não viram hora; letra colada depois ("2 horas")
 * também não. Vírgula ou ponto de pontuação depois ("16:00, Maracanã") não
 * impede; seguidos de dígito, sim.
 */
const TIME_LATER_ON_DATE_LINE = new RegExp(
  String.raw`^(?=[^\n\d@]{0,16}\d)(?:[^\p{L}\d@\n]|${DATE_TIME_FILLER})*?([01]?\d|2[0-4])(?::([0-5]\d)|h(?:([0-5]\d)|rs?|s)?)(?:[ \t]?(?:hs|hrs?|h|min))?(?![\p{L}\d:]|[.,]\d)`,
  "iu",
);

function timeLaterOnDateLine(text: string, dateEnd: number): { hour: number; minute: number } | null {
  const match = TIME_LATER_ON_DATE_LINE.exec(text.slice(dateEnd));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? match[3] ?? 0);
  // Hora impossível ("27/09 | 24:30") não é a do jogo, e a data continua valendo sem ela.
  return hour === 24 && minute !== 0 ? null : { hour, minute };
}

/** Rótulo de odd logo antes do número ("Odd 2.11 - 20h", "@2.11"): é o preço, não dia e mês. */
const ODD_LABEL_BEFORE = /(?:@|\b(?:odd?s?|cota(?:[cç][aã]o)?|pre[cç]o))\s*[:=\-]?\s*$/i;
/** Direção, handicap ou sinal colado antes de "N/N": linha de mercado ("Over 2/2.5", "Flamengo -1/1.5"). */
const LINE_BEFORE = /(?:\b(?:over|under|mais|menos|acima|abaixo|handicap|ah|eh|linha)(?:\s+de)?\s*|[+\-])$/i;
/** "2/7 da série", "1/3 da melhor de 5": o jogo da série, não a data. */
const SERIES_AFTER = /^\s*d[aeo]\s+(?:s[eé]rie|melhor)/i;

const WEEKDAYS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
/**
 * Dia relativo com hora na mesma linha: "hoje 21:30", "amanhã às 16h",
 * "sábado 16:00". Entre o dia e a hora só separador e "às": "Segunda Divisão
 * 16:00" não é segunda-feira.
 */
const RELATIVE_DAY_TIME = new RegExp(
  String.raw`(?<!\p{L})(hoje|amanh[ãa]|domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)(?:-feira)?(?!\p{L})[ \t,\-–|•]*(?:[àa]s[ \t]*)?([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)(?:[ \t]?(?:hs|hrs?|h))?(?![\p{L}\d:]|[.,]\d)`,
  "iu",
);

/** O dia relativo à data de referência, no calendário de São Paulo; o dia da semana é o próximo, contando o de hoje. */
function parseRelativeKickoff(text: string, ref: Date): ParsedBrKickoff | null {
  const match = RELATIVE_DAY_TIME.exec(text);
  if (!match?.[1]) return null;
  const today = utcToSpParts(ref);
  const word = match[1].toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const daysAhead = word === "hoje" ? 0 : word === "amanha" ? 1 : (WEEKDAYS.indexOf(word) - today.getUTCDay() + 7) % 7;
  return {
    date: spToUtc({
      year: today.getUTCFullYear(), month: today.getUTCMonth() + 1, day: today.getUTCDate() + daysAhead,
      hour: Number(match[2]), minute: Number(match[3] ?? match[4] ?? 0),
    }),
    dateOnly: false,
  };
}

/**
 * Interpreta "dd/mm hh:mm" (e variações com ano, ponto como separador) como
 * horário de São Paulo. Sem ano: assume o que deixar a data mais próxima de
 * `ref` no FUTURO (kickoffs são futuros), tolerando até 30 dias no passado
 * (post atrasado). Sem data escrita, vale o dia relativo com hora ("hoje
 * 21:30", "sábado 16:00"). Null quando não há data reconhecível.
 *
 * `dateOnly` distingue "15/06" (hora inventada) de "15/06 16:00" (hora do tipster)
 * — base do flag `Bet.kickoffInferido`.
 */
export function parseBrKickoffDetailed(
  text: string,
  ref: Date = new Date(),
): ParsedBrKickoff | null {
  // English sportsbook labels ("11 Sep 13:30") are source dates too. Convert
  // only named months; calendar validation, year inference and SP timezone
  // remain in the same numeric parser below.
  const englishMonths = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  text = text.replace(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\.?(?:\s*,?\s+(\d{4})\b)?/gi,
    (_, day: string, month: string, year?: string) => `${day}/${englishMonths.indexOf(month.slice(0, 3).toLowerCase()) + 1}${year ? `/${year}` : ""}`);
  // Timestamp ISO que DECLARA fuso e um instante absoluto não pode passar pela
  // semântica local de São Paulo logo abaixo. APIs normalmente entregam `Z`
  // ou offset explícito; reinterpretar 16:00Z como 16:00 SP deslocava o
  // kickoff três horas para frente.
  const zonedIsoRe = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))\b/gi;
  for (const match of text.matchAll(zonedIsoRe)) {
    const timestamp = match[1] ?? "";
    const calendarDay = timestamp.slice(0, 10);
    const sourceDay = new Date(`${calendarDay}T00:00:00Z`);
    const parsed = new Date(timestamp);
    // Date aceita 31/02 por rollover mesmo num ISO com fuso. O dia escrito
    // precisa existir antes de o offset deslocar o instante para outro dia.
    if (Number.isFinite(sourceDay.getTime()) && sourceDay.toISOString().slice(0, 10) === calendarDay &&
      Number.isFinite(parsed.getTime())) {
      return { date: parsed, dateOnly: false };
    }
  }

  // ISO explícito precisa ser lido ANTES de DD/MM. Sem isto, o parser genérico
  // encontraria o sufixo de "2026/08/02" como 08/02 sem ano e o rolaria para o
  // próximo ano. Aceita barra ou hífen, com a mesma semântica SP/24:00 do BR.
  const isoRe = /\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[T \t]+(?:às[ \t]*)?(\d{1,2})(?:(?:[:h](\d{2}))|h\b))?\b/gi;
  for (const match of text.matchAll(isoRe)) {
    // Se parece um timestamp com fuso mas o parser absoluto acima o rejeitou,
    // não aceite silenciosamente só o prefixo como horário SP.
    const matchEnd = (match.index ?? 0) + match[0].length;
    const suffix = text.slice(matchEnd);
    if (/^(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/i.test(suffix)) continue;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const later = match[4] === undefined ? timeLaterOnDateLine(text, matchEnd) : null;
    const hasTime = match[4] !== undefined || later !== null;
    const hour = later?.hour ?? (hasTime ? Number(match[4]) : 0);
    const minute = later?.minute ?? (match[5] !== undefined ? Number(match[5]) : 0);
    const rollsToNextDay = hour === 24 && minute === 0;
    if (
      month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 24 || (hour === 24 && minute !== 0) || minute > 59
    ) continue;

    const sourceDay = new Date(Date.UTC(year, month - 1, day));
    if (
      sourceDay.getUTCFullYear() !== year ||
      sourceDay.getUTCMonth() !== month - 1 ||
      sourceDay.getUTCDate() !== day
    ) continue;
    if (rollsToNextDay) sourceDay.setUTCDate(sourceDay.getUTCDate() + 1);
    const targetYear = sourceDay.getUTCFullYear();
    const targetMonth = sourceDay.getUTCMonth() + 1;
    const targetDay = sourceDay.getUTCDate();
    const targetHour = rollsToNextDay ? 0 : hour;
    const result = spToUtc({
      year: targetYear,
      month: targetMonth,
      day: targetDay,
      hour: targetHour,
      minute,
    });
    const sp = utcToSpParts(result);
    if (
      sp.getUTCFullYear() === targetYear &&
      sp.getUTCMonth() === targetMonth - 1 &&
      sp.getUTCDate() === targetDay &&
      sp.getUTCHours() === targetHour &&
      sp.getUTCMinutes() === minute
    ) {
      return { date: result, dateOnly: !hasTime };
    }
  }

  // Varre TODAS as ocorrências e devolve a PRIMEIRA data válida — não a primeira
  // que casa o regex. Crucial p/ posts sem rótulo "Data:": uma linha de total/
  // handicap ("Over 2.5", "AH -1.5") casa o padrão dd.mm e viraria kickoff
  // (2.5 → 2/mai). Um token com PONTO sem hora e sem ano é tratado como total e
  // PULADO; se houver uma data real depois no post ("18/06 16:00"), ela é
  // encontrada.
  // Data e hora só se juntam na MESMA linha: "Over 2.5\n20h" não é 2/mai às
  // 20h. Por isso o separador é espaço horizontal, nunca a quebra.
  const re =
    /(?<!\d[/.])\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?:[ \t]*[-–—,]?[ \t]*(?:às[ \t]*)?(\d{1,2})(?:(?:[:h](\d{2}))|h\b))?\b/gi;
  for (const match of text.matchAll(re)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isFinite(day) || !Number.isFinite(month)) continue;
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;

    const hasYear = match[3] !== undefined;
    const hasTime = match[4] !== undefined;
    // "2.5"/"1.5" (separador PONTO, sem hora e sem ano) é linha de total/handicap,
    // não data. Datas com "/" ou acompanhadas de hora/ano seguem aceitas.
    if (!match[0].includes("/") && !hasTime && !hasYear) continue;
    const before = text.slice(0, match.index ?? 0);
    if (ODD_LABEL_BEFORE.test(before)) continue;
    // Com barra e sem ano, a linha dividida ("2/2.5"), a linha depois de
    // direção ou sinal e o jogo da série não são dia e mês.
    const after = text.slice((match.index ?? 0) + match[0].length);
    if (match[0].includes("/") && !hasYear &&
      (LINE_BEFORE.test(before) || /^[.,]\d/.test(after) || SERIES_AFTER.test(after))) continue;
    // Com ponto e sem ano, "N.5" ou número depois de direção/sinal é a linha
    // de um total colada à hora ("Over 2.5 às 20h", "Under 1.5 16:00"). As
    // linhas terminam em .5; "24.9 20h" continua sendo data.
    if (!match[0].includes("/") && !hasYear &&
      (match[2] === "5" || /(?:over|under|mais|menos|acima|abaixo|[+\-@])\s*$/i.test(before))) continue;
    // "Confiança 5/5", "⭐ 3/5": nota do tipster, não dia/mês.
    if (!hasYear && !hasTime && RATING_BEFORE.test(before)) continue;

    const later = hasTime ? null : timeLaterOnDateLine(text, (match.index ?? 0) + match[0].length);
    const hour = later?.hour ?? (hasTime ? Number(match[4]) : 0);
    const minute = later?.minute ?? (match[5] !== undefined ? Number(match[5]) : 0);
    const rollsToNextDay = hour === 24 && minute === 0;
    if (hour > 24 || (hour === 24 && minute !== 0) || minute > 59) continue;

    let years: number[];
    if (hasYear) {
      const rawYear = Number(match[3]);
      years = [rawYear < 100 ? 2000 + rawYear : rawYear];
    } else {
      // Ano do calendário de SP em `ref` — NÃO o UTC. Na virada de ano, ref em UTC já
      // pode estar no ano seguinte enquanto SP (UTC-3) ainda está no ano anterior; usar
      // o ano UTC jogaria o kickoff um ano à frente.
      //
      // `currentYear - 1` PRIMEIRO: em janeiro, "31/12" de um post atrasado é o
      // dezembro que acabou de passar — sem o candidato, caía em 31/12 do ANO
      // SEGUINTE (~1 ano à frente, kickoffInferido=false) e a aposta nunca
      // entraria em closing/settlement. Fora da virada o
      // candidato ano-1 é rejeitado pela tolerância de 30 dias logo abaixo.
      const currentYear = utcToSpParts(ref).getUTCFullYear();
      years = [currentYear - 1, currentYear, currentYear + 1];
    }

    const THIRTY_DAYS_MS = 30 * 86_400_000;
    for (const year of years) {
      const sourceDay = new Date(Date.UTC(year, month - 1, day));
      if (
        sourceDay.getUTCFullYear() !== year ||
        sourceDay.getUTCMonth() !== month - 1 ||
        sourceDay.getUTCDate() !== day
      ) continue;
      if (rollsToNextDay) sourceDay.setUTCDate(sourceDay.getUTCDate() + 1);
      const targetYear = sourceDay.getUTCFullYear();
      const targetMonth = sourceDay.getUTCMonth() + 1;
      const targetDay = sourceDay.getUTCDate();
      const targetHour = rollsToNextDay ? 0 : hour;
      const result = spToUtc({
        year: targetYear,
        month: targetMonth,
        day: targetDay,
        hour: targetHour,
        minute,
      });
      if (Number.isNaN(result.getTime())) continue;
      // Date.UTC faz rollover silencioso (31/02 → 03/03): rejeitar datas de calendário
      // impossíveis comparando os componentes SP de volta com o que foi parseado.
      const sp = utcToSpParts(result);
      if (
        sp.getUTCFullYear() !== targetYear ||
        sp.getUTCMonth() !== targetMonth - 1 ||
        sp.getUTCDate() !== targetDay ||
        sp.getUTCHours() !== targetHour ||
        sp.getUTCMinutes() !== minute
      ) {
        continue;
      }
      if (!hasYear && result.getTime() < ref.getTime() - THIRTY_DAYS_MS) continue;
      return { date: result, dateOnly: !hasTime && later === null };
    }
  }
  return parseRelativeKickoff(text, ref);
}
