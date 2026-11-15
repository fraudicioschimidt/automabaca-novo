export type ParsedPriceReference =
  | { provider: "bridgeodds"; matchId: string }
  | {
      provider: "pinnacle17";
      eventId: number;
      period: number;
      marketType: "moneyline" | "spread" | "total" | "team_total";
      line: string;
      outcome: string;
      unit?: string;
    };

/** Registry fechado da gramática persistida de cada referência de preço. */
export function parseTypedPriceReference(
  provider: string | null | undefined,
  raw: string | null | undefined,
): ParsedPriceReference | null {
  const value = raw?.trim();
  if (!value) return null;
  if (provider === "bridgeodds") {
    const match = value.match(/^bridgeodds:v1:([^:]+)$/);
    return match?.[1] ? { provider, matchId: match[1] } : null;
  }
  if (provider === "pinnacle17") {
    const match = value.match(
      /^pinnacle17:v([12]):([1-9]\d*):(0|[1-9]\d*):(moneyline|spread|total|team_total):([a-z0-9_-]+):([a-z0-9_-]+)(?::([a-z][a-z0-9_-]*))?$/,
    );
    if (!match) return null;
    if ((match[1] === "2") !== Boolean(match[7])) return null;
    const eventId = Number(match[2]);
    const period = Number(match[3]);
    if (!Number.isSafeInteger(eventId) || eventId <= 0 || !Number.isSafeInteger(period) || period < 0) return null;
    const marketType = match[4] as "moneyline" | "spread" | "total" | "team_total";
    const line = match[5]!;
    const outcome = match[6]!;
    if (marketType === "moneyline") {
      if (line !== "ml" || !["home", "away", "draw"].includes(outcome)) return null;
    } else {
      // A linha persistida é um número inteiro de quartos, na perspectiva
      // da seleção; tokens decimais ou valores inseguros não fixam uma linha.
      if (!/^(?:0|-?[1-9]\d*)$/.test(line) || !Number.isSafeInteger(Number(line))) return null;
      if (marketType !== "spread" && Number(line) < 0) return null;
      const outcomes = marketType === "spread" ? ["home", "away"]
        : marketType === "total" ? ["over", "under"]
        : ["home_over", "home_under", "away_over", "away_under"];
      if (!outcomes.includes(outcome)) return null;
    }
    return {
      provider,
      eventId,
      period,
      marketType,
      line,
      outcome,
      ...(match[7] ? { unit: match[7] } : {}),
    };
  }
  return null;
}
