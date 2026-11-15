import { CANONICAL_COUNTRY_MAP, canonicalCountry, NATIONAL_TEAMS_PT_EN } from "./national-teams";
import { isGenericCompetition, isRegiaoOuConfederacao } from "./team-provider-context";
import { canonicalizeTeamName, isProtectedToken, normalizeStr, TEAM_STOP_WORDS } from "./text";

/**
 * Que texto pode ser alias de time: a grafia que o tipster ou o provider usa
 * para UM clube. Decide só se o nome é GRAVADO como alias e se TRADUZ; nunca
 * se um jogo casa: o nome recusado continua sendo buscado como veio.
 *
 * - Texto que não nomeia clube nenhum é sempre recusado: vaga ("a definir",
 *   "Time 1"), dois times ("A vs B", "Grêmio & Flamengo"), a seleção da aposta
 *   ("Flamengo ML", "Over 2.5", "Flamengo (-1)") e o nome cortado
 *   ("Deportes...").
 * - O texto do tipster só de palavras genéricas ("Sporting", "Wanderers",
 *   "Estudiantes") só identifica o clube dentro de um país e de uma
 *   competição. O nome do provider e o alias MANUAL ou PROMOTED não caem aqui:
 *   "Racing Club" e "D.C. United" são como o provider chama o clube.
 * - Nome que é exatamente um país só vale para a seleção desse país: "China"
 *   levando ao South China é recusado; "Brasil de Pelotas" é outro nome.
 */
export type TeamAliasNameProblem =
  /** Nada que nomeie um clube: vazio, só "FC", número, letra solta ou categoria. */
  | "empty"
  /** Vaga ou time ainda não definido: "a definir", "desconhecido", "Time 1", "Casa". */
  | "placeholder"
  /** Dois times, não um: "A vs B", "A x B", "A & B", "A / B", "A - B". */
  | "fixture"
  /** Nome cortado com reticências. */
  | "ellipsis"
  /** A seleção da aposta, não o time: "Flamengo ML", "Over 2.5", "Flamengo -1", "@1.85". */
  | "market"
  /** Só palavras genéricas de clube, sem país e competição que digam qual é. */
  | "generic"
  /** Exatamente um país, levando a um time que não é a seleção dele. */
  | "country";

export type TeamAliasNameScope = {
  /** País do contexto: o da aposta, na tradução; o do alias, na gravação. */
  country?: string | null;
  /** Competição do contexto, como o país. */
  competition?: string | null;
  /** O time a que o nome leva: o nome canônico da identidade ou a grafia do outro lado do par. */
  target: string;
  /** Quem escreveu o nome: o tipster (alias LOCAL, o nome de entrada) ou o provider. */
  author: "tipster" | "provider";
  /** Origem do alias, quando ele já existe ou vai ser gravado: MANUAL e PROMOTED não caem na regra de genérico. */
  source?: string | null;
};

/**
 * Palavras que só identificam o clube com país e competição: sozinhas nomeiam
 * dezenas de clubes ("Estudiantes" é de La Plata, de Río Cuarto, de Mérida).
 */
const GENERIC_CLUB_WORDS = new Set([
  "real", "sporting", "atletico", "athletic", "deportivo", "deportiva", "deportes",
  "sport", "sports", "esporte", "esportes", "esportivo",
  "united", "city", "town", "nacional", "national", "inter", "independiente",
  "universidad", "universitario", "union", "racing", "olimpia", "olympic", "olympique",
  "rangers", "rovers", "wanderers", "estudiantes", "dynamo", "dinamo", "america",
]);

/** Palavras que não nomeiam nada: artigos, preposições e siglas de tipo de clube. */
const EMPTY_WORDS = new Set([
  ...[...TEAM_STOP_WORDS].filter((word) => !GENERIC_CLUB_WORDS.has(word)),
  "the", "of", "di", "del", "du", "des", "und", "et", "y",
]);

/** Marca de time ainda não definido, em qualquer posição do nome. */
const UNKNOWN_MARKERS = new Set([
  "desconhecido", "desconhecida", "desconocido", "desconocida", "unknown",
  "tbd", "tba", "tbc", "indefinido", "indefinida", "definir", "confirmar",
  "determined", "announced", "null", "undefined", "none", "nenhum", "nenhuma",
  "vencedor", "vencedora", "winner", "perdedor", "perdedora", "loser", "qualquer",
]);

/** Papel no jogo, não nome: o nome inteiro só com elas é uma vaga. */
const ROLE_WORDS = new Set([
  "time", "times", "casa", "fora", "mandante", "visitante", "home", "away",
  "host", "hosts", "guest", "guests", "visitor", "visitors", "equipe", "team",
  "jogador", "player", "adversario", "oponente", "opponent", "outro", "other",
]);

