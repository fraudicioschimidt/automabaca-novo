import { z } from "zod";
import { parseTypedPriceReference } from "@/src/domain/price-reference";
import { stripResultFields } from "../strip-result";
import { canonicalSport } from "@/src/domain/sports/registry";
import { normalizeStr } from "@/src/domain/text";

type Pinnacle17Status = {
  isStarted: boolean;
  isInProgress: boolean;
  isInterrupted: boolean;
};

export type Pinnacle17Event = {
  id: number;
  name: string;
  startTime: string;
  status: Pinnacle17Status;
  sport: { id: number; name: string };
  league: { id: number; name: string; country: string | null };
  homeTeam: { name: string };
  awayTeam: { name: string };
  units: string;
};

type Pinnacle17Limit = { amount: number; type: string };
export type Pinnacle17Outcome = {
  designation: "home" | "away" | "draw" | "over" | "under";
  name: string;
  line: number | null;
  oddsAmerican: number | null;
  oddsDecimal: number;
};

export type Pinnacle17Market = {
  name: string;
  type: "moneyline" | "spread" | "total" | "team_total";
  period: number;
  periodName: string;
  team: string | null;
  units: string;
  special: string | null;
  isLive: boolean;
  line: number | null;
  status: string;
  cutoffAt: string | null;
  limits: Pinnacle17Limit[];
  outcomes: Pinnacle17Outcome[];
};

export type Pinnacle17PriceReference = {
  provider: "pinnacle17";
  eventId: number;
  period: number;
  marketType: Pinnacle17Market["type"];
  line: string;
  outcome: string;
  /** v2 pins the counting unit as well as the period and line. */
  unit?: string;
};

const timestampSchema = z.iso.datetime({ offset: true });

export function encodePinnacle17PriceReference(reference: Pinnacle17PriceReference): string {
  const value = [
    "pinnacle17",
    reference.unit ? "v2" : "v1",
    reference.eventId,
    reference.period,
    reference.marketType,
    reference.line,
    reference.outcome,
    ...(reference.unit ? [reference.unit] : []),
  ].join(":");
  if (reference.unit === "" || !parseTypedPriceReference("pinnacle17", value)) {
    throw new Error("referência Pinnacle17 inválida");
  }
  return value;
}

export function parsePinnacle17PriceReference(
  raw: string | null | undefined,
): Pinnacle17PriceReference | null {
  const parsed = parseTypedPriceReference("pinnacle17", raw);
  return parsed?.provider === "pinnacle17" ? parsed : null;
}

/** IDs publicados pelo catálogo oficial /sport/list da Pinnacle17 (63 esportes). */
export const PINNACLE17_SPORT_IDS: Readonly<Record<string, number>> = {
  soccer: 29,
  tennis: 33,
  basketball: 4,
  hockey: 19,
  "american football": 15,
  football: 15,
  baseball: 3,
  volleyball: 34,
  handball: 18,
  mma: 22,
  "mixed martial arts": 22,
  esports: 12,
  "e sports": 12,
  boxing: 6,
  rugby: 27,
  "rugby union": 27,
  "rugby league": 26,
  cricket: 8,
  golf: 17,
  futsal: 16,
  darts: 10,
  snooker: 28,
  "table tennis": 32,
  "beach volleyball": 5,
  badminton: 1,
  "water polo": 36,
  "aussie rules": 39,
  cycling: 45,
  "formula 1": 44,
};

