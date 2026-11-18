/**
 * Tradução de seleções, países e competições para o nome da Pinnacle, e a
 * troca do nome do time na seleção. A regra mora em Rust
 * (`rust/crates/dominio/src/national_teams.rs`).
 */
import dominio from "@automabaca/dominio";
import { CANONICAL_COUNTRY_MAP, KNOWN_COUNTRY_KEYS, NATIONAL_TEAMS_PT_EN } from "./countries";

export { CANONICAL_COUNTRY_MAP, KNOWN_COUNTRY_KEYS, NATIONAL_TEAMS_PT_EN };

/** Traduz seleção nacional ou país PT → EN Pinnacle; null se não for nação conhecida. */
export function translateNationalTeamPtToEn(localName: string): string | null {
  return dominio.translateNationalTeamPtToEn(localName);
}

/** Normaliza país para o padrão Pinnacle/EN ("Brasil" -> "Brazil", "Alemanha" -> "Germany", etc.) */
export function canonicalCountry(raw: string): string {
  return dominio.canonicalCountry(raw);
}

/** Normaliza competições para o padrão oficial Pinnacle/EN, sem duplicação de país. */
export function canonicalCompetition(raw: string, pais?: string): string {
  return dominio.canonicalCompetition(raw, pais);
}

/**
 * Substitui nomes de nação PT pelo EN Pinnacle dentro de um texto (seleção).
 * Com os times do jogo, só a nação que é um deles: "Franca", clube de
 * basquete, não vira France, nem "Brasil de Pelotas" vira Brazil.
 */
export function rewriteNationalTeamsInText(text: string, eventTeams?: readonly string[]): string {
  return dominio.rewriteNationalTeamsInText(text, eventTeams);
}

/**
 * Quando a identidade casa, o evento vira "France vs Morocco" mas a seleção
 * ainda pode estar "França -1.0". Sem reescrever, matchTeamSide falha
 * (similaridade PT↔EN ~0.2) e a odd cai em ambiguous_selection.
 */
export function rewriteSelecaoWithMatchedTeams(params: {
  selecao: string;
  localHome: string;
  localAway: string;
  pinnacleHome: string;
  pinnacleAway: string;
}): string {
  return dominio.rewriteSelecaoWithMatchedTeams(
    params.selecao, params.localHome, params.localAway, params.pinnacleHome, params.pinnacleAway,
  );
}
