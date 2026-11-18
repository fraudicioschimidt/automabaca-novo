/**
 * Seleções nacionais e países em português para o nome da Pinnacle. As
 * tabelas moram em Rust (`rust/crates/dominio/src/countries.rs`), com o porquê
 * de cada uma, e as competições só lá; aqui chegam as que o TS lê, na mesma
 * ordem.
 */
import dominio from "@automabaca/dominio";

const [nationalTeams, countries, knownCountryKeys] = dominio.countryTables();

export const NATIONAL_TEAMS_PT_EN: Record<string, string> = Object.fromEntries(nationalTeams);

export const CANONICAL_COUNTRY_MAP: Record<string, string> = Object.fromEntries(countries);

/** Os nomes de país sem acento e em caixa baixa (chaves e nomes das tabelas). */
export const KNOWN_COUNTRY_KEYS = new Set(knownCountryKeys);