export function pinnacle17SportId(esporte: string): number | null {
  const direct = normalizeStr(esporte).replace(/[_-]+/g, " ");
  return PINNACLE17_SPORT_IDS[direct] ?? PINNACLE17_SPORT_IDS[canonicalSport(esporte)?.toLowerCase() ?? ""] ?? null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = finite(value);
  if (parsed === null) return null;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function finite(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function arrayEnvelope(raw: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  const source = record(raw);
  if (!source) return null;
  for (const key of keys) if (Array.isArray(source[key])) return source[key] as unknown[];
  const data = record(source.data);
  if (data) for (const key of keys) if (Array.isArray(data[key])) return data[key] as unknown[];
  return Array.isArray(source.data) ? source.data : null;
}

/** O adapter descarta placares/resultados e conserva so identidade pre-jogo. */
export function sanitizePinnacle17Event(raw: unknown): Pinnacle17Event | null {
  const source = record(stripResultFields(raw));
  const id = positiveInt(source?.id);
  const name = text(source?.name);
  const startTime = text(source?.startTime);
  const sport = record(source?.sport);
  const league = record(source?.league);
  const home = record(source?.homeTeam);
  const away = record(source?.awayTeam);
  const status = record(source?.status);
  const sportId = positiveInt(sport?.id);
  const leagueId = positiveInt(league?.id);
  const sportName = text(sport?.name);
  const leagueName = text(league?.name);
  const homeName = text(home?.name);
  const awayName = text(away?.name);
  if (
    !source || !league || id === null || !name || !startTime || sportId === null || leagueId === null ||
    !sportName || !leagueName || !homeName || !awayName || !status ||
    [status.isStarted, status.isInProgress, status.isInterrupted].some(flag => typeof flag !== "boolean") || !text(source.units)
  ) return null;
  if (!timestampSchema.safeParse(startTime).success) return null;
  const start = new Date(startTime);
  return {
    id,
    name,
    startTime: start.toISOString(),
    status: {
      isStarted: status.isStarted === true,
      isInProgress: status.isInProgress === true,
      isInterrupted: status.isInterrupted === true,
    },
    sport: { id: sportId, name: sportName },
    league: { id: leagueId, name: leagueName, country: text(league.country) },
    homeTeam: { name: homeName },
    awayTeam: { name: awayName },
    units: text(source.units) ?? "Regular",
  };
}

/** As linhas aceitas de uma resposta e quantas ficaram fora do contrato. */
export type Pinnacle17Parsed<T> = { rows: T[]; rejected: number };

function parseRows<T>(rows: unknown[], sanitize: (raw: unknown) => T | null): Pinnacle17Parsed<T> {
  const accepted = rows.map(sanitize).filter((row): row is T => row !== null);
  return { rows: accepted, rejected: rows.length - accepted.length };
}

export function parsePinnacle17Events(raw: unknown): Pinnacle17Parsed<Pinnacle17Event> | null {
  const rows = arrayEnvelope(raw, ["matches", "events", "data"]);
  return rows ? parseRows(rows, sanitizePinnacle17Event) : null;
}

export function normalizePinnacle17Events(raw: unknown): Pinnacle17Event[] | null {
  return parsePinnacle17Events(raw)?.rows ?? null;
}

function designation(value: unknown): Pinnacle17Outcome["designation"] | null {
  const normalized = text(value)?.toLowerCase();
  return normalized === "home" || normalized === "away" || normalized === "draw" ||
    normalized === "over" || normalized === "under" ? normalized : null;
}

function sanitizeOutcome(raw: unknown): Pinnacle17Outcome | null {
  const source = record(raw);
  const side = designation(source?.designation);
  const name = text(source?.name);
  const decimal = finite(source?.oddsDecimal);
  if (!source || !side || !name || decimal === null || decimal <= 1 ||
    (source.line != null && finite(source.line) === null)) return null;
  return {
    designation: side,
    name,
    line: finite(source.line),
    oddsAmerican: finite(source.oddsAmerican),
    oddsDecimal: decimal,
  };
}

function marketType(value: unknown): Pinnacle17Market["type"] | null {
  const normalized = text(value)?.toLowerCase();
  return normalized === "moneyline" || normalized === "spread" || normalized === "total" ||
    normalized === "team_total" ? normalized : null;
}

function sanitizeMarket(raw: unknown): Pinnacle17Market | null {
  const source = record(raw);
  const name = text(source?.name);
  const type = marketType(source?.type);
  const period = finite(source?.period);
  const periodName = text(source?.periodName);
  const units = text(source?.units);
  const status = text(source?.status);
  const cutoffAt = text(source?.cutoffAt);
  if (!source || !name || !type || period === null || !Number.isInteger(period) || period < 0 || !periodName || !units || !status ||
    typeof source.isLive !== "boolean" || (source.line != null && finite(source.line) === null) ||
    (source.special != null && typeof source.special !== "string") ||
    (source.cutoffAt != null && !timestampSchema.safeParse(cutoffAt).success)) {
    return null;
  }
  const limits = Array.isArray(source.limits)
    ? source.limits.flatMap((rawLimit): Pinnacle17Limit[] => {
        const limit = record(rawLimit);
        const amount = finite(limit?.amount);
        const kind = text(limit?.type);
        return amount !== null && amount >= 0 && kind ? [{ amount, type: kind }] : [];
      })
    : [];
  const outcomes = Array.isArray(source.outcomes)
    ? source.outcomes.map(sanitizeOutcome).filter((row): row is Pinnacle17Outcome => row !== null)
    : [];
  // Dropping a malformed draw would turn a broken 3-way book into a fake 2-way.
  if (!Array.isArray(source.outcomes) || outcomes.length !== source.outcomes.length || outcomes.length < 2) return null;
  return {
    name,
    type,
    period,
    periodName,
    team: text(source.team),
    units,
    special: text(source.special),
    isLive: source.isLive === true,
    line: finite(source.line),
    status,
    cutoffAt,
    limits,
    outcomes,
  };
}

/**
 * Mercado de um tipo que o produto não lê (um `type` novo do fornecedor) não é
 * linha fora do contrato: fica de fora sem contar como rejeitada.
 */
export function parsePinnacle17Markets(raw: unknown): Pinnacle17Parsed<Pinnacle17Market> | null {
  const rows = arrayEnvelope(raw, ["markets", "odds", "data"]);
  if (!rows) return null;
  return parseRows(rows.filter((row) => {
    const type = text(record(row)?.type);
    return type === null || marketType(type) !== null;
  }), sanitizeMarket);
}

export function normalizePinnacle17Markets(raw: unknown): Pinnacle17Market[] | null {
  return parsePinnacle17Markets(raw)?.rows ?? null;
}
