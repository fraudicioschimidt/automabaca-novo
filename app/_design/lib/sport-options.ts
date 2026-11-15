import { SPORTS_REGISTRY } from "@/src/domain/sports/registry";
import { UNKNOWN_SPORT, UNKNOWN_SPORT_LABEL } from "@/src/domain/sports/detect";

/**
 * Opções do seletor de modalidade do cadastro manual, DERIVADAS do registro do
 * domínio (`src/domain/sports/registry.ts`): uma lista escrita à mão ofereceria
 * modalidade que `canonicalSport` não conhece, e a server action recusaria.
 *
 * `value` é o que vai para `Bet.esporte` (EN, convenção do schema); `label` é o
 * que o operador lê (PT-BR).
 */
export const SPORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  SPORTS_REGISTRY.map((entry) => ({
    value: entry.canonical,
    label: entry.labelPt,
  })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));

const LABEL_BY_SPORT = new Map([
  ...SPORT_OPTIONS.map((o) => [o.value, o.label] as const),
  [UNKNOWN_SPORT, UNKNOWN_SPORT_LABEL] as const,
]);

/** Nome em português do esporte gravado; fora do registro, o valor cru. */
export function sportLabel(sport: string): string {
  return LABEL_BY_SPORT.get(sport) ?? sport;
}
