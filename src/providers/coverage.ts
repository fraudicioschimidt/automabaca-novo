import { isMercadoFinal } from "@/src/domain/mercados/catalog";
import { isMercadoFinalForSport } from "@/src/domain/mercados/compatibility";
import { marketKindOf, marketPeriodOf } from "@/src/domain/mercados/classify";
import { classificarPropDeJogador } from "@/src/domain/settlement/player-prop-classify";
import { normalizeStr } from "@/src/domain/text";
import { BRIDGEODDS_COVERAGE, bridgeOddsSportContract, bridgeOddsSupportsScope, type BridgeOddsMarketKind } from "@/src/providers/bridgeodds/coverage-contract";
import { pinnacle17SportId } from "./pinnacle17/types";
import { pinnacle17MarketContract } from "./pinnacle17/market-contract";
import { hasScoreUnitMismatch, hasNonScoreStatQualifier } from "@/src/domain/mercados/stat-qualifier";

/**
 * Fonte única de CAPACIDADE dos providers sharp: qual provider cobre qual
 * esporte e família de mercado. O enrich e o fechamento roteiam por aqui.
 *
 * A ORDEM das tentativas de identidade mora em
 * `services/sharp/enrich/sharp-identity.ts`: a Pinnacle17 (cota diária grande)
 * vai primeiro sempre que cobre o esporte, e a BridgeOdds (cota por hora curta)
 * fica para a abertura, a reserva do fechamento e o jogo que a Pinnacle17 não
 * achou. Na matriz comprovada da BridgeOdds (`bridgeOddsIsAuthoritative`),
 * essa segunda tentativa busca identidade e preço; fora dela, só identidade.
 * O fechamento segue o provider que confirmou a identidade; a aposta casada
 * pela Bridge num mercado que ela não precifica fecha pela Pinnacle17
 * (`tryClosingReferenceFallback`). O FlashScore fornece só os resultados e as
 * estatísticas.
 */

export type ProviderId = "bridgeodds" | "pinnacle17";

/**
 * Fonte externa exclusiva de resultado para settlement automático.
 *
 * Os providers acima são a cascata sharp de identidade/preço. Mesmo quando o
 * payload deles traz placar, esse dado não é evidência autorizada para mudar o
 * status financeiro de uma aposta.
 */
export const AUTOMATIC_RESULT_PROVIDER = "flashscore" as const;

/**
 * Os providers sharp em ordem de preferência. Fora da matriz da BridgeOdds, as
 * listas de identidade e de preço seguem esta ordem, filtrada por capacidade.
 */
export const SHARP_PROVIDER_ORDER: readonly ProviderId[] = [
  "pinnacle17",
  "bridgeodds",
] as const;

/** Esportes canônicos (EN, como persistidos na Bet) do contrato Bridge. */
const BRIDGE_SPORTS: ReadonlySet<string> = new Set(Object.keys(BRIDGEODDS_COVERAGE));

type MarketFamily =
  | "game_line"
  | "ht_line"
  | "team_total"
  | "map_line"
  | "map_period"
  | "corners"
  | "cards"
  | "btts"
  | "other";

/** Classifica a família de mercado da aposta (mercado já pinnacleizado). */
export function marketFamily(
  mercado: string,
  selecao = "",
  esporte?: string | null,
): MarketFamily {
  const combined = normalizeStr(`${mercado} ${selecao}`);
  const period = marketPeriodOf(mercado, esporte);
  const kind = marketKindOf(mercado, selecao);
  if (classificarPropDeJogador({ mercado, selecao, esporte: esporte ?? undefined })) return "other";
  // A cobertura de odds estatísticas exige período medido. Resultado de 2H
  // no FlashScore não comprova preço disponível no mesmo período.
  const oddsStatPeriodSupported = period === "FT" || period === "HT";
  if (/\b(escanteios?|cantos?|corners?)\b/.test(combined)) {
    return oddsStatPeriodSupported ? "corners" : "other";
  }
  if (/\b(cartoes?|carteos?|cartao|cards?|bookings?)\b/.test(combined)) {
    return oddsStatPeriodSupported ? "cards" : "other";
  }
  const isGameLineKind =
    kind === "moneyline" ||
    kind === "total" ||
    kind === "spread" ||
    kind === "draw_no_bet" ||
    kind === "double_chance";
  if (period === "MAP") {
    const isKills = /\b(?:kills?|abates?)\b/.test(normalizeStr(mercado));
    if (isKills && (kind === "total" || kind === "spread")) return "map_line";
    if (kind === "moneyline" || kind === "total" || kind === "spread") return "map_period";
    return "other";
  }
  if (hasNonScoreStatQualifier(mercado, selecao)) return "other";
  // 1H: a Bridge não precifica com FT; a Pinnacle17 usa o período próprio.
  if (period === "HT") {
    return isGameLineKind ? "ht_line" : "other";
  }
  if (period !== "FT") return "other";
  if (kind === "btts") return "btts";
  if (kind === "team_total") return "team_total";
  if (isGameLineKind) return "game_line";
  return "other";
}

