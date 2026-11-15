import type { ParsedBetPost } from "./bet-capture";
import { marketKindOf, marketPeriodOf } from "./mercados/classify";
import { totalDirectionOf } from "./mercados/total-direction";
import { hasNonScoreStatQualifier } from "./mercados/stat-qualifier";
import { esportesComUnidade } from "./sports/registry";
import { parseLineQuarters } from "./settlement/lines";
import { matchTeamSide, stripTeamNames } from "@/src/domain/settlement/sides";
import { normalizeStr } from "./text";
import { stripKickoffFromSelection, stripLiveScoreAtTip, stripLiveScoreAtTipPrefix } from "./live-score-at-tip";

type SelectionResult = { ok: true; bets: ParsedBetPost[] } | { ok: false; reason: string };

// A caption can select one option from a market grid. An odd on every cell
// does not establish that every cell is a placed single. Match the selection
// before per-item stake handling removes the shared caption.
const DIRECTION_LINE = /^(.*?)\s*(\bover\b|\bunder\b|\bmais\b(?:\s+de)?|\bmenos\b(?:\s+de)?|\bacima\b(?:\s+de)?|\babaixo\b(?:\s+de)?|[+-])\s*(\d+(?:[.,]\d+)?)\s*(.*?)$/;
const LIMIT = /\b(?:ate|limite|minima|minimo|minimum)\b/;
const STAT_UNITS: Array<{ pattern: RegExp; scoreUnit?: "pontos" | "gols" }> = [
  { pattern: /\b(?:pontos?|points?)\b/, scoreUnit: "pontos" },
  { pattern: /\b(?:gols?|goals?)\b/, scoreUnit: "gols" },
  { pattern: /\b(?:cantos?|corners?|escanteios?)\b/ },
  { pattern: /\b(?:cartoes|cartao|cards?|bookings?)\b/ },
  { pattern: /\b(?:games?|jogos?)\b/ },
  { pattern: /\bsets?\b/ },
];

export function reconcileImageCaptionSelection(bets: ParsedBetPost[], caption: string): SelectionResult {
  // Player tickets have their own ordered stake/selection contract. In
  // particular, the three Ganso slips are three singles, even in one image.
  if (bets.some((bet) => bet.playerProp || bet.legs || marketKindOf(bet.mercado) === "player_props")) {
    return { ok: true, bets };
  }
  const candidates = caption.replace(/https?:\/\/\S+/gi, "").split(/\r?\n/)
    .map((line) => normalizeStr(stripKickoffFromSelection(stripLiveScoreAtTipPrefix(line))).split(LIMIT)[0]?.split("@")[0]
      ?.replace(/\b\d+(?:[.,]\d+)?\s*(?:u|un|units?|unidades?)\b/g, "").trim() ?? "")
    .map((line) => ({ raw: line, match: line.match(DIRECTION_LINE) }))
    .filter((item) => item.match);
  // Multiple explicit picks retain their existing batch contract. A caption
  // containing only stakes/links does not select or discard ticket entries.
  if (candidates.length !== 1) return { ok: true, bets };
  const candidate = candidates[0];
  if (!candidate?.match) return { ok: true, bets };
  const { raw, match } = candidate;
  const [, subject = "", direction = "", line = "", suffix = ""] = match;
  // Do not interpret a second leg/alternative as a qualifier of the first.
  if (DIRECTION_LINE.test(suffix) || /\b(?:ou|or)\b/.test(raw)) {
    return { ok: false, reason: "selecao_da_legenda_ambigua" };
  }
  const explicitDirection = direction !== "+" && direction !== "-";
  const expectedDirection = explicitDirection
    ? totalDirectionOf(`${direction} ${line}`)
    : direction === "+" ? "over" : "under";
  const stat = STAT_UNITS.find((unit) => unit.pattern.test(`${subject} ${suffix}`));
  const participant = subject.replace(/^(?:entrada|aposta|selecao)\s*:\s*/, "").trim();
  const explicitPeriod = /\b(?:tempo|half|periodo|period|quarto|quarter|mapa|map|set)\b/.test(raw);
  const matches = bets.filter((bet) => {
    const financialSelection = stripLiveScoreAtTip(stripKickoffFromSelection(bet.selecao), bet.mercado);
    const kind = marketKindOf(bet.mercado, bet.selecao, bet.evento);
    if (!["team_total", "total", "spread"].includes(kind)) return false;
    if (explicitDirection && kind === "spread") return false;
    if (stat && !stat.pattern.test(normalizeStr(bet.mercado))) {
      const implicitScoreUnit = stat.scoreUnit && esportesComUnidade(stat.scoreUnit).includes(normalizeStr(bet.esporte))
        && !hasNonScoreStatQualifier(bet.mercado, bet.selecao)
        && !STAT_UNITS.some((unit) => unit.pattern.test(normalizeStr(bet.mercado)));
      if (!implicitScoreUnit) return false;
    }
    if (explicitPeriod && marketPeriodOf(raw, bet.esporte) !== marketPeriodOf(bet.mercado, bet.esporte)) return false;
    const side = participant ? matchTeamSide(participant, bet.evento) : null;
    if (kind === "team_total" || kind === "spread") {
      if (!side || side !== matchTeamSide(bet.selecao, bet.evento)) return false;
    } else if (side) {
      // A named team's total is not the combined total of the fixture.
      return false;
    } else if (participant && !/^(?:total|total de|total do jogo)$/.test(participant)) return false;
    const expectedLine = parseLineQuarters(`${kind === "spread" ? direction : ""}${line}`, { allowNegative: kind === "spread" });
    const actualLine = parseLineQuarters(stripTeamNames(financialSelection, bet.evento), { allowNegative: kind === "spread" });
    if (expectedLine === null || actualLine !== expectedLine) return false;
    return kind === "spread" || totalDirectionOf(stripTeamNames(financialSelection, bet.evento), { allowBarePositiveLine: true }) === expectedDirection;
  });
  if (matches.length !== 1) {
    return { ok: false, reason: matches.length ? "selecao_da_legenda_ambigua" : "selecao_diverge_legenda" };
  }
  return { ok: true, bets: matches };
}
