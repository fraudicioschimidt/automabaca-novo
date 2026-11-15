import { isKnownBookmakerKey } from "@/src/domain/bookmaker";
import { KNOWN_COUNTRY_KEYS } from "@/src/domain/countries";
import { MATCH_SCOPE_NOUNS } from "@/src/domain/mercados/match-scope";
import {
  NON_SCORE_STAT_TERMS,
  hasNonScoreStatQualifier,
  isBothTeamsCardsText,
  scoreQualifierTerms,
} from "@/src/domain/mercados/stat-qualifier";
import { expandAbbreviatedDirection } from "@/src/domain/mercados/total-direction";
import { canonicalCountry } from "@/src/domain/national-teams";
import { tokensDaSelecao } from "@/src/domain/settlement/goalscorer-matching";
import { matchTeamSide } from "@/src/domain/settlement/sides";
import { normalizeStr, splitEventoTeams } from "@/src/domain/text";

const DIRECAO = /\b(?:over|under|mais|menos|acima|abaixo)\b/;

/**
 * Texto à esquerda de over/under na seleção. Sem isso, "Tatum over 10.5" e
 * "Over 10.5" parecem a mesma linha — só o prefixo diz se há um sujeito. A
 * direção abreviada ("Pedro O 0.5") tem o mesmo sujeito.
 */
export function prefixoAntesDaLinha(selecao: string): string | null {
  const n = normalizeStr(expandAbbreviatedDirection(selecao)).replace(/[^a-z0-9]+/g, " ").trim();
  const achado = n.match(new RegExp(`^(.+?)\\s+${DIRECAO.source}`));
  const prefixo = achado?.[1]?.trim();
  if (!prefixo || !/[a-z]/.test(prefixo)) return null;
  return prefixo;
}

/** A seleção que abre pela direção e pela linha ("Over 0.5", "Mais de 2.0,2.5", "U 3.5"). */
const LEADING_LINE =
  /^\W*(?:(?:over|under|mais|menos|acima|abaixo)\s*(?:(?:de|que)\s+)?|(?:ov|un|o|u)\.?\s*(?=\d))\+?\s*\d+(?:[.,]\d+)?(?:\s*[,/]\s*\+?\s*\d+(?:[.,]\d+)?)?/;

/**
 * A estatística depois da linha, pelo vocabulário único de `stat-qualifier`:
 * sai pela frase inteira ("chutes no gol", "double faults", "three pointers"),
 * que palavra a palavra não se reconhece.
 */
const STAT_TERMS = new RegExp(`\\b(?:${NON_SCORE_STAT_TERMS})\\b`, "g");

/** A competição escrita depois da linha: diz onde se joga, nunca quem faz a estatística. */
const COMPETITION_WORDS = [
  "brasileirao", "serie", "liga", "league", "premier", "copa", "cup",
  "nba", "nfl", "nhl", "mlb", "libertadores", "sulamericana", "champions", "europa", "conference",
  "bundesliga", "laliga", "ligue", "eredivisie",
];

/**
 * O país colado à competição ("Copa do Brasil", "Liga de Portugal", "Italy
 * Serie A", "World Cup") também é o lugar. O nome mais longo vem antes, para
 * "Irlanda do Norte" não deixar o "norte" como sujeito; o com hífen fica de
 * fora do padrão, e a grafia com espaço o cobre.
 */
// Chaves da lista de países que também são time ou região de time ("New
// England" dos Patriots, "Georgia" do college, "Internacional"): continuam
// sujeito, e a aposta vai para o dono em vez do total da partida.
const NOT_ONLY_A_COUNTRY = new Set(["new england", "nova inglaterra", "georgia", "internacional", "international"]);
const COUNTRY_NAMES = [...KNOWN_COUNTRY_KEYS]
  .filter((key) => /^[a-z ]+$/.test(key) && !NOT_ONLY_A_COUNTRY.has(key))
  .sort((a, b) => b.length - a.length)
  .join("|");
const COMPETITION = COMPETITION_WORDS.join("|");
const COMPETITION_COUNTRY = new RegExp(
  String.raw`\b(${COMPETITION})\s+(?:(?:de|do|da|of|the)\s+)?(${COUNTRY_NAMES})\b|\b(${COUNTRY_NAMES})\s+(?=(?:${COMPETITION})\b)`,
  "g",
);

/** Todas as grafias de cada país, pelo nome em inglês: "brasil", "brazil" e "bra" são o mesmo. */
const COUNTRY_SPELLINGS = new Map<string, string[]>();
for (const key of KNOWN_COUNTRY_KEYS) {
  const country = canonicalCountry(key);
  COUNTRY_SPELLINGS.set(country, [...(COUNTRY_SPELLINGS.get(country) ?? []), key]);
}

/**
 * No jogo de seleções o país é o time, e o evento pode estar noutra língua
 * ("Over 1.5 Brasil Copa do Mundo" em "Brazil vs Argentina"): tirá-lo
 * liquidaria o total do Brasil pelo total da partida.
 */
function countryNamesEventSide(country: string, evento: string): boolean {
  const eventWords = ` ${normalizeStr(evento).replace(/[^a-z0-9]+/g, " ").trim()} `;
  const spellings = COUNTRY_SPELLINGS.get(canonicalCountry(country)) ?? [country];
  return spellings.some((spelling) => eventWords.includes(` ${spelling} `));
}

