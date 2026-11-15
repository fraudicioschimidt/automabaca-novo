/**
 * O céu de São Paulo para o desenho ao lado da saudação do Dashboard: em que
 * parte do dia o sol está e em que fase está a lua. É para o desenho, não para
 * navegação: o nascer e o pôr saem do algoritmo do "Almanac for Computers"
 * (um minuto de diferença para o Observatório Naval dos EUA) e a fase, do mês
 * lunar médio (menos de um dia de diferença nas luas cheias e novas).
 */

import { assertValidDate, formatSpTime, utcToSpParts } from "@/src/domain/dates";

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SP_LATITUDE = -23.55;
const SP_LONGITUDE = -46.63;
/** Uma lua nova conhecida (6/1/2000, 18:14 UTC) e a duração média do mês lunar. */
const NEW_MOON_REFERENCE_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_MONTH_DAYS = 29.530588853;
/** Até 1h12 depois do nascer, e desde 1h12 antes do pôr, o sol está baixo no horizonte. */
const LOW_SUN_MS = 1.2 * HOUR_MS;

export type SkyMoment = "sunrise" | "morning" | "afternoon" | "sunset" | "night";

export type SpSky = {
  moment: SkyMoment;
  /** Fase da lua de 0 a 1 (ver `moonPhase`). */
  moonPhase: number;
  /** A frase do balão do desenho: os horários do sol de dia, a lua à noite. */
  label: string;
};

const MOON_PHASE_NAMES = [
  "Lua nova", "Lua crescente", "Quarto crescente", "Gibosa crescente",
  "Lua cheia", "Gibosa minguante", "Quarto minguante", "Lua minguante",
] as const;

const wrap = (value: number, period: number) => ((value % period) + period) % period;

/** Instante do nascer (ou do pôr) do sol em São Paulo na data de SP `year`/`month`/`day`. */
function sunEvent(year: number, month: number, day: number, rising: boolean): Date {
  const midnightUtc = Date.UTC(year, month, day);
  const dayOfYear = Math.round((midnightUtc - Date.UTC(year, 0, 0)) / DAY_MS);
  const lngHour = SP_LONGITUDE / 15;
  const t = dayOfYear + ((rising ? 6 : 18) - lngHour) / 24;
  const meanAnomaly = 0.9856 * t - 3.289;
  const trueLongitude = wrap(meanAnomaly + 1.916 * Math.sin(meanAnomaly * RAD) + 0.02 * Math.sin(2 * meanAnomaly * RAD) + 282.634, 360);
  const ascension = wrap(Math.atan(0.91764 * Math.tan(trueLongitude * RAD)) / RAD, 360);
  // A ascensão reta fica no mesmo quadrante da longitude.
  const rightAscension = (ascension + Math.floor(trueLongitude / 90) * 90 - Math.floor(ascension / 90) * 90) / 15;
  const sinDeclination = 0.39782 * Math.sin(trueLongitude * RAD);
  const cosDeclination = Math.cos(Math.asin(sinDeclination));
  const cosHourAngle = (Math.cos(90.833 * RAD) - sinDeclination * Math.sin(SP_LATITUDE * RAD)) / (cosDeclination * Math.cos(SP_LATITUDE * RAD));
  const hourAngle = Math.acos(cosHourAngle) / RAD;
  const localMeanTime = (rising ? 360 - hourAngle : hourAngle) / 15 + rightAscension - 0.06571 * t - 6.622;
  // Em SP (UTC-3) o nascer e o pôr caem no mesmo dia UTC da data local.
  return new Date(midnightUtc + wrap(localMeanTime - lngHour, 24) * HOUR_MS);
}

/** Nascer e pôr do sol em São Paulo no dia (de SP) de `date`. */
export function spSunTimes(date: Date): { sunrise: Date; sunset: Date } {
  assertValidDate(date, "spSunTimes");
  const sp = utcToSpParts(date);
  const [year, month, day] = [sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate()];
  return { sunrise: sunEvent(year, month, day, true), sunset: sunEvent(year, month, day, false) };
}

/** Fase da lua de 0 a 1: 0 é lua nova, 0,25 quarto crescente, 0,5 cheia e 0,75 quarto minguante. */
export function moonPhase(date: Date): number {
  assertValidDate(date, "moonPhase");
  return wrap((date.getTime() - NEW_MOON_REFERENCE_MS) / DAY_MS, SYNODIC_MONTH_DAYS) / SYNODIC_MONTH_DAYS;
}

/** Fração do disco iluminada, de 0 (nova) a 1 (cheia). */
export function moonIllumination(phase: number): number {
  return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

/** O nome da fase, das oito que o calendário usa. */
export function moonPhaseName(phase: number): string {
  return MOON_PHASE_NAMES[Math.floor(wrap(phase * 8 + 0.5, 8))] ?? MOON_PHASE_NAMES[0];
}

/**
 * O céu de agora em São Paulo. O momento segue o sol de verdade (no inverno,
 * às 17h40 já é noite), enquanto a saudação segue o relógio; manhã e tarde se
 * dividem ao meio-dia, como "Bom dia" e "Boa tarde".
 */
export function spSky(now: Date = new Date()): SpSky {
  assertValidDate(now, "spSky");
  const { sunrise, sunset } = spSunTimes(now);
  const phase = moonPhase(now);
  const t = now.getTime();
  let moment: SkyMoment;
  if (t < sunrise.getTime() || t >= sunset.getTime()) moment = "night";
  else if (t - sunrise.getTime() < LOW_SUN_MS) moment = "sunrise";
  else if (sunset.getTime() - t <= LOW_SUN_MS) moment = "sunset";
  else moment = utcToSpParts(now).getUTCHours() < 12 ? "morning" : "afternoon";
  const label = moment === "night"
    ? `${moonPhaseName(phase)}, ${Math.round(moonIllumination(phase) * 100)}% iluminada`
    : `Nascer do sol às ${formatSpTime(sunrise)} · pôr do sol às ${formatSpTime(sunset)}`;
  return { moment, moonPhase: phase, label };
}
