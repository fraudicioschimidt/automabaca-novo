import { canonicalSport } from "@/src/domain/sports/registry";
import { marketIncludesExtraTime, HALF_PERIOD_ABBREVIATIONS, HALF_PERIOD_PHRASES } from "@/src/domain/mercados/classify";
import { normalizeMercadoKey } from "@/src/domain/mercados/catalog";
import { normalizeStr } from "@/src/domain/text";
import { matchTeamSide } from "./sides";
import { classifyScoreMarket, declaredScorePeriod, hasNonScoreStatQualifier,
  hasScoreUnitMismatch, hasUnknownScoreQualifier } from "./markets";

type Terms = { esporte?: string; mercado: string; selecao: string; evento?: string };
const firstHalfMention = new RegExp(String.raw`\b(?:${[...HALF_PERIOD_PHRASES.first, ...HALF_PERIOD_ABBREVIATIONS.first].join("|")})\b`);

export function isBasketballFirstHalf(params: Terms): boolean {
  // Roteamento inclui termos contraditórios para recusá-los, mesmo quando
  // "incluindo OT" faz o classificador geral declarar FT antes de examinar HT.
  return canonicalSport(params.esporte) === "Basketball" && (declaredScorePeriod(params) === "HT"
    || [params.mercado, params.selecao].some((text) => firstHalfMention.test(normalizeMercadoKey(text))));
}

/** Contrato estreito: pontos do período inteiro, total de jogo ou handicap de duas vias. */
export function supportsBasketballFirstHalf(params: Terms): boolean {
  if (!isBasketballFirstHalf(params) || declaredScorePeriod(params) !== "HT") return false;
  if ([params.mercado, params.selecao].some(marketIncludesExtraTime)) return false;
  if (hasNonScoreStatQualifier(params.mercado, params.selecao)
    || hasScoreUnitMismatch(params.mercado, params.selecao, params.esporte)
    || hasUnknownScoreQualifier(params.mercado)) return false;
  const kind = classifyScoreMarket(normalizeStr(params.mercado), normalizeStr(params.selecao), params.evento);
  if (kind === "total" && params.evento && matchTeamSide(params.selecao, params.evento) !== null) return false;
  return kind === "total" || kind === "handicap";
}
