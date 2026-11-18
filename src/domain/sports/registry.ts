/**
 * Registro das modalidades: lookup do nome canônico e os sinais que a detecção
 * usa. A regra mora em Rust (`rust/crates/dominio/src/sports/registry.rs`); os
 * dados, em `registry-data.json`.
 */
import dominio from "@automabaca/dominio";
import type { UnidadeDoPlacar } from "./types";
import { SPORTS_REGISTRY } from "@/src/domain/sports/registry-data";

export type { UnidadeDoPlacar };
export { SPORTS_REGISTRY } from "@/src/domain/sports/registry-data";

export type CanonicalSport = (typeof SPORTS_REGISTRY)[number]["canonical"];

/** Lista canônica — DERIVADA; nunca escrever à mão em outro lugar. */
export const CANONICAL_SPORTS: readonly CanonicalSport[] = SPORTS_REGISTRY.map(
  (entry) => entry.canonical,
);

/** O nome canônico de um esporte já escrito (canônico ou alias, sem acento, caixa ou espaço). */
export function canonicalSport(value: string | null | undefined): CanonicalSport | null {
  return dominio.canonicalSport(value) as CanonicalSport | null;
}

export const EMOJI_SIGNALS: ReadonlyArray<readonly [string, CanonicalSport]> =
  SPORTS_REGISTRY.flatMap((entry) =>
    entry.emojis.map((emoji) => [emoji, entry.canonical] as const),
  );

export const TEXT_SIGNALS: ReadonlyArray<readonly [RegExp, CanonicalSport]> =
  SPORTS_REGISTRY.flatMap((entry) =>
    entry.texto ? [[entry.texto, entry.canonical] as const] : [],
  );

export const COMPETITION_SIGNALS: ReadonlyArray<readonly [RegExp, CanonicalSport]> =
  SPORTS_REGISTRY.flatMap((entry) =>
    entry.competicoes ? [[entry.competicoes, entry.canonical] as const] : [],
  );

/**
 * Nomes (canônico + aliases, normalizados COM espaço) das modalidades em que a
 * unidade dada é o placar. `SCORE_UNIT_RULES` casa esses termos por palavra
 * contra `Bet.esporte`, então aqui o espaço importa.
 */
export function esportesComUnidade(unidade: UnidadeDoPlacar): string[] {
  return dominio.esportesComUnidade(unidade);
}

/**
 * Termos de unidade que NUNCA liquidam por placar, derivados das modalidades
 * que o sistema modela (o porquê de cada unidade está no Rust).
 */
export function termosDeUnidadeSemPlacar(): string[] {
  return dominio.termosDeUnidadeSemPlacar();
}
