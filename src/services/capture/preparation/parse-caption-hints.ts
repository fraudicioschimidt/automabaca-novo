/**
 * Extração pura de stake / odd @ da legenda tipster.
 * Sem I/O — compartilhado pelo guard de captura.
 */

import { parseDecimalInput } from "@/src/domain/decimal-input";
import { expandVulgarFractions, isBankrollOrResultUnits, LIMIT_BEFORE, signedUnitsAreResult, STAKE_UNITS_PATTERN, stakeUnitsTokenStart, unitsWithFractionOrRange } from "@/src/domain/parse-bet-post";

const DECIMAL_TOKEN = String.raw`\d+(?:[.,]\d+){0,2}`;

const ODDS_AT_GLOBAL = new RegExp(
  `@\\s*(${DECIMAL_TOKEN})(?![a-z0-9_]|[.,]\\d)`,
  "gi",
);

/**
 * Stake e odd explícita (@) da legenda — ignora "min X" como odd.
 * `stakeUnreadable`: a stake está escrita, mas é inválida ou ambígua. Ela
 * não pode desaparecer e liberar outra stake lida do print.
 */
export function extractCaptionBetHints(caption: string, options?: { ignoreStake?: boolean }): {
  odds?: number;
  stake?: number;
  stakeUnreadable?: boolean;
  ambiguous?: boolean;
} {
  if (!caption.trim()) return {};
  const lines = expandVulgarFractions(caption).split(/\r?\n/).map((l) => l.trim());
  let stake: number | undefined;
  let stakeUnreadable = false;
  let captionOdds: number | undefined;
  const stakes = new Set<number>();
  const odds = new Set<number>();

  for (const line of lines) {
    const stakeLineOdd = line.match(
      new RegExp(
        `(${DECIMAL_TOKEN})\\s*(?:u|un|units?|unidades?)(?![a-z0-9_])[^\\n]*@\\s*` +
          `(${DECIMAL_TOKEN})(?![a-z0-9_]|[.,]\\d)`,
        "i",
      ),
    );
    // "1u / Até @1.76": o @ depois de "até/min/máx" é limite, não a odd da entrada.
    const stakeLineOddAt = stakeLineOdd ? (stakeLineOdd.index ?? 0) + stakeLineOdd[0].lastIndexOf("@") : -1;
    if (stakeLineOdd?.[2] && !LIMIT_BEFORE.test(line.slice(0, stakeLineOddAt))) {
      const o = parseDecimalInput(stakeLineOdd[2]);
      if (o !== null && o > 1) {
        captionOdds = o;
        odds.add(o);
      }
    }
    // Numa legenda multi-perna cada `@X` casa; first-wins evita a ÚLTIMA odd
    // virar a odd do guard (odd_diverge_legenda). @ fora da linha do stake
    // (ex. "Will / SL @2.10\\n1u") continua válido para CAPTION_ODD.
    for (const m of line.matchAll(ODDS_AT_GLOBAL)) {
      const before = line.slice(0, m.index ?? 0);
      if (LIMIT_BEFORE.test(before)) continue;
      const o = parseDecimalInput(m[1] ?? "");
      if (o !== null && o > 1) {
        captionOdds ??= o;
        odds.add(o);
      }
    }
    for (const m of line.matchAll(STAKE_UNITS_PATTERN)) {
      if (options?.ignoreStake) continue;
      const numberStart = (m.index ?? 0) + (m[1]?.length ?? 0);
      const start = stakeUnitsTokenStart(line, numberStart);
      const before = line.slice(0, start);
      // Meta, lucro, retorno e resultado ("Meta do mês: 30u", "Nunca passe de
      // 5u", "Retorno: 1.90u", "Ontem +12u") falam da banca, não da stake desta aposta.
      const end = (m.index ?? 0) + m[0].length;
      if (LIMIT_BEFORE.test(before) || isBankrollOrResultUnits(line, start, end)) continue;
      if (m[2] && signedUnitsAreResult(line, numberStart, end)) continue;
      const units = parseDecimalInput(m[3] ?? "");
      const parsed = m[2] || units === null ? Number.NaN : unitsWithFractionOrRange(line.slice(0, numberStart), units);
      if (!Number.isFinite(parsed) || parsed <= 0) { stakeUnreadable = true; continue; }
      stake = parsed;
      stakes.add(parsed);
    }
  }

  const out: { odds?: number; stake?: number } = {};
  if (stakes.size > 1 || odds.size > 1) return { ambiguous: true };
  if (stakeUnreadable) return { ...(captionOdds !== undefined ? { odds: captionOdds } : {}), stakeUnreadable: true };
  if (stake !== undefined) out.stake = stake;
  if (captionOdds !== undefined) out.odds = captionOdds;
  return out;
}
