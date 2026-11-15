import { marketKindOf } from "@/src/domain/mercados/classify";
import { canonicalizeAsianHandicapSelecao } from "@/src/domain/asian-handicap-line";
import { extractSignedNumbers, parseLineQuarters, withoutNumberedHalf } from "./lines";

/**
 * Valida se um mercado/seleção admite liquidação de meio-ganho ou meio-perdido
 * (HALF_WON ou HALF_LOST). Mercados puramente binários como 1X2 / Moneyline (ex: 'Vencedor do Encontro',
 * '1X2', 'Resultado Final') ou 'Ambas Marcam' (BTTS) não admitem meio-ganho/meio-perdido.
 */
export function admitsAsianFractionalSettlement(
  mercado: string,
  selecao = "",
): boolean {
  const canonSelecao = canonicalizeAsianHandicapSelecao(selecao, "", mercado);
  const kind = marketKindOf(mercado, canonSelecao);
  // A linha sai do texto sem o tempo: o dígito de "Over 0,5 1ºT" não é dela.
  const lineSelecao = withoutNumberedHalf(selecao);
  const lineCanon = canonicalizeAsianHandicapSelecao(lineSelecao, "", mercado);
  const lineMercado = withoutNumberedHalf(mercado);

  // Mercados puramente binários / sem linha asiática fracionária
  if (
    kind === "moneyline" ||
    kind === "btts" ||
    kind === "draw_no_bet" ||
    kind === "double_chance" ||
    kind === "correct_score" ||
    kind === "scorer"
  ) {
    return false;
  }

  // Se o classificador identificar como spread ou total:
  if (kind === "spread" || kind === "total" || kind === "team_total") {
    const quarters =
      parseLineQuarters(lineCanon, { allowNegative: kind === "spread" }) ??
      parseLineQuarters(lineSelecao, { allowNegative: kind === "spread" }) ??
      // Mesmo fallback do motor de placar: números inválidos ou conflitantes
      // na seleção não autorizam resgatar uma linha do rótulo do mercado.
      (extractSignedNumbers(lineCanon).length === 0
        ? parseLineQuarters(lineMercado, { allowNegative: kind === "spread" })
        : null);
    if (quarters !== null) {
      return Math.abs(quarters) % 2 === 1;
    }
    return false;
  }

  // Defesa textual para padrões conhecidos de 1X2 / ML / BTTS caso caiam em "other"
  const combined = `${mercado} ${selecao}`.toLowerCase();
  if (
    /\b(1x2|moneyline|money line|vencedor do encontro|vencedor da partida|vencedor|resultado final|match winner|ambas marcam|ambas marcam\?|btts|both teams to score)\b/i.test(
      combined,
    )
  ) {
    return false;
  }

  // Se houver quarter line explícita na seleção mesmo em mercado "other"
  const quarters =
    parseLineQuarters(lineCanon, { allowNegative: false }) ??
    parseLineQuarters(lineCanon, { allowNegative: true }) ??
    parseLineQuarters(lineSelecao, { allowNegative: false }) ??
    parseLineQuarters(lineSelecao, { allowNegative: true });
  if (quarters !== null && Math.abs(quarters) % 2 === 1) {
    return true;
  }

  return false;
}
