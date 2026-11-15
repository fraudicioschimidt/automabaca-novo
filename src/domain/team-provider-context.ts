import { normalizeStr } from "./text";

const COUNTRY_EQUIVALENTS: Record<string, string> = {
  brasil: "brazil",
  brazil: "brazil",
  inglaterra: "england",
  england: "england",
  alemanha: "germany",
  germany: "germany",
  espanha: "spain",
  spain: "spain",
  italia: "italy",
  italy: "italy",
  internacional: "world",
  international: "world",
  world: "world",
  eua: "united states",
  usa: "united states",
  "united states": "united states",
  "czech republic": "czechia",
  czechia: "czechia",
  "south korea": "korea republic",
  "republic of korea": "korea republic",
};

function countryKey(value: string): string {
  const normalized = normalizeStr(value);
  return COUNTRY_EQUIVALENTS[normalized] ?? normalized;
}

function competitionTier(value: string): string | null {
  const match = normalizeStr(value).match(
    /\b(?:serie|liga|league|division)\s+([a-d]|[1-4])\b/,
  );
  return match?.[1] ?? null;
}

/** Palavras que dizem o tipo da competição, não qual ela é. */
const CUP_WORDS = ["copa", "cup", "taca", "pokal", "coppa", "coupe", "beker", "cupen", "kupa"];
const LEAGUE_WORDS = ["liga", "league", "serie", "division"];
const FRIENDLY_WORDS = ["friendly", "friendlies", "amistoso", "amistosos"];
const KIND_WORDS = new Set([...CUP_WORDS, ...LEAGUE_WORDS, ...FRIENDLY_WORDS]);

function competitionWords(value: string): string[] {
  return normalizeStr(value).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Copa, liga ou amistoso pelo nome; null quando o nome não diz ("Bundesliga", "Eredivisie"). */
function competitionKind(value: string): "cup" | "league" | "friendly" | null {
  const tokens = new Set(competitionWords(value));
  if (CUP_WORDS.some((token) => tokens.has(token))) return "cup";
  if (LEAGUE_WORDS.some((token) => tokens.has(token))) return "league";
  if (FRIENDLY_WORDS.some((token) => tokens.has(token))) return "friendly";
  return null;
}

/** Nome que só diz o tipo da competição ("Cup", "Liga"): não identifica nenhuma. */
export function isGenericCompetition(value: string): boolean {
  const words = competitionWords(value);
  return words.length > 0 && words.every((word) => KIND_WORDS.has(word));
}

/**
 * Confederações/regiões que o feed declara como "país" do torneio quando o
 * evento é continental ou internacional (Champions League, Leagues Cup,
 * amistoso de seleções). São compatíveis com QUALQUER nação — um clube mexicano
 * joga a Leagues Cup (NORTH & CENTRAL AMERICA) e um finlandês a Europa League
 * (EUROPE). Compará-las com o país do clube produziria conflito falso nos
 * caminhos que têm a aposta para confirmar o jogo.
 */
const REGIOES_E_CONFEDERACOES = new Set(
  [
    "world", "internacional", "international",
    "europe", "asia", "africa", "oceania",
    "north & central america", "south america", "australia & oceania",
    "concacaf", "conmebol", "uefa", "afc", "caf", "ofc", "fifa",
    "not specified",
  ].map(normalizeStr),
);

/** true quando o valor é uma região/confederação, não uma nação específica. */
export function isRegiaoOuConfederacao(value: string): boolean {
  return REGIOES_E_CONFEDERACOES.has(normalizeStr(value));
}

/**
 * Detecta contradição clara entre dois PAÍSES sem transformar região, tradução
 * ou contexto ausente em veto. Resolução e aprendizado precisam compartilhar
 * exatamente a mesma regra: aceitar um alias que o aprendizado recusaria faz a
 * identidade errada voltar a contaminar a busca pelo caminho de leitura.
 */
export function hasTeamProviderCountryConflict(params: {
  expectedCountry: string;
  providerCountry?: string | null;
}): boolean {
  const providerCountry = params.providerCountry?.trim();
  const expectedCountry = params.expectedCountry.trim();
  return Boolean(
    providerCountry &&
      expectedCountry &&
      !isRegiaoOuConfederacao(providerCountry) &&
      !isRegiaoOuConfederacao(expectedCountry) &&
      countryKey(providerCountry) !== countryKey(expectedCountry),
  );
}

/** Detecta somente contradições claras; contexto ausente nunca é inventado. */
export function hasTeamProviderContextConflict(params: {
  expectedCountry: string;
  expectedCompetition: string;
  providerCountry?: string | null;
  providerCompetition?: string | null;
}): boolean {
  if (hasTeamProviderCountryConflict(params)) {
    return true;
  }
  const providerCompetition = params.providerCompetition?.trim();
  if (!providerCompetition || !params.expectedCompetition) return false;
  const expectedTier = competitionTier(params.expectedCompetition);
  const providerTier = competitionTier(providerCompetition);
  if (expectedTier && providerTier && expectedTier !== providerTier) return true;
  const expectedKind = competitionKind(params.expectedCompetition);
  const providerKind = competitionKind(providerCompetition);
  return Boolean(
    expectedKind &&
      providerKind &&
      expectedKind !== providerKind &&
      expectedKind !== "friendly" &&
      providerKind !== "friendly",
  );
}
