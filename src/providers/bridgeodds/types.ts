import { stripResultFields } from "../strip-result";

/**
 * Contrato do endpoint `opening-closing` da BridgeOdds (fixtures reais em
 * tests/fixtures/bridgeodds/). `opening` é fixo; `closing` é a linha ATUAL em
 * jogo futuro e vira o fechamento final após o kickoff.
 */

export type BridgeTwoWayPrices = {
  home: number;
  away: number;
  max_bet?: number;
};

export type BridgeMoneylinePrices = BridgeTwoWayPrices & {
  draw?: number;
};

export type BridgeTotalPrices = {
  over: number;
  under: number;
  max_bet?: number;
};

export type BridgeLine<P> = {
  hdp_points: number;
  opening?: P;
  closing?: P;
};

export type BridgeMatch = {
  match_id: number;
  sport: string;
  /** "Pais - Competição" (ex.: "USA - USL League 2"). */
  league: string;
  home: string;
  away: string;
  /** ISO UTC. */
  match_date: string;
  home_score?: number | null;
  away_score?: number | null;
  moneyline?: {
    opening?: BridgeMoneylinePrices;
    closing?: BridgeMoneylinePrices;
  };
  /** hdp_points relativo ao HOME (negativo = casa favorita). */
  spread?: Array<BridgeLine<BridgeTwoWayPrices>>;
  total?: Array<BridgeLine<BridgeTotalPrices>>;
};

export type BridgeQueryPage = {
  count: number;
  page: number;
  per_page: number;
  total: number;
  results: BridgeMatch[];
};

export function parseBridgeLeague(league: string): { pais: string; competicao: string } {
  const idx = league.indexOf(" - ");
  if (idx === -1) return { pais: "", competicao: league.trim() };
  return {
    pais: league.slice(0, idx).trim(),
    competicao: league.slice(idx + 3).trim(),
  };
}

const INVALID = Symbol("fora do contrato");
type Invalid = typeof INVALID;

/**
 * Os preços de uma fase (`opening` ou `closing`). Fase ausente, ou com um
 * preço obrigatório ainda nulo, é linha sem preço; preço que não é número é
 * formato que mudou, e invalida a partida.
 */
function phasePrices<P>(raw: unknown, required: readonly string[], optional: readonly string[]): P | undefined | Invalid {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return INVALID;
  const row = raw as Record<string, unknown>;
  const prices: Record<string, number> = {};
  let priced = true;
  for (const key of [...required, ...optional]) {
    const value = row[key];
    if (value == null) {
      priced &&= !required.includes(key);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return INVALID;
    prices[key] = value;
  }
  return priced ? prices as P : undefined;
}

function phases<P>(row: Record<string, unknown>, required: readonly string[], optional: readonly string[]):
  { opening?: P; closing?: P } | Invalid {
  const opening = phasePrices<P>(row.opening, required, optional);
  const closing = phasePrices<P>(row.closing, required, optional);
  if (opening === INVALID || closing === INVALID) return INVALID;
  return { ...(opening ? { opening } : {}), ...(closing ? { closing } : {}) };
}

function lines<P>(raw: unknown, required: readonly string[]): Array<BridgeLine<P>> | undefined | Invalid {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return INVALID;
  const out: Array<BridgeLine<P>> = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return INVALID;
    const row = item as Record<string, unknown>;
    if (typeof row.hdp_points !== "number" || !Number.isFinite(row.hdp_points)) return INVALID;
    const prices = phases<P>(row, required, ["max_bet"]);
    if (prices === INVALID) return INVALID;
    out.push({ hdp_points: row.hdp_points, ...prices });
  }
  return out;
}

/**
 * Valida a partida vinda da API e remove placar/resultado antes que alcancem
 * identidade ou odds: resultado nunca vem de provider sharp. Os mercados saem
 * só com os campos do contrato, e o que veio noutro formato reprova a partida.
 */
export function sanitizeBridgeMatch(raw: unknown): BridgeMatch | null {
  const stripped = stripResultFields(raw) as Record<string, unknown>;
  if (!stripped || typeof stripped !== "object" || Array.isArray(stripped)) return null;
  const matchId = Number(stripped.match_id);
  if (!Number.isSafeInteger(matchId) || matchId <= 0) return null;
  if (
    typeof stripped.sport !== "string" ||
    typeof stripped.league !== "string" ||
    typeof stripped.home !== "string" ||
    typeof stripped.away !== "string" ||
    typeof stripped.match_date !== "string"
  )
    return null;
  if (Number.isNaN(Date.parse(stripped.match_date))) return null;
  const { moneyline: rawMoneyline, spread: rawSpread, total: rawTotal, ...identity } = stripped;
  if (rawMoneyline != null && (typeof rawMoneyline !== "object" || Array.isArray(rawMoneyline))) return null;
  const moneyline = rawMoneyline == null ? undefined
    : phases<BridgeMoneylinePrices>(rawMoneyline as Record<string, unknown>, ["home", "away"], ["draw", "max_bet"]);
  const spread = lines<BridgeTwoWayPrices>(rawSpread, ["home", "away"]);
  const total = lines<BridgeTotalPrices>(rawTotal, ["over", "under"]);
  if (moneyline === INVALID || spread === INVALID || total === INVALID) return null;
  return {
    ...identity,
    ...(moneyline ? { moneyline } : {}),
    ...(spread ? { spread } : {}),
    ...(total ? { total } : {}),
  } as unknown as BridgeMatch;
}

/** Partida já sanitizada e persistida em cache (catálogo, página, snapshot). */
export function isBridgeMatchPayload(value: unknown): value is BridgeMatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.match_id === "number" && Number.isFinite(row.match_id) &&
    typeof row.sport === "string" &&
    typeof row.league === "string" &&
    typeof row.home === "string" &&
    typeof row.away === "string" &&
    typeof row.match_date === "string" &&
    Number.isFinite(Date.parse(row.match_date))
  );
}

/**
 * O `closing` da Bridge só é o fechamento quando o jogo já começou no instante
 * observado, pelo horário dela e pelo da aposta; antes disso é a linha atual,
 * ainda em movimento. A Bridge guarda o horário da primeira listagem e não
 * acompanha remarcação: o da aposta (da Pinnacle17 ou do post) segura o jogo
 * adiado.
 */
export function bridgeClosingIsFinal(
  match: Pick<BridgeMatch, "match_date">,
  observedAt: Date,
  betKickoffUtc?: Date | null,
): boolean {
  return Date.parse(match.match_date) <= observedAt.getTime()
    && (!betKickoffUtc || betKickoffUtc.getTime() <= observedAt.getTime());
}

export function encodeBridgePriceReference(matchId: string | number): string {
  const normalized = String(matchId).trim();
  if (!normalized || normalized.includes(":")) {
    throw new Error("matchId BridgeOdds inválido para referência de preço");
  }
  return `bridgeodds:v1:${normalized}`;
}