/**
 * Palavras de mercado. Só valem na ponta do texto, formando a seleção com o
 * nome ("Flamengo ML", "Over 2.5"): "Odd" (clube norueguês) e "Total" ficam de
 * fora porque só aparecem na seleção junto de uma linha, que já a denuncia.
 */
const MARKET_WORDS = new Set([
  "over", "under", "handicap", "hcp", "ah", "moneyline", "ml", "dnb", "btts",
  "ambas", "empate", "draw", "mais", "menos", "acima", "abaixo", "gols", "goals",
  "pontos", "points", "escanteios", "corners", "cartoes", "cards",
  "stake", "unidade", "unidades", "units", "asiatico", "asian", "win", "vence", "vencer",
]);

/** O que acompanha o nome do país sem mudar de seleção: "China PR", "Brazil National Team". */
const NATIONAL_TEAM_QUALIFIERS = new Set(["pr", "national", "team", "nt", "selecao", "seleccion", "men", "mens"]);

/**
 * Chaves dos mapas de país que não são país: regiões, siglas de duas letras,
 * "New England" (clube da MLS) e grafias que só aparecem dentro de outro nome.
 */
const NOT_COUNTRIES = new Set([
  "nova inglaterra", "new england", "paises", "inglesa", "world", "mundo",
  "international", "internacional", "not specified", "nao especificado",
  "europe", "europa", "south america", "america do sul", "bra", "kor",
]);

const COUNTRY_NAMES = new Set(
  [
    ...Object.entries(NATIONAL_TEAMS_PT_EN).flat(),
    ...Object.entries(CANONICAL_COUNTRY_MAP).flat(),
  ]
    .map((name) => canonicalizeTeamName(name))
    .filter((name) => name.length > 2 && !NOT_COUNTRIES.has(name)),
);

/**
 * O que separa dois times num texto, na ordem de força: o delimitador do
 * evento ("vs", "x", "v", o hífen com espaços), a barra e os conectores ("&",
 * "and", "e", "+"). O "+" seguido de número é linha, não conector.
 */
const PAIR_SEPARATORS: readonly RegExp[] = [
  /\s+(?:vs\.?|versus)\s+/i,
  /\s+[xv]\.?\s+/i,
  /\s+[-–—]\s+/,
  /\s*\/\s*/,
  /\s*&\s*/,
  /\s+(?:and|e)\s+/i,
  /\s*\+\s*(?=[^\d\s])/,
];

/** Número de categoria ("Sub-20", "U-23", "Under 21"): não é linha de aposta. */
const CATEGORY_NUMBER = /\b(?:sub|under|u)\s*-?\s*\d{2}\b/gi;

type TokenKind = "distinctive" | "generic" | "neutral";

/**
 * Dígito, letra solta, categoria ("u20", "women", "b") e palavra vazia não
 * distinguem clube. Duas letras já distinguem: AZ, FH e KR são clubes.
 */
function tokenKind(token: string): TokenKind {
  if (GENERIC_CLUB_WORDS.has(token)) return "generic";
  if (EMPTY_WORDS.has(token) || isProtectedToken(token) || /^\d+$/.test(token) || token.length === 1) {
    return "neutral";
  }
  return "distinctive";
}

function tokensOf(name: string): string[] {
  return canonicalizeTeamName(name).split(" ").filter(Boolean);
}

/** Parte do texto que pode ser um time: ao menos duas letras ou dígitos. */
function nameLike(part: string): boolean {
  return canonicalizeTeamName(part).replace(/\s/g, "").length >= 2;
}

/** As duas partes, quando algum separador divide o texto em dois nomes. */
function splitPair(name: string): readonly [string, string] | null {
  const compact = name.replace(/\s+/g, " ").trim();
  for (const separator of PAIR_SEPARATORS) {
    const match = separator.exec(compact);
    if (!match) continue;
    const left = compact.slice(0, match.index);
    const right = compact.slice(match.index + match[0].length);
    if (nameLike(left) && nameLike(right)) return [left, right];
  }
  return null;
}

/**
 * A palavra está no nome do clube. O prefixo de 3 letras cobre a letra que a
 * normalização perde ("Bodø" vira "bod"; o provider escreve "Bodo").
 */
function inClubName(token: string, clubTokens: readonly string[]): boolean {
  return clubTokens.some((clubToken) => clubToken === token
    || (Math.min(clubToken.length, token.length) >= 3 && (clubToken.startsWith(token) || token.startsWith(clubToken))));
}

