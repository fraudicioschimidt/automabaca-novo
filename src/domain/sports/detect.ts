import { normalizeStr } from "@/src/domain/text";
import {
  canonicalSport,
  COMPETITION_SIGNALS,
  EMOJI_SIGNALS,
  TEXT_SIGNALS,
  type CanonicalSport,
} from "./registry";

export const UNKNOWN_SPORT = "Unknown";
/** O nome que o painel mostra para `UNKNOWN_SPORT`: a aposta espera o esporte ser confirmado. */
export const UNKNOWN_SPORT_LABEL = "A confirmar";
/**
 * Sobe a cada mudança de COMPORTAMENTO do resolvedor — é por ela que apostas
 * antigas podem ser reavaliadas.
 */
export const SPORT_RESOLVER_VERSION = 19;
/**
 * Confirmação sem revisão, na captura e no resolvedor: evidência de 90 ou
 * mais para um esporte e nenhum outro esporte a partir de
 * `SPORT_DISSENT_MIN_CONFIDENCE` (`chooseSportCandidate`).
 */
export const SPORT_AUTO_CONFIRM_MIN_CONFIDENCE = 90;
/** A partir daqui, a evidência de outro esporte segura a confirmação automática. */
export const SPORT_DISSENT_MIN_CONFIDENCE = 70;

export type SportResolutionStatus = "CONFIRMED" | "PENDING" | "CONFLICT";
export type SportResolutionSource =
  | "LEGACY"
  | "TEXT"
  | "EMOJI"
  | "COMPETITION"
  | "LLM"
  | "TEAM_ID"
  | "PROVIDER"
  | "WEB"
  | "MANUAL"
  | "CHANNEL"
  | "UNRESOLVED";

export type SportEvidence = {
  source: SportResolutionSource;
  sport: CanonicalSport;
  confidence: number;
  value: string;
};

export type SportResolutionDecision = {
  sport: CanonicalSport | null;
  status: SportResolutionStatus;
  confidence: number;
  source: SportResolutionSource;
  evidence: SportEvidence[];
  resolverVersion: number;
};

/**
 * Desambiguação entre modalidades que compartilham palavra.
 *
 * A lista NÃO encolheu quando handebol, futsal, rugby, dardos e snooker
 * ganharam contrato próprio, e isso é de propósito: o guarda serve para impedir
 * que o sinal de FUTEBOL dispare, não para impedir a modalidade de existir.
 * "Champions League de handebol" precisa continuar sendo handebol — sem o
 * guarda, o padrão de competição promoveria Soccer, o texto promoveria
 * Handball, e as duas evidências juntas dariam CONFLICT em vez de resposta.
 */
const UNSUPPORTED_SOCCER_CONTEXT =
  /\b(?:futsal|beach soccer|futebol de areia|futebol society|society|fut\s*7|futebol australiano|australian football|australian rules|futebol gaelico|gaelic football|virtual soccer|soccer virtual|futebol virtual|handball|handebol|water polo|polo aquatico|rugby|darts?|dardos|sinuca|snooker)\b/;
const UNSUPPORTED_BASKETBALL_CONTEXT =
  /\b(?:3\s*[x×]\s*3|virtual basketball|basketball virtual|basquete virtual)\b/;
const UNSUPPORTED_TENNIS_CONTEXT =
  /\b(?:table tennis|tenis de mesa|ping pong|wheelchair tennis|tenis (?:em )?cadeira de rodas|virtual tennis|tennis virtual|tenis virtual)\b/;
const UNSUPPORTED_VOLLEYBALL_CONTEXT = /\b(?:beach volleyball|volei de praia)\b/;
const UNSUPPORTED_HOCKEY_CONTEXT =
  /\b(?:field hockey|grass hockey|hockey (?:sobre|de) grama|hoquei (?:sobre|de) grama|hoquei (?:em|sobre|de) patins|roller hockey|rink hockey)\b/;
const CLUB_NAME_HOCKEY_CONTEXT = /\b(?:hockey|hoquei)\s+(?:club|clube)\b/;
/**
 * Nomes de liga de futebol que basquete, vôlei, handebol e dardos também usam
 * ("🏀 Serie A", "🤾 Champions League", "Basquete Bundesliga", "Premier
 * League" dos dardos): sozinhos, não provam o futebol.
 */
