import type { ParsedBetPost } from "./bet-capture";
import { buildPlayerPropTerms, normalizePlayerThreshold, type PlayerPropTerms } from "./settlement/player-prop-terms";
import { normalizeStr, splitEventoTeams } from "./text";
import { resolveCaptureStake } from "./capture-stake-policy";
import { expandVulgarFractions, isBankrollOrResultUnits, LIMIT_BEFORE, signedUnitsAreResult, STAKE_UNITS_PATTERN, stakeUnitsTokenStart, unitsWithFractionOrRange } from "./parse-bet-post";
import { parseDecimalInput } from "./decimal-input";

/** "0.5u cada (total 1u)": a soma do lote, não a stake de uma aposta. */
const BATCH_TOTAL_BEFORE = /\btotal\s*[:=]?\s*$/i;

/**
 * Unidades da legenda de um post com várias apostas, linha a linha. Limite,
 * meta, retorno, total do lote e resultado ("Máx 5u no dia", "Meta da semana:
 * 10u") falam da banca, não da stake de uma aposta (as mesmas regras da
 * leitura de stake do resto da captura): ficam em `others`, e o resto em
 * `stakes`. `each`: a legenda diz que a stake vale para cada aposta ("cada").
 */
export function captionStakeUnits(caption: string): { stakes: number[]; others: number[]; each: boolean } {
  const stakes: number[] = [];
  const others: number[] = [];
  for (const raw of caption.replace(/https?:\/\/\S+/g, "").split(/\r?\n/)) {
    const line = expandVulgarFractions(raw);
    for (const m of line.matchAll(STAKE_UNITS_PATTERN)) {
      const numberStart = (m.index ?? 0) + (m[1]?.length ?? 0);
      const start = stakeUnitsTokenStart(line, numberStart);
      const before = line.slice(0, start);
      const end = (m.index ?? 0) + m[0].length;
      const parsed = parseDecimalInput(m[3]);
      if (m[2] && signedUnitsAreResult(line, numberStart, end)) { others.push(parsed ?? Number.NaN); continue; }
      const isStake = !LIMIT_BEFORE.test(before) && !BATCH_TOTAL_BEFORE.test(before)
        && !isBankrollOrResultUnits(line, start, end);
      // Stake escrita e inválida não pode desaparecer e liberar o valor da imagem.
      const units = m[2] || parsed === null ? Number.NaN : unitsWithFractionOrRange(line.slice(0, numberStart), parsed);
      (isStake ? stakes : others).push(units);
    }
  }
  return { stakes, others, each: /\b(?:cada|em cada simples)\b/i.test(caption) };
}

export function preparePlayerCaptureBatch(
  bets: readonly ParsedBetPost[], caption: string, imageStakeAsUnits: boolean,
): { ok: true; bets: ParsedBetPost[] } | { ok: false; reason: string } {
  const props = bets.map((bet) => buildPlayerPropTerms(bet));
  if (!props.some(Boolean)) return { ok: true, bets: [...bets] };
  const { stakes, others, each } = bets.every((bet) => bet.stakePolicySnapshot?.source === "bankroll_fixed")
    ? { stakes: [], others: [], each: false } : captionStakeUnits(caption);
  if (stakes.some((stake) => !Number.isFinite(stake) || stake <= 0)) return { ok: false, reason: "stake_invalida" };
  // A IA diz ter lido na legenda uma stake que só aparece nela como limite ou
  // meta ("Máx 5u no dia" e 5u na prop): leu o limite, não a stake.
  if (!stakes.length && bets.some((bet) => bet.stakeSource === "caption"
    && others.includes(bet.stakePolicySnapshot?.originalStake ?? bet.stake))) return { ok: false, reason: "stake_invalida" };
  // "cada" vale para todas só com uma stake distinta na legenda: com duas, não
  // se sabe qual delas é a de cada prop.
  const distinctStakes = new Set(stakes).size;
  if (each && distinctStakes > 1) return { ok: false, reason: "quantidade_de_stakes_divergente" };
  const eachStake = each && distinctStakes === 1 ? stakes[0] : undefined;
  if (stakes.length && eachStake === undefined && stakes.length !== bets.length) return { ok: false, reason: "quantidade_de_stakes_divergente" };
  if (!stakes.length && !imageStakeAsUnits && bets.some((bet) => bet.stakeSource !== "caption" && !bet.stakePolicySnapshot?.source.startsWith("bankroll_"))) return { ok: false, reason: "stake_em_unidades_nao_comprovada" };
  const out = bets.map((bet, i) => {
    const incoming = stakes.length ? (eachStake ?? stakes[i]) ?? 0 : bet.stakePolicySnapshot ? bet.stakePolicySnapshot.originalStake : bet.stake;
    const resolved = resolveCaptureStake(incoming, bet.stakePolicySnapshot, { zeroIsMissing: !stakes.length && bet.stakePolicySnapshot?.source === "bankroll_default" });
    return { ...bet,
    selecao: props[i] ? normalizePlayerThreshold(bet.selecao) : bet.selecao,
    stake: resolved.stake ?? 0,
    stakeSource: resolved.snapshot?.source.startsWith("bankroll_") ? "unknown" as const : stakes.length ? "caption" as const : "image_units" as const,
    ...(resolved.snapshot ? { stakePolicySnapshot: resolved.snapshot } : {}),
    ...(props[i] && !bet.playerProp ? { playerProp: {
      jogador: props[i].jogador, mercadoOriginal: bet.mercado, selecaoOriginal: bet.selecao, substituicao: "UNKNOWN" as const,
    } } : {}),
  }; });
  if (out.some((bet) => !Number.isFinite(bet.stake) || bet.stake <= 0)) return { ok: false, reason: "stake_invalida" };
  return { ok: true, bets: out };
}

/** Stable across visual reordering, odds/stake edits and spelling normalization. */
export function playerCaptureItemKey(bet: Pick<ParsedBetPost, "mercado" | "selecao" | "evento" | "esporte">): string {
  return captureItemKey(bet, buildPlayerPropTerms(bet));
}

function captureItemKey(bet: Pick<ParsedBetPost, "mercado" | "selecao" | "evento" | "esporte">, terms: PlayerPropTerms | null): string {
  const teams = splitEventoTeams(bet.evento);
  const fixture = teams ? `${normalizeStr(teams.home)} vs ${normalizeStr(teams.away)}` : normalizeStr(bet.evento);
  return JSON.stringify([fixture, terms?.jogador ?? normalizeStr(bet.selecao), terms?.family ?? normalizeStr(bet.mercado), terms?.direction, terms?.lineQuarters, terms?.period]);
}