/**
 * Dois times, a não ser que as duas partes sejam o nome do próprio clube de
 * destino: "Bodo/Glimt", "Trinidad and Tobago" e "Brighton & Hove Albion"
 * levando a eles mesmos são um clube só; "Grêmio & Flamengo" levando ao
 * Grêmio são dois.
 */
function isFixture(name: string, target: string): boolean {
  const pair = splitPair(name);
  if (!pair) return false;
  const [left, right] = pair;
  // "Atlético/GO" é a sigla do estado colada no nome, não um segundo time; em
  // "Flamengo vs Vila Nova/GO" quem divide é o "vs".
  if (/\S\/[a-z]{2}\s*$/i.test(name) && /^[a-z]{2}$/i.test(right.trim()) && !splitPair(left)) return false;
  const clubTokens = tokensOf(target);
  return !pair.every((part) => tokensOf(part).every((token) => inClubName(token, clubTokens)));
}

/** A linha da aposta: odd, handicap colado ou não, unidade de stake. */
function hasBetLine(raw: string, tokens: readonly string[]): boolean {
  const text = raw.replace(CATEGORY_NUMBER, " ");
  return /\d[.,]\d/.test(text)
    || text.includes("@")
    || /[+\-−–]\s?\d/.test(text)
    || tokens.some((token) => /^\d+u$/.test(token));
}

/** Palavra de mercado na ponta do texto: o nome com o mercado ("Flamengo ML") ou só o mercado ("Empate"). */
function isSelection(tokens: readonly string[]): boolean {
  const named = tokens.filter((token) => tokenKind(token) !== "neutral");
  const first = named[0];
  const last = named.at(-1);
  return (first !== undefined && MARKET_WORDS.has(first)) || (last !== undefined && MARKET_WORDS.has(last));
}

function isPlaceholder(tokens: readonly string[]): boolean {
  if (tokens.some((token) => UNKNOWN_MARKERS.has(token))) return true;
  const named = tokens.filter((token) => tokenKind(token) !== "neutral" || ROLE_WORDS.has(token));
  return named.length > 0 && named.every((token) => ROLE_WORDS.has(token));
}

/** País específico e competição que diz qual é: o que torna "Sporting" um clube só. */
function hasSpecificScope(scope: TeamAliasNameScope): boolean {
  const country = scope.country?.trim() ?? "";
  const competition = scope.competition?.trim() ?? "";
  return country !== "" && !isRegiaoOuConfederacao(country)
    && competition !== "" && !isGenericCompetition(competition);
}

/**
 * O país que o nome é, por igualdade exata depois de tirar a categoria e o
 * qualificador de seleção ("Brazil U20", "China PR"); null quando não é.
 */
function countryOf(tokens: readonly string[]): string | null {
  const key = tokens
    .filter((token) => !isProtectedToken(token) && !NATIONAL_TEAM_QUALIFIERS.has(token))
    .join(" ");
  return COUNTRY_NAMES.has(key) ? canonicalCountry(key) : null;
}

/** A seleção que o nome de time é ("Brazil U20", "China PR", "Alemanha"), pela tabela fixa; null quando não é. */
export function nationalTeamCountry(name: string): string | null {
  return countryOf(tokensOf(name));
}

/**
 * Por que `name` não pode ser alias do time `scope.target`; null quando pode.
 * Recebe o nome como veio (o tipster, o provider): a barra, o "&" e a linha
 * somem na canonicalização, então olhar só a forma normalizada deixaria
 * passar "Grêmio / Flamengo" e "Flamengo -1.5".
 */
export function teamAliasNameProblem(name: string, scope: TeamAliasNameScope): TeamAliasNameProblem | null {
  const raw = normalizeStr(name).replace(/\s+/g, " ");
  const tokens = tokensOf(name);
  if (tokens.length === 0) return "empty";
  if (/\.\.|…/.test(raw)) return "ellipsis";
  if (isFixture(name, scope.target)) return "fixture";
  if (hasBetLine(raw, tokens) || isSelection(tokens)) return "market";
  if (isPlaceholder(tokens)) return "placeholder";
  const kinds = tokens.map(tokenKind);
  if (!kinds.includes("distinctive") && !kinds.includes("generic")) return "empty";
  const trusted = scope.source === "MANUAL" || scope.source === "PROMOTED";
  if (scope.author === "tipster" && !trusted && !kinds.includes("distinctive") && !hasSpecificScope(scope)) {
    return "generic";
  }
  const country = countryOf(tokens);
  if (country && country !== countryOf(tokensOf(scope.target))) return "country";
  return null;
}