export const SHARED_SOCCER_LEAGUE = /^(?:champions league|premier league|serie [abcd]|la liga|bundesliga)$/;

function hasUnsupportedVariant(sport: CanonicalSport, normalized: string): boolean {
  switch (sport) {
    case "Soccer":
      return UNSUPPORTED_SOCCER_CONTEXT.test(normalized);
    case "Basketball":
      return UNSUPPORTED_BASKETBALL_CONTEXT.test(normalized);
    case "Tennis":
      return UNSUPPORTED_TENNIS_CONTEXT.test(normalized);
    case "Volleyball":
      return UNSUPPORTED_VOLLEYBALL_CONTEXT.test(normalized);
    case "Hockey":
      return (
        UNSUPPORTED_HOCKEY_CONTEXT.test(normalized) ||
        CLUB_NAME_HOCKEY_CONTEXT.test(normalized)
      );
    default:
      return false;
  }
}

export function unresolvedSportDecision(
  status: Extract<SportResolutionStatus, "PENDING" | "CONFLICT"> = "PENDING",
  evidence: SportEvidence[] = [],
): SportResolutionDecision {
  return {
    sport: null,
    status,
    confidence: evidence.reduce((best, item) => Math.max(best, item.confidence), 0),
    source: "UNRESOLVED",
    evidence,
    resolverVersion: SPORT_RESOLVER_VERSION,
  };
}

export function confirmedSportDecision(
  sport: CanonicalSport,
  source: SportResolutionSource,
  confidence: number,
  evidence: SportEvidence[],
): SportResolutionDecision {
  return {
    sport,
    status: "CONFIRMED",
    confidence,
    source,
    evidence,
    resolverVersion: SPORT_RESOLVER_VERSION,
  };
}

function allTerms(pattern: RegExp, normalized: string): string[] {
  return [...normalized.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))].map(([term]) => term);
}

/** O esporte que a IA leu no item, mesmo quando o texto a desmentiu. */
export function llmReadSport(decision: Pick<SportResolutionDecision, "evidence"> | null | undefined): CanonicalSport | null {
  return decision?.evidence.find((item) => item.source === "LLM")?.sport ?? null;
}

/** O emoji ou o nome da modalidade. Estatística ("3 pontos") aparece em post de futebol. */
function namesSport(item: SportEvidence): boolean {
  return item.source === "EMOJI" || (item.source === "TEXT" && canonicalSport(item.value) === item.sport);
}

/**
 * A liga de futebol do texto, a só do futebol antes da compartilhada. No
 * lote, a legenda inteira do post entra para cada item, e o emoji ou o nome
 * de outra modalidade pode ser de outro jogo: só a leitura do próprio item
 * decide.
 * - Lido como outra modalidade: a liga compartilhada cede, mesmo sem o nome
 *   dela no texto ("Serie A" + total de pontos lido como basquete); quem
 *   acha o jogo decide.
 * - Lido como futebol, ou sem leitura: com outra modalidade no texto, a
 *   palavra dela só segura a liga na mesma linha ("Lega Basket Serie A"), e o
 *   post misto fica em conflito. Sem leitura, a Champions League ainda cede
 *   à modalidade nomeada ("🤾 Europe - Champions League").
 */
function soccerCompetitionTerm(params: {
  pattern: RegExp;
  normalized: string;
  otherSportInText: boolean;
  namedSports: ReadonlySet<CanonicalSport>;
  itemSport: CanonicalSport | null | undefined;
}): string | undefined {
  const { pattern, normalized, itemSport } = params;
  if (itemSport && itemSport !== "Soccer") {
    return allTerms(pattern, normalized).find((term) => !SHARED_SOCCER_LEAGUE.test(term));
  }
  const found = params.otherSportInText
    ? normalized.split("\n").flatMap((line) => allTerms(pattern, line))
    : allTerms(pattern, normalized);
  const terms = !itemSport && params.namedSports.size > 0 ? found.filter((term) => term !== "champions league") : found;
  return terms.find((term) => !SHARED_SOCCER_LEAGUE.test(term)) ?? terms[0];
}

type SportTextOptions = {
  /** O esporte em que a leitura do próprio item (a IA) pôs a aposta (`llmReadSport`). */
  itemSport?: CanonicalSport | null;
};