/**
 * Mercado cuja unidade é estatística, não o placar agregado. Bridge não
 * pode precificá-lo com game-line FT. Fonte única compartilhada com settlement.
 */
export function isStatQualifierMarket(mercado: string, selecao = ""): boolean {
  return hasNonScoreStatQualifier(mercado, selecao);
}

type SharpCoverageInput = {
  esporte: string;
  mercado: string;
  selecao?: string;
};

/**
 * Matriz comprovada da BridgeOdds: esporte do contrato, jogo inteiro (FT) no
 * mercado e na seleção, mercado de placar (sem estatística nem unidade
 * trocada) e família listada no contrato. Só nela a BridgeOdds dá preço; fora
 * dela, dá só identidade.
 */
export function bridgeOddsIsAuthoritative(params: SharpCoverageInput): boolean {
  const contract = bridgeOddsSportContract(params.esporte);
  if (!contract) return false;
  if (
    isMercadoFinal(params.mercado) &&
    !isMercadoFinalForSport(params.mercado, params.esporte)
  ) {
    return false;
  }
  if (!bridgeOddsSupportsScope(params.esporte, params.mercado, params.selecao)) return false;
  if (hasScoreUnitMismatch(params.mercado, params.selecao ?? "", params.esporte)) return false;
  if (isStatQualifierMarket(params.mercado, params.selecao ?? "")) return false;
  const kind = marketKindOf(params.mercado, params.selecao ?? "") as BridgeOddsMarketKind | string;
  return (contract.marketKinds as readonly string[]).includes(kind);
}

const SEM_REFERENCIA_SHARP = new Set([
  "soccer|total (shots) – match",
  "soccer|team total (shots) – match",
]);

/** Mercado em que a referência sharp do produto não oferece preço por definição. */
export function marketHasNoSharpReference(params: {
  esporte: string;
  mercado: string;
}): boolean {
  return SEM_REFERENCIA_SHARP.has(
    `${normalizeStr(params.esporte)}|${normalizeStr(params.mercado)}`,
  );
}

/** Pinnacle17 vale pelo contrato de sport IDs; o catálogo não prova mercado. */
export function providerCoversSport(provider: ProviderId, esporte: string): boolean {
  if (provider === "pinnacle17") return pinnacle17SportId(esporte) !== null;
  return BRIDGE_SPORTS.has(esporte.trim().toLowerCase());
}

export function providerCoversBet(
  provider: ProviderId,
  params: SharpCoverageInput,
): boolean {
  if (provider === "bridgeodds") return bridgeOddsIsAuthoritative(params);
  return pinnacle17MarketContract(params) !== null;
}

/**
 * Providers que podem dar a IDENTIDADE da aposta. A lista diz quem entra, não
 * a ordem das tentativas: `sharp-identity.ts` chama a Pinnacle17 primeiro
 * sempre que ela está aqui. Na matriz da BridgeOdds, a Bridge vem na frente da
 * lista porque é ela que, se a Pinnacle17 não achar o jogo, dá identidade e
 * preço.
 */
export function identityProviders(input: SharpCoverageInput): ProviderId[] {
  const hasPrimary = providerCoversSport("pinnacle17", input.esporte);
  if (bridgeOddsIsAuthoritative(input)) {
    return hasPrimary ? ["bridgeodds", "pinnacle17"] : ["bridgeodds"];
  }
  return SHARP_PROVIDER_ORDER.filter((provider) => providerCoversSport(provider, input.esporte));
}

/** Providers que dão PREÇO para a aposta (esporte + família), em ordem de preferência. */
export function oddsProviders(params: SharpCoverageInput): ProviderId[] {
  if (bridgeOddsIsAuthoritative(params)) {
    const list: ProviderId[] = ["bridgeodds"];
    if (providerCoversBet("pinnacle17", params)) list.push("pinnacle17");
    return list;
  }
  return SHARP_PROVIDER_ORDER.filter((p) => providerCoversBet(p, params));
}