/** Tira da seleção o país que só diz onde se joga; o que é um lado do evento fica. */
function withoutCompetitionCountry(rest: string, evento: string): string {
  return rest.replace(
    COMPETITION_COUNTRY,
    (match, competition: string | undefined, countryAfter: string | undefined, countryBefore: string | undefined) => {
      const country = countryAfter ?? countryBefore ?? "";
      if (countryNamesEventSide(country, evento)) return match;
      return competition ? `${competition} ` : " ";
    },
  );
}

/**
 * O resto que também não nomeia quem faz a estatística: a unidade do placar, o
 * complemento da estatística ("chutes certos", "roubos de bola"), o período e o
 * escopo do jogo ("tempo normal", "jogo todo", "ambos os times"), a odd e a stake.
 */
const NOT_A_SUBJECT = new Set([
  ...scoreQualifierTerms(), "goles", "golos", "pts", "game", "round", "rounds",
  ...MATCH_SCOPE_NOUNS, "jogos", "total", "totais", "geral", "full", "time", "ft", "ht",
  "tempo", "tempos", "regulamentar", "regular", "normal", "todo", "toda", "inteiro", "inteira",
  "completo", "completa", "integral", "cheio", "cheia", "pre", "principal", "alternativa", "alternativo",
  "ambos", "ambas", "times", "equipes", "both", "teams", "somados", "combinados", "combined",
  "incluindo", "including", "sem", "prorrogacao", "overtime", "ot", "extra", "prolongamento",
  "primeiro", "primeira", "segundo", "segunda", "first", "second", "half", "metade", "etapa",
  "periodo", "period", "quarto", "quarter", "pt", "st", "min", "minutos", "minutes",
  "certo", "certos", "certas", "enquadrado", "enquadrados", "enquadrada", "enquadradas",
  "bola", "alvo", "target", "baliza", "convertidos", "convertidas", "made",
  "odd", "odds", "stake", "un", "unidade", "unidades", "units", "linha", "line", "mercado", "market",
  "asiatico", "asiatica", "asiaticos", "asiaticas", "asian", "ah", "gls", "vivo", "live", "play",
  "as", "os", "ao", "aos", "no", "na", "nos", "nas", "em", "de", "do", "da", "dos", "das",
  "el", "la", "los", "las", "del", "en", "para", "pro", "por", "com",
  "the", "in", "of", "for", "on", "at", "to", "and", "ou", "or",
  // Quando e onde, que o tipster escreve depois da linha e nunca são o jogador.
  "hoje", "hj", "amanha", "agora", ...COMPETITION_WORDS,
]);

/**
 * Quem vem DEPOIS da linha e não é time do evento: o jogador de "Over 0.5 -
 * Mbappé" ou de "Menos de 27.5 [A'ja Wilson]". Reduzida a "Over 0.5", a prop
 * seria liquidada pelo total da partida. Sem evento, null: o sujeito não se
 * prova alheio.
 */
export function subjectAfterLine(selecao: string, evento?: string): string | null {
  if (!evento) return null;
  const n = normalizeStr(expandAbbreviatedDirection(selecao));
  const line = n.match(LEADING_LINE);
  if (!line) return null;
  const rest = n.slice(line[0].length);
  // Outra direção adiante: o começo era a categoria do time ("U23 Sporting Over 1.5").
  if (DIRECAO.test(rest)) return null;
  const subject = withoutCompetitionCountry(rest, evento).replace(STAT_TERMS, " ").split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !/\d/.test(token) && !NOT_A_SUBJECT.has(token) && !isKnownBookmakerKey(token))
    .join(" ");
  if (!subject || matchTeamSide(subject, evento) !== null || prefixoMencionaTimeDoEvento(subject, evento)) return null;
  return subject;
}

/** "Jogo O 2.5", "FT Over 2.5": o escopo na frente da linha é o próprio jogo, não um sujeito. */
const MATCH_SCOPE_PREFIX = new RegExp(`^(?:${[...MATCH_SCOPE_NOUNS, "game", "ft", "full time"].join("|")})$`);

/**
 * Sujeito da linha O/U (antes ou depois dela) que não é time: liquidar pela
 * estatística ou pelo placar da partida responderia outra aposta.
 * Sem evento o sujeito não se prova alheio e a guarda não dispara.
 */
export function lineSubjectIsNotEventTeam(
  selecao: string,
  evento?: string,
): boolean {
  if (subjectAfterLine(selecao, evento)) return true;
  const prefixo = prefixoAntesDaLinha(selecao);
  if (!prefixo || MATCH_SCOPE_PREFIX.test(prefixo)) return false;
  if (isBothTeamsCardsText(selecao)) return false;
  if (hasNonScoreStatQualifier(prefixo, "")) return false;
  if (tokensDaSelecao(prefixo).length === 0) return false;
  if (!evento) return false;
  if (matchTeamSide(prefixo, evento) !== null) return false;
  // Prefixo que cita um lado do evento não é atleta — ambíguo fica no time-total.
  if (prefixoMencionaTimeDoEvento(prefixo, evento)) return false;
  return true;
}

function prefixoMencionaTimeDoEvento(prefixo: string, evento: string): boolean {
  const times = splitEventoTeams(evento);
  if (!times) return false;
  const p = ` ${normalizeStr(prefixo)} `;
  return [times.home, times.away].some((time) => {
    const n = normalizeStr(time);
    return n.length > 0 && p.includes(` ${n} `);
  });
}