export function detectSportFromText(text: string, options: SportTextOptions = {}): SportResolutionDecision {
  const normalized = normalizeStr(text);
  const evidence: SportEvidence[] = [];

  for (const [emoji, sport] of EMOJI_SIGNALS) {
    if (text.includes(emoji) && !hasUnsupportedVariant(sport, normalized)) {
      evidence.push({ source: "EMOJI", sport, confidence: 95, value: emoji });
    }
  }
  for (const [pattern, sport] of TEXT_SIGNALS) {
    const terms = allTerms(pattern, normalized);
    // O nome da modalidade, quando o texto o traz, vale mais que a estatística.
    const value = terms.find((term) => canonicalSport(term) === sport) ?? terms[0];
    if (!value || hasUnsupportedVariant(sport, normalized)) continue;
    evidence.push({ source: "TEXT", sport, confidence: 95, value });
  }
  const competitions = COMPETITION_SIGNALS.filter(([, sport]) => !hasUnsupportedVariant(sport, normalized));
  const otherSportInText = evidence.some((item) => item.sport !== "Soccer") ||
    competitions.some(([pattern, sport]) => sport !== "Soccer" && pattern.test(normalized));
  const namedSports = new Set(evidence.filter((item) => item.sport !== "Soccer" && namesSport(item)).map((item) => item.sport));
  for (const [pattern, sport] of competitions) {
    const value = sport === "Soccer"
      ? soccerCompetitionTerm({ pattern, normalized, otherSportInText, namedSports, itemSport: options.itemSport })
      : normalized.match(pattern)?.[0];
    if (value) evidence.push({ source: "COMPETITION", sport, confidence: 95, value });
  }

  const sports = [...new Set(evidence.map((item) => item.sport))];
  if (sports.length === 0) return unresolvedSportDecision();
  if (sports.length > 1) return unresolvedSportDecision("CONFLICT", evidence);
  const sport = sports[0];
  if (!sport) return unresolvedSportDecision();
  const best = [...evidence]
    .filter((item) => item.sport === sport)
    .sort((a, b) => b.confidence - a.confidence)[0];
  return confirmedSportDecision(
    sport,
    best?.source ?? "TEXT",
    best?.confidence ?? 95,
    evidence,
  );
}

/**
 * LLM isolada propõe candidato com teto 85 e status PENDING.
 * Quando traz evidência textual visível (cabeçalho/texto do bilhete ou legenda)
 * comprovada deterministicamente por detectSportFromText, a decisão é promovida
 * a CONFIRMED com confiança 95 (anti-alucinação).
 */
export function llmSportDecision(params: {
  sport: string | null | undefined;
  confidence?: number | null;
  evidenceText?: string | null;
}): SportResolutionDecision {
  const sport = canonicalSport(params.sport);
  if (!sport) return unresolvedSportDecision();

  const cleanEvidence = params.evidenceText?.trim();
  if (cleanEvidence) {
    // A mesma regra da captura: a liga compartilhada da evidência ("🏀 Serie A")
    // cede à modalidade que a IA leu no item.
    const verified = detectSportFromText(cleanEvidence, { itemSport: sport });
    if (
      verified.status === "CONFIRMED" &&
      verified.sport === sport &&
      verified.confidence >= SPORT_AUTO_CONFIRM_MIN_CONFIDENCE
    ) {
      return {
        sport,
        status: "CONFIRMED",
        confidence: verified.confidence,
        source: verified.source,
        evidence: [
          ...verified.evidence,
          {
            source: "LLM",
            sport,
            confidence: Math.min(85, Math.max(0, Math.round((params.confidence ?? 0.85) * 100))),
            value: cleanEvidence,
          },
        ],
        resolverVersion: SPORT_RESOLVER_VERSION,
      };
    }
    if (verified.status === "CONFIRMED" && verified.sport && verified.sport !== sport) {
      return unresolvedSportDecision("CONFLICT", [
        ...verified.evidence,
        {
          source: "LLM",
          sport,
          confidence: 85,
          value: cleanEvidence,
        },
      ]);
    }
  }

  const confidence = Math.min(
    85,
    Math.max(0, Math.round((params.confidence ?? 0.85) * 100)),
  );
  const evidence: SportEvidence[] = [
    {
      source: "LLM",
      sport,
      confidence,
      value: cleanEvidence || "classificação estruturada",
    },
  ];
  return {
    sport,
    status: "PENDING",
    confidence,
    source: "LLM",
    evidence,
    resolverVersion: SPORT_RESOLVER_VERSION,
  };
}
