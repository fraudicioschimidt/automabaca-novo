/**
 * Detecção do esporte pelo texto do post e decisão a partir da leitura da IA.
 * A regra mora em Rust (`rust/crates/dominio/src/sports/detect.rs`); aqui
 * ficam os tipos e os construtores das decisões que os serviços montam.
 */
import dominio from "@automabaca/dominio";
import type { CanonicalSport } from "./registry";

const [resolverVersion, autoConfirm, dissent, sharedSoccerLeague] = dominio.sportDetectionConstants();

export const UNKNOWN_SPORT = "Unknown";
/** O nome que o painel mostra para `UNKNOWN_SPORT`: a aposta espera o esporte ser confirmado. */
export const UNKNOWN_SPORT_LABEL = "A confirmar";
/**
 * Sobe a cada mudança de COMPORTAMENTO do resolvedor — é por ela que apostas
 * antigas podem ser reavaliadas.
 */
export const SPORT_RESOLVER_VERSION = resolverVersion;
/**
 * Confirmação sem revisão, na captura e no resolvedor: evidência de 90 ou
 * mais para um esporte e nenhum outro esporte a partir de
 * `SPORT_DISSENT_MIN_CONFIDENCE` (`chooseSportCandidate`).
 */
export const SPORT_AUTO_CONFIRM_MIN_CONFIDENCE = autoConfirm;
/** A partir daqui, a evidência de outro esporte segura a confirmação automática. */
export const SPORT_DISSENT_MIN_CONFIDENCE = dissent;

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

/** O esporte que a IA leu no item, mesmo quando o texto a desmentiu. */
export function llmReadSport(decision: Pick<SportResolutionDecision, "evidence"> | null | undefined): CanonicalSport | null {
  return decision?.evidence.find((item) => item.source === "LLM")?.sport ?? null;
}

/**
 * Nomes de liga de futebol que basquete, vôlei, handebol e dardos também usam
 * ("🏀 Serie A", "🤾 Champions League", "Basquete Bundesliga", "Premier
 * League" dos dardos): sozinhos, não provam o futebol.
 */
export const SHARED_SOCCER_LEAGUE = new RegExp(sharedSoccerLeague);

type SportDecisionColumns = ReturnType<typeof dominio.detectSportFromText>;

function decisionOf(columns: SportDecisionColumns): SportResolutionDecision {
  const [sport, status, confidence, source, sources, sports, confidences, values] = columns;
  return {
    sport: sport as CanonicalSport | null,
    status: status as SportResolutionStatus,
    confidence,
    source: source as SportResolutionSource,
    evidence: sources.map((itemSource, index) => ({
      source: itemSource as SportResolutionSource,
      sport: sports[index] as CanonicalSport,
      confidence: confidences[index] ?? 0,
      value: values[index] ?? "",
    })),
    resolverVersion: SPORT_RESOLVER_VERSION,
  };
}

type SportTextOptions = {
  /** O esporte em que a leitura do próprio item (a IA) pôs a aposta (`llmReadSport`). */
  itemSport?: CanonicalSport | null;
};

/**
 * Os sinais do texto: emoji, nome ou estatística da modalidade e competição. A
 * liga compartilhada ("Serie A") cede à modalidade que a leitura do item deu.
 */
export function detectSportFromText(text: string, options: SportTextOptions = {}): SportResolutionDecision {
  return decisionOf(dominio.detectSportFromText(text, options.itemSport));
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
  return decisionOf(dominio.llmSportDecision(params.sport, params.confidence, params.evidenceText));
}
