import { canonicalizeBookmakerName } from "@/src/domain/bookmaker";
import type { PlayerPropFamily } from "./player-prop-classify";
import { chaveDaProp, valorDaProp } from "./player-prop-classify";
import { hasUnsupportedPlayerPropQualifier, type PlayerPropTerms } from "./player-prop-terms";
import type { JogadorDaPartida } from "./goalscorer-matching";
import { statusFromAdjustedQuarters } from "./lines";

export const PLAYER_PROP_RULE_VERSION = "2026-09-08.1";
export type PlayerPropRule = {
  version: string;
  bookmaker: string;
  family: PlayerPropFamily;
  scope: "REGULATION" | "INCLUDING_EXTRA_TIME";
  participation: "STARTER" | "UNKNOWN";
  verified: boolean;
  source: string;
};

/** Snapshot once at capture. A future rule update must not rewrite old contracts. */
export function playerPropRule(bookmaker: string, family: PlayerPropFamily): PlayerPropRule {
  const brand = canonicalizeBookmakerName(bookmaker);
  const supported = !["cards_any", "cards_yellow", "cards_red", "tackles_won", "passes_completed", "interceptions", "key_passes", "offsides"].includes(family);
  return {
    version: PLAYER_PROP_RULE_VERSION,
    bookmaker: brand,
    family,
    scope: brand === "Bet365" ? "INCLUDING_EXTRA_TIME" : "REGULATION",
    participation: ["Bet365", "KTO", "Betano"].includes(brand) ? "STARTER" : "UNKNOWN",
    // Official football player-stat rules (`source`), verified as of PLAYER_PROP_RULE_VERSION.
    verified: ["Bet365", "KTO", "Betano"].includes(brand) && supported,
    source: brand === "Bet365"
      ? "https://help.bet365.bet.br/s/pt-br/sportsrules/soccer/match-statistics"
      : brand === "Betano"
        ? "https://support.betano.bet.br/hc/pt-br/articles/19504884778525"
        : brand === "KTO" ? "https://www.kto.bet.br/regras-esporte/" : "",
  };
}

export function decidePlayerProp(params: {
  terms: PlayerPropTerms; rule: PlayerPropRule; player: JogadorDaPartida;
  extraTime: boolean; verifiedKeys: readonly string[]; preMatch: boolean;
  competition?: string;
}) {
  const { terms, rule, player } = params;
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (terms.unsupportedReason) return refuse(terms.unsupportedReason);
  if (hasUnsupportedPlayerPropQualifier(terms.mercadoOriginal, terms.selecaoOriginal)) return refuse("qualificador_ou_combinacao_sem_contrato");
  if (/\b(?:kings|queens|baller|futsal|soccer ?[567])\b/i.test(params.competition ?? "")) return refuse("regra_da_competicao_nao_comprovada");
  if (rule.family !== terms.family) return refuse("contrato_de_mercado_divergente");
  if (!rule.verified) return refuse("regra_da_casa_nao_comprovada");
  if (!params.preMatch) return refuse("regra_ao_vivo_nao_comprovada");
  if (terms.period !== "FT") return refuse("periodo_nao_suportado");
  if (params.extraTime && rule.scope === "REGULATION") return refuse("estatistica_de_90_minutos_indisponivel");
  if (rule.participation === "STARTER") {
    if (player.titular == null) return refuse("titularidade_nao_comprovada");
    if (!player.titular) return { ok: true as const, status: "VOID" as const, value: null, key: null };
  }
  if (terms.substituicao !== "ABSENT" && player.substituido !== false) return refuse("regra_de_substituicao_pendente");
  if (terms.family.startsWith("cards_")) return refuse("convencao_de_cartoes_ambigua");
  const key = chaveDaProp(terms.family);
  if (!params.verifiedKeys.includes(key)) return refuse("cobertura_nao_validada");
  const value = valorDaProp(terms.family, player.stats ?? {});
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return refuse("stat_ausente");
  if (!player.participou && !(typeof player.minutosJogados === "number" && player.minutosJogados > 0)) return refuse("participacao_nao_comprovada");
  if (terms.lineQuarters == null || !terms.direction) return refuse("linha_ambigua");
  const adjusted = terms.direction === "over" ? 4 * value - terms.lineQuarters : terms.lineQuarters - 4 * value;
  return { ok: true as const, status: statusFromAdjustedQuarters(adjusted), value, key };
}

export const PLAYER_PROP_STABILITY_MS = 10 * 60_000;
export const PLAYER_PROP_GRACE_MS = 6 * 3_600_000;

export function playerPropRetryDelay(elapsedMs: number): number {
  return elapsedMs < 30 * 60_000 ? 10 * 60_000 : elapsedMs < 2 * 3_600_000 ? 30 * 60_000 : 60 * 60_000;
}
